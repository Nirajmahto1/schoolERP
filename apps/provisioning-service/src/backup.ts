// ──────────────────────────────────────────────
// Per-tenant backup + restore drill (BUILD_PLAN 1.5.5)
//
// "Per-tenant backup + point-in-time restore, and a rehearsed single-tenant
// restore. Restoring one school without touching the other 99 is the drill
// that matters; run it quarterly and record the time."
//
// Implementation: `pg_dump --format=custom` of ONE tenant database, restored
// with `pg_restore` into a scratch database, then verified by counting the
// tables of a known table before/after. Both binaries are resolved from PATH
// (documented in the README); the drill records its duration so the number can
// go straight into the ops log.
// ──────────────────────────────────────────────

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { PrismaClient } from '@school-erp/database';

export interface BackupResult {
  /** Absolute path of the pg_dump custom-format archive. */
  file: string;
  bytes: number;
  database: string;
  dumpedAt: string;
}

export interface RestoreDrillResult {
  backupFile: string;
  scratchDatabase: string;
  /** Wall-clock duration of pg_restore + verification, in milliseconds. */
  durationMs: number;
  tablesRestored: number;
  rowsVerified: { table: string; rows: number };
  restoredAt: string;
}

function urlTo(dbUrl: string, dbName: string): string {
  return dbUrl.replace(/\/([^/?]+)(\?|$)/, `/${dbName}$2`);
}

function databaseOf(dbUrl: string): string {
  const match = dbUrl.match(/\/([^/?]+)(\?|$)/);
  if (!match) throw new Error(`Cannot read a database name out of the connection string.`);
  return match[1];
}

/**
 * Strip Prisma-only query parameters (`schema=`) — pg_dump/pg_restore speak
 * libpq, which rejects unknown URI parameters.
 */
export function toLibpqUrl(dbUrl: string): string {
  const [base, query] = dbUrl.split('?');
  if (!query) return base;
  const kept = query
    .split('&')
    .filter((p) => p && !p.startsWith('schema='))
    .join('&');
  return kept ? `${base}?${kept}` : base;
}

function run(binary: string, args: string[], env: NodeJS.ProcessEnv): void {
  execFileSync(binary, args, { env: { ...process.env, ...env }, stdio: 'pipe' });
}

/** Dump ONE tenant database to a custom-format archive. */
export async function backupTenant(tenantConnRef: string, outDir?: string): Promise<BackupResult> {
  const dir = outDir ?? mkdtempSync(path.join(tmpdir(), 'erp-backup-'));
  const file = path.join(dir, `${databaseOf(tenantConnRef)}.dump`);

  run('pg_dump', [
    '--format=custom',
    '--no-owner',
    '--no-privileges',
    '--file', file,
    toLibpqUrl(tenantConnRef),
  ], {});

  if (!existsSync(file)) throw new Error('pg_dump produced no output file.');

  return {
    file,
    bytes: statSync(file).size,
    database: databaseOf(tenantConnRef),
    dumpedAt: new Date().toISOString(),
  };
}

/**
 * The restore drill: restore a backup into a scratch database on the same
 * cluster, verify content came back, drop the scratch. The original tenant is
 * never touched — that is the point of the drill.
 */
export async function rehearseRestore(
  adminUrl: string,
  backupFile: string,
  opts: { probeTable?: string; probeCount?: number; keepScratch?: boolean } = {},
): Promise<RestoreDrillResult> {
  const startedAt = Date.now();
  const scratch = `restore_drill_${Date.now().toString(36)}`;
  const scratchUrl = urlTo(adminUrl, scratch);

  const admin = new PrismaClient({ datasourceUrl: adminUrl });
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${scratch}"`);
  } finally {
    await admin.$disconnect();
  }

  try {
    run('pg_restore', [
      '--no-owner',
      '--no-privileges',
      '--dbname', toLibpqUrl(scratchUrl),
      backupFile,
    ], {});

    const probeTable = opts.probeTable ?? 'schools';
    const onScratch = new PrismaClient({ datasourceUrl: scratchUrl });
    let tablesRestored = 0;
    let rows = 0;
    try {
      const tables = await onScratch.$queryRaw<Array<{ count: bigint }>>`
        SELECT count(*)::bigint AS count FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`;
      tablesRestored = Number(tables[0]?.count ?? 0);

      const probe = opts.probeCount
        ? await onScratch.$queryRawUnsafe<Array<Record<string, unknown>>>(
            `SELECT count(*)::bigint AS rows FROM "${probeTable}"`,
          )
        : [];
      rows = Number((probe[0] as { rows?: bigint } | undefined)?.rows ?? 0);
    } finally {
      await onScratch.$disconnect();
    }

    if (tablesRestored === 0) {
      throw new Error('Restore drill verification failed: scratch database has no tables.');
    }

    return {
      backupFile,
      scratchDatabase: scratch,
      durationMs: Date.now() - startedAt,
      tablesRestored,
      rowsVerified: { table: probeTable, rows },
      restoredAt: new Date().toISOString(),
    };
  } finally {
    if (!opts.keepScratch) {
      const cleanup = new PrismaClient({ datasourceUrl: adminUrl });
      try {
        await cleanup.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`);
      } catch {
        // Cleanup failure must not mask the drill result.
      } finally {
        await cleanup.$disconnect();
      }
    }
  }
}
