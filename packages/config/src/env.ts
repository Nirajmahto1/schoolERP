// ──────────────────────────────────────────────
// Environment loading & validation primitives
//
// Rule: a missing or malformed required variable CRASHES THE PROCESS at boot.
// There are no runtime fallbacks for secrets. A service that cannot prove it
// was configured correctly must not accept traffic.
// ──────────────────────────────────────────────

import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { z } from 'zod';

/** Values that are never acceptable as a production secret. */
const FORBIDDEN_SECRET_VALUES = new Set([
  'secret',
  'fallback-secret',
  'refresh-secret',
  'changeme',
  'change-me',
  'password',
  'your-super-secret-jwt-key-change-in-production',
  'your-refresh-secret-key',
  'your-nextauth-secret',
  'test',
  'dev',
  'development',
]);

let dotenvLoaded = false;

/**
 * Load the monorepo-root `.env` exactly once per process.
 *
 * Services previously each called `dotenv.config({ path: '../../.env' })`, which
 * resolves against `process.cwd()` and therefore broke depending on where the
 * process was started. We walk up from this file to find the workspace root
 * instead, so it works from any cwd.
 *
 * Real environments (Docker, ECS, Kubernetes) inject variables directly; a
 * missing .env file is not an error.
 */
export function loadDotenv(): void {
  if (dotenvLoaded) return;
  dotenvLoaded = true;

  // In production, environment variables come from the orchestrator or secret
  // manager. Reading a .env file there is a misconfiguration smell, so skip it.
  if (process.env.NODE_ENV === 'production') return;

  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, '.env');
    if (fs.existsSync(candidate)) {
      dotenv.config({ path: candidate });
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

/**
 * A secret string: minimum length, and explicitly not one of the placeholder
 * values that shipped in `.env.example`. This is the schema-level enforcement
 * of "no hardcoded fallback secrets".
 */
export const secretString = (minLength = 32) =>
  z
    .string({ required_error: 'is required (no default is provided for secrets)' })
    .min(
      minLength,
      `must be at least ${minLength} characters. Generate one with: openssl rand -base64 48`,
    )
    .refine((v) => !FORBIDDEN_SECRET_VALUES.has(v.trim().toLowerCase()), {
      message:
        'is set to a well-known placeholder value. Generate a real secret with: openssl rand -base64 48',
    });

/** A TCP port, accepting the string form that environments always provide. */
export const port = (fallback: number) =>
  z.coerce.number().int().min(1).max(65535).default(fallback);

/** A required URL-ish connection string. */
export const connectionString = (protocols: string[]) =>
  z.string().refine((v) => protocols.some((p) => v.startsWith(`${p}://`)), {
    message: `must be a connection string starting with one of: ${protocols
      .map((p) => `${p}://`)
      .join(', ')}`,
  });

/** Comma-separated list -> trimmed string array. */
export const csvList = z
  .string()
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.string()).min(1));

/** Human-readable duration accepted by `jsonwebtoken` (e.g. `15m`, `7d`). */
export const jwtDuration = z
  .string()
  .regex(
    /^\d+\s*(ms|s|m|h|d|w|y)$/i,
    'must be a duration like "15m", "24h", or "30d"',
  );

export const nodeEnv = z
  .enum(['development', 'test', 'staging', 'production'])
  .default('development');

/**
 * Parse `process.env` against a schema, or exit the process with a readable
 * report of every problem at once.
 *
 * We deliberately `process.exit(1)` rather than throw: a service booting with
 * bad config has no valid degraded mode, and a thrown error can be swallowed by
 * a framework's error handler and leave the process listening.
 */
export function parseEnv<T extends z.ZodTypeAny>(
  schema: T,
  serviceName: string,
  source: NodeJS.ProcessEnv = process.env,
): z.infer<T> {
  loadDotenv();

  const result = schema.safeParse(source);
  if (result.success) return result.data;

  const issues = result.error.issues
    .map((issue) => {
      const key = issue.path.join('.') || '(root)';
      return `  • ${key} ${issue.message}`;
    })
    .sort();

  // Written to stderr rather than a logger: the logger itself may depend on
  // config that just failed to parse.
  process.stderr.write(
    [
      '',
      '━'.repeat(72),
      `✗ ${serviceName} cannot start — invalid environment configuration`,
      '━'.repeat(72),
      ...issues,
      '',
      `Fix the variables above in your .env file, then restart.`,
      `See .env.example for the full list. Never reuse the placeholder values.`,
      '━'.repeat(72),
      '',
    ].join('\n'),
  );
  process.exit(1);
}
