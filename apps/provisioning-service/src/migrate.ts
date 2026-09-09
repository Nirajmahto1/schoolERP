// ──────────────────────────────────────────────
// Migration orchestrator (BUILD_PLAN 1.4)
//
// DB-per-tenant means a schema change is a fleet operation, not one migration.
//   • runTenantMigration  — migrate ONE tenant database (used by provisioning)
//   • migrateAll          — fan out with bounded concurrency, record every
//                           attempt in migration_run, stop-on-first-failure
//                           with a resume-from-failure mode
//   • tenantFleetStatus   — tenant → schemaVersion → drift at a glance
//   • dryRun              — report what WOULD run without touching anything
// ──────────────────────────────────────────────

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PrismaClient as ControlPlaneClient } from '@school-erp/control-plane';
import { audit } from './audit';

const DATABASE_PACKAGE_DIR = path.resolve(__dirname, '..', '..', '..', 'packages', 'database');

/** The count of committed migrations in packages/database — the fleet target. */
export function latestSchemaVersion(): number {
  const dir = path.join(DATABASE_PACKAGE_DIR, 'prisma', 'migrations');
  const entries = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((d) => /^\d+_/.test(d))
    : [];
  return entries.length;
}

/** Apply every committed migration to one tenant database. Throws on failure. */
export function runTenantMigration(connRef: string): Promise<void> {
  const cli = require.resolve('prisma/build/index.js', { paths: [DATABASE_PACKAGE_DIR] });
  try {
    execFileSync(process.execPath, [cli, 'migrate', 'deploy'], {
      cwd: DATABASE_PACKAGE_DIR,
      env: { ...process.env, DATABASE_URL: connRef },
      stdio: 'pipe',
    });
    return Promise.resolve();
  } catch (err) {
    const stderr = (err as Error & { stderr?: Buffer }).stderr?.toString() ?? (err as Error).message;
    return Promise.reject(new Error(`prisma migrate deploy failed: ${stderr}`));
  }
}

export interface MigrateAllOptions {
  controlPlane: ControlPlaneClient;
  /** Bounded fan-out (BUILD_PLAN 1.4.1). */
  concurrency?: number;
  /** Report what would run without executing. */
  dryRun?: boolean;
  /** Fleet target; defaults to the migration count on disk. */
  targetVersion?: number;
  /** Resume-from-failure: only these tenant ids. */
  onlyTenantIds?: string[];
  actor?: string;
}

export interface MigrationFailure {
  tenantId: string;
  slug: string;
  error: string;
}

export interface MigrateAllResult {
  targetVersion: number;
  attempted: number;
  succeeded: number;
  failed: number;
  skipped: number;
  failures: MigrationFailure[];
}

interface TenantToMigrate {
  id: string;
  slug: string;
  connRef: string;
  schemaVersion: number;
}
export async function migrateAll(opts: MigrateAllOptions): Promise<MigrateAllResult> {
  const target = opts.targetVersion ?? latestSchemaVersion();
  const concurrency = Math.max(1, opts.concurrency ?? 5);
  const actor = opts.actor ?? 'cli';
  const { controlPlane } = opts;

  const tenants = await controlPlane.tenant.findMany({
    where: opts.onlyTenantIds ? { id: { in: opts.onlyTenantIds } } : undefined,
    include: { datastore: true },
  });

  const queue: TenantToMigrate[] = tenants
    .filter((t) => t.datastore)
    .map((t) => ({
      id: t.id,
      slug: t.slug,
      connRef: t.datastore!.connRef,
      schemaVersion: t.datastore!.schemaVersion,
    }));

  const result: MigrateAllResult = {
    targetVersion: target,
    attempted: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    failures: [],
  };

  if (opts.dryRun) {
    for (const t of queue) {
      if (t.schemaVersion === target) {
        result.skipped += 1;
      } else {
        result.attempted += 1;
        console.log(`[dry-run] ${t.slug}: ${t.schemaVersion} → ${target}`);
      }
    }
    return result;
  }

  const next = [...queue];
  const workers = Array.from({ length: concurrency }, async () => {
    while (next.length > 0) {
      const t = next.shift() as TenantToMigrate;
      result.attempted += 1;

      if (t.schemaVersion === target) {
        result.skipped += 1;
        continue;
      }

      const run = await controlPlane.migrationRun.create({
        data: {
          tenantId: t.id,
          fromVersion: String(t.schemaVersion),
          toVersion: String(target),
          status: 'RUNNING',
          startedAt: new Date(),
        },
      });

      try {
        await runTenantMigration(t.connRef);
        await controlPlane.migrationRun.update({
          where: { id: run.id },
          data: { status: 'SUCCEEDED', finishedAt: new Date() },
        });
        await controlPlane.tenantDatastore.update({
          where: { tenantId: t.id },
          data: { schemaVersion: target, lastMigratedAt: new Date() },
        });
        await audit(controlPlane, actor, 'tenant.migrate.complete', t.id, {
          fromVersion: t.schemaVersion,
          toVersion: target,
        });
        result.succeeded += 1;
      } catch (err) {
        await controlPlane.migrationRun.update({
          where: { id: run.id },
          data: { status: 'FAILED', finishedAt: new Date(), error: (err as Error).message },
        });
        result.failed += 1;
        result.failures.push({ tenantId: t.id, slug: t.slug, error: (err as Error).message });
        // Stop-on-first-failure: drain the queue by marking the rest skipped.
        while (next.length > 0) {
          next.shift();
          result.skipped += 1;
        }
        return;
      }
    }
  });

  await Promise.all(workers);
  return result;
}

export interface FleetRow {
  tenantId: string;
  slug: string;
  status: string;
  schemaVersion: number;
  targetVersion: number;
  drift: 'ahead' | 'behind' | 'current' | 'no-datastore';
}

/** The fleet at a glance: tenant → schema version → drift (BUILD_PLAN 1.4.4). */
export async function tenantFleetStatus(
  controlPlane: ControlPlaneClient,
  targetVersion = latestSchemaVersion(),
): Promise<FleetRow[]> {
  const tenants = await controlPlane.tenant.findMany({ include: { datastore: true } });
  return tenants.map((t) => {
    if (!t.datastore) {
      return {
        tenantId: t.id,
        slug: t.slug,
        status: t.status,
        schemaVersion: 0,
        targetVersion,
        drift: 'no-datastore',
      };
    }
    const v = t.datastore.schemaVersion;
    return {
      tenantId: t.id,
      slug: t.slug,
      status: t.status,
      schemaVersion: v,
      targetVersion,
      drift: v > targetVersion ? 'ahead' : v < targetVersion ? 'behind' : 'current',
    };
  });
}