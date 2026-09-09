// ──────────────────────────────────────────────
// @school-erp/tenant tests (BUILD_PLAN 1.3)
//
// Uses schema-isolated ephemeral databases for BOTH the control plane and a
// tenant school DB, seeds a registry, and proves: resolution + caching,
// routing to the right per-tenant database, the "no tenant context throws"
// guard, blocked statuses, and ADR-2 LRU eviction.
//
// Note: TenantRegistry methods take tenant IDs, not slugs — slug → tenant is
// the gateway's resolution step (resolveBySlug), ID is what assertions carry.
// ──────────────────────────────────────────────

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadDotenv } from '@school-erp/config';
import { PrismaClient as ControlPlaneClient } from '@school-erp/control-plane';
import { TestDatabase } from '@school-erp/testing';
import { LruTenantClientCache, NoTenantContextError, TenantRegistry, TenantUnavailableError } from './index';

loadDotenv();

describe('TenantRegistry', () => {
  let controlDb: TestDatabase;
  let tenantDbA: TestDatabase;
  let controlPlane: ControlPlaneClient;
  let registry: TenantRegistry;
  let smallRegistry: TenantRegistry;

  let activeId: string;
  let blockedId: string;
  let evictBId: string;
  let evictCId: string;

  const tenantDbUrl = () => tenantDbA.url;

  beforeAll(async () => {
    const base = process.env.DATABASE_URL as string;
    controlDb = await TestDatabase.create(base, { project: 'control-plane' });
    tenantDbA = await TestDatabase.create(base);

    controlPlane = new ControlPlaneClient({ datasourceUrl: controlDb.url });
    registry = new TenantRegistry({ controlPlane });

    // A school database with one school in it — proves routing lands on the
    // right database.
    const tenantA = tenantDbA.client();
    await tenantA.school.create({
      data: {
        name: 'DPS Noida',
        code: 'DPSN',
        address: 'Noida',
        city: 'Noida',
        state: 'UP',
        pincode: '201301',
        phone: '0120000000',
        email: 'dps@school.example.test',
      },
    });
    await tenantA.$disconnect();

    // Control plane: the active tenant + its datastore, and a blocked one.
    const plan = await controlPlane.plan.create({
      data: {
        code: 'standard',
        name: 'Standard',
        pricePerStudentYear: 150,
        maxBranches: 3,
        maxStudents: 2000,
      },
    });
    const active = await controlPlane.tenant.create({
      data: { slug: 'dps-noida', legalName: 'DPS Noida', status: 'ACTIVE', planId: plan.id },
    });
    activeId = active.id;
    await controlPlane.tenantDatastore.create({
      data: { tenantId: activeId, kind: 'POSTGRES', connRef: tenantDbUrl(), schemaVersion: 1 },
    });

    const blocked = await controlPlane.tenant.create({
      data: { slug: 'blocked-co', legalName: 'Blocked Co', status: 'SUSPENDED' },
    });
    blockedId = blocked.id;
    await controlPlane.tenantDatastore.create({
      data: { tenantId: blockedId, connRef: tenantDbUrl() },
    });

    // Two more ACTIVE tenants for the LRU eviction test (same school DB is
    // fine — eviction only cares about client count).
    const b = await controlPlane.tenant.create({ data: { slug: 'evict-b', legalName: 'B', status: 'ACTIVE' } });
    evictBId = b.id;
    await controlPlane.tenantDatastore.create({ data: { tenantId: evictBId, connRef: tenantDbUrl() } });
    const c = await controlPlane.tenant.create({ data: { slug: 'evict-c', legalName: 'C', status: 'ACTIVE' } });
    evictCId = c.id;
    await controlPlane.tenantDatastore.create({ data: { tenantId: evictCId, connRef: tenantDbUrl() } });

    smallRegistry = new TenantRegistry({
      controlPlane,
      clientCache: new LruTenantClientCache(2, 60_000),
    });
  });

  afterAll(async () => {
    await registry.close();
    await smallRegistry.close();
    await controlPlane.$disconnect();
    await tenantDbA.teardown();
    await controlDb.teardown();
  });

  it('resolves a tenant by slug with its datastore reference', async () => {
    const record = await registry.resolveBySlug('dps-noida');
    expect(record).not.toBeNull();
    expect(record?.tenantId).toBe(activeId);
    expect(record?.status).toBe('ACTIVE');
    expect(record?.connRef).toBe(tenantDbUrl());
    expect(record?.schemaVersion).toBe(1);
  });

  it('returns null for an unknown slug', async () => {
    await expect(registry.resolveBySlug('no-such-school')).resolves.toBeNull();
  });

  it('caches resolution for 60 seconds', async () => {
    const probe = await controlPlane.tenant.create({
      data: { slug: 'cache-me', legalName: 'Cache Me', status: 'ACTIVE' },
    });
    await controlPlane.tenantDatastore.create({
      data: { tenantId: probe.id, connRef: tenantDbUrl() },
    });

    const first = await registry.resolveBySlug('cache-me');
    expect(first?.tenantId).toBe(probe.id);

    // Delete the row behind the cache — a cached resolve must still succeed.
    await controlPlane.tenant.delete({ where: { id: probe.id } });
    const second = await registry.resolveBySlug('cache-me');
    expect(second?.tenantId).toBe(probe.id);
  });

  // ── The GATE-1 guard: no tenant context, no query ──
  it('refuses to open a client outside a tenant context', async () => {
    await expect(registry.getClient()).rejects.toThrow(NoTenantContextError);
  });

  it('routes getClient() to the tenant bound in context', async () => {
    await registry.runWithTenant(activeId, async () => {
      const client = await registry.getClient();
      const schools = await client.school.findMany();
      expect(schools).toHaveLength(1);
      expect(schools[0].name).toBe('DPS Noida');
    });
  });

  it('routes different tenants to different databases', async () => {
    const other = await TestDatabase.create(process.env.DATABASE_URL as string);
    const otherClient = other.client();
    await otherClient.school.create({
      data: {
        name: 'Other School',
        code: 'OTHER',
        address: 'Delhi',
        city: 'Delhi',
        state: 'DL',
        pincode: '110001',
        phone: '0110000000',
        email: 'other@school.example.test',
      },
    });
    await otherClient.$disconnect();

    const t = await controlPlane.tenant.create({
      data: { slug: 'other-school', legalName: 'Other School', status: 'ACTIVE' },
    });
    await controlPlane.tenantDatastore.create({
      data: { tenantId: t.id, connRef: other.url, schemaVersion: 1 },
    });

    await registry.runWithTenant(t.id, async () => {
      const client = await registry.getClient();
      const schools = await client.school.findMany();
      expect(schools).toHaveLength(1);
      expect(schools[0].name).toBe('Other School');
    });
    await other.teardown();
  });

  it('rejects a blocked (SUSPENDED) tenant before opening a connection', async () => {
    await expect(
      registry.runWithTenant(blockedId, async () => {
        throw new Error('should never run');
      }),
    ).rejects.toThrow(TenantUnavailableError);

    await expect(registry.getClientFor(blockedId)).rejects.toThrow(TenantUnavailableError);
  });

  it('throws for an unknown tenant id', async () => {
    await expect(registry.getClientFor('tenant-does-not-exist')).rejects.toThrow(/Unknown tenant/);
  });

  it('evicts least-recently-used clients past the LRU cap (ADR-2)', async () => {
    // Warm each tenant once — with a cap of 2, the first is evicted on the
    // third get.
    await smallRegistry.getClientFor(activeId);
    await smallRegistry.getClientFor(evictBId);
    await smallRegistry.getClientFor(evictCId);

    expect(smallRegistry.clientCount()).toBe(2);

    // The evicted tenant reconnects on demand and the cap holds.
    await smallRegistry.getClientFor(activeId);
    expect(smallRegistry.clientCount()).toBe(2);
  });
});