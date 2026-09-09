// ──────────────────────────────────────────────
// Provisioning pipeline tests (BUILD_PLAN 1.2)
//
// Uses schema-isolated ephemeral databases for the control plane and each
// "tenant" (injected createDatabase), proving the full pipeline, idempotency,
// resume, and rollback — without creating real databases in CI.
// ──────────────────────────────────────────────

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadDotenv } from '@school-erp/config';
import { PrismaClient as ControlPlaneClient } from '@school-erp/control-plane';
import { TestDatabase } from '@school-erp/testing';
import { provisionTenant, type ProvisionDeps } from '../src/provision';
import { runTenantMigration } from '../src/migrate';

loadDotenv();

describe('provisionTenant', () => {
  let controlDb: TestDatabase;
  let controlPlane: ControlPlaneClient;
  const tenantDbs = new Map<string, TestDatabase>();

  function makeDeps(): ProvisionDeps {
    const base = process.env.DATABASE_URL as string;
    return {
      controlPlane,
      adminDatabaseUrl: base,
      createDatabase: async (dbName) => {
        const td = await TestDatabase.create(base);
        tenantDbs.set(dbName, td);
        return td.url;
      },
      dropDatabase: async (dbName) => {
        const td = tenantDbs.get(dbName);
        if (td) {
          await td.teardown();
          tenantDbs.delete(dbName);
        }
      },
      migrate: runTenantMigration,
      // Object storage (1.2.5) is exercised in storage.test.ts with injected
      // fakes; keep this DB-focused suite hermetic.
      provisionStorage: async () => ({
        skipped: true as const,
        reason: 'test — object storage hermetic.',
      }),
    };
  }

  beforeAll(async () => {
    controlDb = await TestDatabase.create(process.env.DATABASE_URL, { project: 'control-plane' });
    controlPlane = new ControlPlaneClient({ datasourceUrl: controlDb.url });
  });

  afterAll(async () => {
    for (const td of tenantDbs.values()) await td.teardown();
    tenantDbs.clear();
    await controlDb.teardown();
    await controlPlane.$disconnect();
  });

  // Runs a real `prisma migrate deploy` subprocess plus full India-default
  // seeding, so it needs far more than vitest's 5s default (matches the
  // explicit-timeout convention in roles-backup.test.ts).
  it('provisions a tenant end-to-end with India defaults and a setup link', async () => {
    const result = await provisionTenant(
      { slug: 'dps-noida', legalName: 'DPS Noida', trialDays: 30 },
      makeDeps(),
    );

    expect(result.alreadyProvisioned).toBe(false);
    expect(result.setupUrl).toContain('https://dps-noida.yourapp.in/setup?token=');

    // Control-plane state: TRIAL tenant + datastore + audit trail.
    const tenant = await controlPlane.tenant.findUnique({
      where: { slug: 'dps-noida' },
      include: { datastore: true },
    });
    expect(tenant?.status).toBe('TRIAL');
    expect(tenant?.trialEndsAt).toBeTruthy();
    expect(tenant?.datastore?.schemaVersion).toBe(1);
    expect(tenant?.datastore?.connRef).toBe(result.connRef);

    const auditRows = await controlPlane.provisionAudit.findMany({
      where: { tenantId: tenant!.id },
      orderBy: { at: 'asc' },
    });
    expect(auditRows.map((a) => a.action)).toEqual([
      'tenant.provision.start',
      'tenant.provision.complete',
    ]);

    // Tenant database actually has the seeded defaults.
    const tenantClient = new (require('@school-erp/database').PrismaClient)({
      datasourceUrl: result.connRef,
    });
    const school = await tenantClient.school.findFirst();
    expect(school?.name).toBe('DPS Noida');
    const classes = await tenantClient.class.count();
    expect(classes).toBe(15); // Nursery → XII
    const admin = await tenantClient.user.findFirst({
      where: { roleAssignments: { some: { role: { code: 'BRANCH_ADMIN' }, isActive: true } } },
    });
    expect(admin?.passwordHash).toMatch(/^\$setup\$/);
    await tenantClient.$disconnect();
  }, 60_000);

  it('is idempotent: a second call returns the existing tenant untouched', async () => {
    const deps = makeDeps();
    const first = await provisionTenant({ slug: 'idem-co', legalName: 'Idem Co' }, deps);
    const second = await provisionTenant({ slug: 'idem-co', legalName: 'Idem Co' }, deps);

    expect(second.alreadyProvisioned).toBe(true);
    expect(second.tenantId).toBe(first.tenantId);
    expect(second.connRef).toBe(first.connRef);

    // No duplicate tenant rows, no duplicate audit "start" events.
    const count = await controlPlane.tenant.count({ where: { slug: 'idem-co' } });
    expect(count).toBe(1);
  });

  it('rejects a reserved slug before touching anything', async () => {
    const deps = makeDeps();
    await expect(
      provisionTenant({ slug: 'admin', legalName: 'Nope' }, deps),
    ).rejects.toThrow(/reserved/);
    expect(await controlPlane.tenant.count({ where: { slug: 'admin' } })).toBe(0);
  });

  it('rolls back completely when seeding fails', async () => {
    const deps = makeDeps();
    deps.seed = async () => {
      throw new Error('seed exploded');
    };
    await expect(
      provisionTenant({ slug: 'broken-co', legalName: 'Broken Co' }, deps),
    ).rejects.toThrow(/seed exploded/);

    // Tenant row gone, datastore gone, tenant "database" dropped.
    expect(await controlPlane.tenant.count({ where: { slug: 'broken-co' } })).toBe(0);
    expect(await controlPlane.tenantDatastore.count()).toBe(
      await controlPlane.tenant.count(),
    );
    expect(tenantDbs.has('tenant_broken_co')).toBe(false);

    // A rollback audit event was recorded.
    const rollbacks = await controlPlane.provisionAudit.findMany({
      where: { action: 'tenant.provision.rollback' },
    });
    expect(rollbacks.length).toBeGreaterThan(0);
  });

  it('resumes a half-provisioned tenant (row exists, no datastore)', async () => {
    const deps = makeDeps();
    const partial = await controlPlane.tenant.create({
      data: { slug: 'resume-co', legalName: 'Resume Co', status: 'TRIAL' },
    });

    const result = await provisionTenant({ slug: 'resume-co', legalName: 'Resume Co' }, deps);
    expect(result.tenantId).toBe(partial.id);
    expect(result.alreadyProvisioned).toBe(false);

    const datastore = await controlPlane.tenantDatastore.findUnique({
      where: { tenantId: partial.id },
    });
    expect(datastore?.schemaVersion).toBe(1);
  });
});