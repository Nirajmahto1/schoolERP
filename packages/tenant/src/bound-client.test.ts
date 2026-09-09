// ──────────────────────────────────────────────
// Tenant-bound PrismaClient proxy tests (GATE 1: "A Prisma call with no tenant
// context throws")
// ──────────────────────────────────────────────

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadDotenv } from '@school-erp/config';
import { PrismaClient as ControlPlaneClient } from '@school-erp/control-plane';
import { TestDatabase } from '@school-erp/testing';
import {
  NoTenantContextError,
  TenantRegistry,
  createTenantBoundPrisma,
  runWithTenant,
} from './index';

loadDotenv();

describe('createTenantBoundPrisma', () => {
  let controlDb: TestDatabase;
  let dbA: TestDatabase;
  let dbB: TestDatabase;
  let controlPlane: ControlPlaneClient;
  let registry: TenantRegistry;
  let prisma: ReturnType<typeof createTenantBoundPrisma>;

  beforeAll(async () => {
    const base = process.env.DATABASE_URL as string;
    controlDb = await TestDatabase.create(base, { project: 'control-plane' });
    dbA = await TestDatabase.create(base);
    dbB = await TestDatabase.create(base);
    controlPlane = new ControlPlaneClient({ datasourceUrl: controlDb.url });
    registry = new TenantRegistry({ controlPlane });
    prisma = createTenantBoundPrisma(registry);

    const a = dbA.client();
    await a.school.create({
      data: { name: 'School A', code: 'A', address: 'x', city: 'x', state: 'x', pincode: '1', phone: '0', email: 'a@t.test' },
    });
    await a.$disconnect();
    const b = dbB.client();
    await b.school.create({
      data: { name: 'School B', code: 'B', address: 'x', city: 'x', state: 'x', pincode: '1', phone: '0', email: 'b@t.test' },
    });
    await b.$disconnect();

    const tA = await controlPlane.tenant.create({ data: { slug: 'bound-a', legalName: 'A', status: 'ACTIVE' } });
    await controlPlane.tenantDatastore.create({ data: { tenantId: tA.id, connRef: dbA.url, schemaVersion: 1 } });
    const tB = await controlPlane.tenant.create({ data: { slug: 'bound-b', legalName: 'B', status: 'ACTIVE' } });
    await controlPlane.tenantDatastore.create({ data: { tenantId: tB.id, connRef: dbB.url, schemaVersion: 1 } });
  });

  afterAll(async () => {
    await registry.close();
    await controlPlane.$disconnect();
    await dbA.teardown();
    await dbB.teardown();
    await controlDb.teardown();
  });

  it('throws when no tenant context is bound (GATE 1)', async () => {
    await expect(prisma.school.findMany()).rejects.toThrow(NoTenantContextError);
  });

  it('routes queries to the tenant bound in context', async () => {
    const tenantA = await controlPlane.tenant.findUnique({ where: { slug: 'bound-a' } });
    await runWithTenant(tenantA!.id, async () => {
      const schools = await prisma.school.findMany();
      expect(schools).toHaveLength(1);
      expect(schools[0].name).toBe('School A');
    });
  });

  it('routes different contexts to different databases', async () => {
    const [tA, tB] = await Promise.all([
      controlPlane.tenant.findUnique({ where: { slug: 'bound-a' } }),
      controlPlane.tenant.findUnique({ where: { slug: 'bound-b' } }),
    ]);
    await runWithTenant(tA!.id, async () => {
      expect((await prisma.school.findFirst())?.name).toBe('School A');
    });
    await runWithTenant(tB!.id, async () => {
      expect((await prisma.school.findFirst())?.name).toBe('School B');
    });
  });

  it('routes raw queries ($queryRaw) through the tenant client', async () => {
    const tB = await controlPlane.tenant.findUnique({ where: { slug: 'bound-b' } });
    await runWithTenant(tB!.id, async () => {
      const rows = await prisma.$queryRaw`SELECT name FROM "schools" LIMIT 1`;
      expect((rows as Array<{ name: string }>)[0].name).toBe('School B');
    });
  });

  it('supports interactive transactions against the tenant database', async () => {
    const tA = await controlPlane.tenant.findUnique({ where: { slug: 'bound-a' } });
    await runWithTenant(tA!.id, async () => {
      await prisma.$transaction(async (tx) => {
        const rows = await (tx as unknown as { school: { findMany(): Promise<Array<{ name: string }>> } }).school.findMany();
        expect(rows[0].name).toBe('School A');
      });
    });
  });
});
