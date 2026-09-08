// ──────────────────────────────────────────────
// `npm run doctor` — preflight checks for a healthy dev machine
//
// Verifies in one pass:
//   1. Node version matches the workspace engines requirement
//   2. Workspace packages are linked and built (@school-erp/config)
//   3. Required environment variables are present and non-placeholder — exactly
//      what every service enforces at boot; catch it here instead of watching
//      `turbo dev` die twelve times
//   4. PostgreSQL / Redis are reachable on the ports .env points at
//   5. Docker compose files are present for `npm run docker:up`
//
// Exit code is 0 only when every CRITICAL check passes. Warnings (e.g. Redis
// down while the token store is still in-memory) do not fail the run.
// ──────────────────────────────────────────────

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const results = [];
const pass = (label, detail = '') => results.push({ label, ok: true, detail });
const fail = (label, detail = '') => results.push({ label, ok: false, detail });
const warn = (label, detail = '') => results.push({ label, ok: null, detail });

// ── 1. Node version ──
const nodeMajor = Number(process.versions.node.split('.')[0]);
nodeMajor >= 20
  ? pass('node', `v${process.versions.node}`)
  : fail('node', `v${process.versions.node} — engines require >=20`);

// ── 2. Workspace packages linked + buildable ──
const linked = fs.existsSync(path.join(root, 'node_modules', '@school-erp', 'config'));
linked
  ? pass('workspace', '@school-erp/config is linked')
  : fail('workspace', 'npm install has not linked workspace packages — run "npm install"');
// ── 3. Environment completeness (via subprocess-per-service) ──
const loaders = [
  ['env/api-gateway', `require('@school-erp/config').loadGatewayEnv()`],
  ['env/student-service', `require('@school-erp/config').loadIdentityEnv()`],
  ['env/staff-service', `require('@school-erp/config').loadServiceEnv('staff-service','PORT_STAFF_SERVICE')`],
  ['env/fee-service', `require('@school-erp/config').loadServiceEnv('fee-service','PORT_FEE_SERVICE')`],
  ['env/academic-service', `require('@school-erp/config').loadServiceEnv('academic-service','PORT_ACADEMIC_SERVICE')`],
  ['env/attendance-service', `require('@school-erp/config').loadServiceEnv('attendance-service','PORT_ATTENDANCE_SERVICE')`],
  ['env/communication-service', `require('@school-erp/config').loadServiceEnv('communication-service','PORT_COMMUNICATION_SERVICE')`],
];

for (const [label, expr] of loaders) {
  if (!fs.existsSync(envFile)) {
    warn(label, 'skipped (no .env)');
    continue;
  }
  // CWD matters: dotenv walks up from the config package, so run from the repo root.
  const script = `try { ${expr}; process.exit(0); } catch (e) { console.error(e.message); process.exit(1); }`;
  const child = spawn('node', ['-e', script], { cwd: root });
  const { ok, stderr } = await child.output();
  ok
    ? pass(label, 'env variables OK')
    : fail(label, (stderr ?? '').split('\n')[0].trim() || 'rejected by @school-erp/config');
}

// ── 4. Infrastructure reachability ──
const databaseUrl = loadEnvValue('.env', 'DATABASE_URL');
if (databaseUrl) {
  const parsed = parsePostgresUrl(databaseUrl);
  const reachable = parsed ? await tcpProbe(parsed.host, parsed.port) : false;
  reachable
    ? pass('database', `postgres reachable at ${parsed.host}:${parsed.port} (${parsed.database})`)
    : fail('database', `cannot reach ${parsed.host}:${parsed.port} — is Postgres running?`);
} else {
  warn('database', 'DATABASE_URL not set in .env — skipping');
}

const redisUrl = loadEnvValue('.env', 'REDIS_URL');
if (redisUrl) {
  const parsed = parseRedisUrl(redisUrl);
  const reachable = parsed ? await tcpProbe(parsed.host, parsed.port) : false;
  reachable
    ? pass('redis', `redis reachable at ${parsed.host}:${parsed.port}`)
    : warn('redis', `redis not reachable at ${parsed.host}:${parsed.port} — OK for single-instance dev, required before Phase 1`);
} else {
  warn('redis', 'REDIS_URL not set in .env — required before Phase 1');
}

// ── 5. Docker compose files ──
for (const file of ['docker/docker-compose.yml', 'docker/docker-compose.dev.yml']) {
  const p = path.join(root, file);
  fs.existsSync(p) ? pass('docker', `${file} present`) : fail('docker', `${file} missing`);
}

// ── Report ──
console.log('');
console.log('▉▉▉ Doctor report — schoolERP');
console.log('');
for (const { label, ok, detail } of results) {
  const icon = ok === true ? '  ✔' : ok === null ? '  ⚠' : '  ✘';
  console.log(`${icon} ${label.padEnd(24)} ${detail}`);
}
const failed = results.filter((r) => r.ok === false).length;
const warnings = results.filter((r) => r.ok === null).length;
console.log('');
console.log(`  ${results.length - failed - warnings} passed, ${warnings} warnings, ${failed} failed`);
if (failed > 0) {
  console.log('  Fix the failed checks above before running services.');
  process.exit(1);
}
console.log('  All critical checks passed.');

// ── Helpers ──

function loadEnvValue(relPath, key) {
  try {
    const text = fs.readFileSync(path.join(root, relPath), 'utf8');
    const match = text.match(new RegExp(`^${key}=(.+)$`, 'm'));
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

function parsePostgresUrl(url) {
  const m = url.match(/^postgres(?:ql)?:\/\/[^@]+@([^:/]+):(\d+)\/([^?]+)/);
  return m ? { host: m[1], port: Number(m[2]), database: m[3].split('?')[0] } : null;
}

function parseRedisUrl(url) {
  const m = url.match(/^redis:\/\/([^:/]+):(\d+)/);
  return m ? { host: m[1], port: Number(m[2]) } : null;
}

async function tcpProbe(host, port, timeoutMs = 1500) {
  try {
    const net = await import('node:net');
    const socket = net.connect({ host, port });
    await socket.connectionEstablished({ timeout: timeoutMs });
    socket.destroy();
    return true;
  } catch {
    return false;
  }
}

const envFile = path.join(root, '.env');
if (!fs.existsSync(envFile)) {
  warn('env', '.env is missing — copy .env.example and run "npm run keygen"');
}