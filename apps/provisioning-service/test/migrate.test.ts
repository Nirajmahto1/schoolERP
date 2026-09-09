// ──────────────────────────────────────────────
// Migration orchestrator tests (BUILD_PLAN 1.4)
// ──────────────────────────────────────────────

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadDotenv } from '@school-erp/config';
import { PrismaClient as ControlPlaneClient } from '@school-erp/control-plane';
import { TestDatabase } from '@school-erp/testing';
import { latestSchemaVersion, migrateAll, tenantFleetStatus } from '../src/migrate';

loadDotenv();

describe('migration orchestrator', () => {
  let controlDb: TestDatabase;
  let controlPlane: ControlPlaneClient;
  const tenantDbs = new Map<string, TestDatabase>();

  beforeAll(async () => {
    controlDb = await TestDatabase.create(process.env.DATABASE_URL, { project: 'control-plane' });
    controlPlane = new ControlPlaneClient({ datasourceUrl: controlDb.url });

    // Two tenants whose datastores are at schemaVersion 0 (simulated drift).
    for (const slug of ['alpha', 'beta']) {
      const td = await TestDatabase.create(process.env.DATABASE_URL);
      tenantDbs.set(slug, td);
      const tenant = await controlPlane.tenant.create({
        data: { slug, legalName: slug, status: 'ACTIVE' },
      });
      await controlPlane.tenantDatastore.create({
        data: { tenantId: tenant.id, connRef: td.url, schemaVersion: 0 },
      });
    }
  });

  afterAll(async () => {
    for (const td of tenantDbs.values()) await td.teardown();
    tenantDbs.clear();
    await controlDb.teardown();
    await controlPlane.$disconnect();
  });

  it('reports fleet drift with dry-run and touches nothing', async () => {
    const target = latestSchemaVersion();
    expect(target).toBeGreaterThanOrEqual(1);

    const before = await tenantFleetStatus(controlPlane, target);
    expect(before.every((r) => r.drift === 'behind')).toBe(true);

    const dry = await migrateAll({ controlPlane, dryRun: true });
    expect(dry.attempted).toBe(2);
    expect(dry.failed).toBe(0);

    // Nothing changed.
    const after = await tenantFleetStatus(controlPlane, target);
    expect(after.every((r) => r.drift === 'behind')).toBe(true);
  });

  it('migrates the fleet with bounded concurrency and records migration_run', async () => {
    const target = latestSchemaVersion();
    const result = await migrateAll({ controlPlane, concurrency: 2 });
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(0);

    const runs = await controlPlane.migrationRun.findMany();
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.status === 'SUCCEEDED')).toBe(true);

    const rows = await tenantFleetStatus(controlPlane, target);
    expect(rows.every((r) => r.drift === 'current')).toBe(true);
  });

  it('stops on first failure and marks the rest skipped', async () => {
    const td = await TestDatabase.create(process.env.DATABASE_URL);
    tenantDbs.set('gamma', td);
    const tenant = await controlPlane.tenant.create({
      data: { slug: 'gamma', legalName: 'gamma', status: 'ACTIVE' },
    });
    await controlPlane.tenantDatastore.create({
      data: { tenantId: tenant.id, connRef: 'postgresql://invalid:invalid@localhost:1/nowhere?schema=public', schemaVersion: 0 },
    });

    const result = await migrateAll({ controlPlane, concurrency: 1, onlyTenantIds: [tenant.id] });
    expect(result.failed).toBe(1);
    expect(result.succeeded).toBe(0);
    expect(result.failures[0].slug).toBe('gamma');

    const run = await controlPlane.migrationRun.findFirst({ where: { tenantId: tenant.id } });
    expect(run?.status).toBe('FAILED');
    expect(run?.error).toBeTruthy();
  });
});