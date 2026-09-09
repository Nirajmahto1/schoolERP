// ──────────────────────────────────────────────
// Tests for the Phase-1 additions to @school-erp/tenant:
//   • status → 402/423 mapping
//   • withTenant middleware (assertion tenant, slug fallback, dev fallback)
//   • directory indexing + lookup (user_directory)
// Uses schema-isolated ephemeral databases via @school-erp/testing.
// ──────────────────────────────────────────────

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { Express } from 'express';
import { loadDotenv } from '@school-erp/config';
import { PrismaClient as ControlPlaneClient } from '@school-erp/control-plane';
import { TestDatabase } from '@school-erp/testing';
import {
  TenantRegistry,
  tenantStatusHttp,
  withTenant,
  tenantPrisma,
  emailHash,
  findUserTenant,
  indexTenantUser,
  deindexTenant,
} from './index';

loadDotenv();

describe('tenant status → HTTP mapping', () => {
  it('maps SUSPENDED to 402 and DELETING/CHURNED to 423', () => {
    expect(tenantStatusHttp('SUSPENDED')?.status).toBe(402);
    expect(tenantStatusHttp('DELETING')?.status).toBe(423);
    expect(tenantStatusHttp('CHURNED')?.status).toBe(423);
    expect(tenantStatusHttp('ACTIVE')).toBeNull();
    expect(tenantStatusHttp('TRIAL')).toBeNull();
  });
});

describe('withTenant middleware + directory', () => {
  let controlDb: TestDatabase;
  let tenantDbA: TestDatabase;
  let controlPlane: ControlPlaneClient;
  let registry: TenantRegistry;
  let app: Express;

  let activeId: string;
  let suspendedId: string;
  const tenantDbUrl = () => tenantDbA.url;

  beforeAll(async () => {
    const base = process.env.DATABASE_URL as string;
    controlDb = await TestDatabase.create(base, { project: 'control-plane' });
    tenantDbA = await TestDatabase.create(base);

    controlPlane = new ControlPlaneClient({ datasourceUrl: controlDb.url });
    registry = new TenantRegistry({ controlPlane });

    const tenantA = tenantDbA.client();
    await tenantA.school.create({
      data: {
        name: 'Middleware School',
        code: 'MWS',
        address: 'X', city: 'Y', state: 'Z', pincode: '1', phone: '0', email: 'mws@t.test',
      },
    });
    await tenantA.$disconnect();

    const active = await controlPlane.tenant.create({
      data: { slug: 'middleware-school', legalName: 'Middleware School', status: 'ACTIVE' },
    });
    activeId = active.id;
    await controlPlane.tenantDatastore.create({
      data: { tenantId: activeId, kind: 'POSTGRES', connRef: tenantDbUrl(), schemaVersion: 1 },
    });

    const suspended = await controlPlane.tenant.create({
      data: { slug: 'suspended-school', legalName: 'Suspended School', status: 'SUSPENDED' },
    });
    suspendedId = suspended.id;
    await controlPlane.tenantDatastore.create({
      data: { tenantId: suspendedId, connRef: tenantDbUrl(), schemaVersion: 1 },
    });

    app = express();
    app.use('/t', withTenant({ registry, devFallbackTenantId: activeId }), async (req, res) => {
      const prisma = await tenantPrisma(req, registry);
      const schools = await prisma.school.findMany();
      res.json({ tenant: req.tenant, schools: schools.length });
    });
  });

  afterAll(async () => {
    await registry.close();
    await controlPlane.$disconnect();
    await tenantDbA.teardown();
    await controlDb.teardown();
  });

  it('binds the dev-fallback tenant and routes queries to its database', async () => {
    const res = await request(app).get('/t');
    expect(res.status).toBe(200);
    expect(res.body.tenant.tenantId).toBe(activeId);
    expect(res.body.tenant.slug).toBe('middleware-school');
    expect(res.body.schools).toBe(1);
  });

  it('prefers the X-Tenant-Slug fallback over the dev default', async () => {
    const res = await request(app).get('/t').set('x-tenant-slug', 'middleware-school');
    expect(res.status).toBe(200);
    expect(res.body.tenant.slug).toBe('middleware-school');
  });

  it('404s an unknown slug without confirming existence', async () => {
    const res = await request(app).get('/t').set('x-tenant-slug', 'no-such-school');
    expect(res.status).toBe(404);
    expect(res.body.type).toBe('tenant-not-found');
  });

  it('rejects a suspended tenant with 402 before any handler runs', async () => {
    const res = await request(app).get('/t').set('x-tenant-slug', 'suspended-school');
    expect(res.status).toBe(402);
    expect(res.body.type).toBe('tenant-suspended');
  });

  it('refuses devFallbackConnRef at construction in production', () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => new TenantRegistry({ controlPlane, devFallbackConnRef: 'postgresql://x' })).toThrow(
        /refused in production/i,
      );
    } finally {
      process.env.NODE_ENV = previous;
    }
  });
});

describe('user_directory login routing', () => {
  let controlDb: TestDatabase;
  let controlPlane: ControlPlaneClient;

  beforeAll(async () => {
    controlDb = await TestDatabase.create(process.env.DATABASE_URL as string, { project: 'control-plane' });
    controlPlane = new ControlPlaneClient({ datasourceUrl: controlDb.url });
  });

  afterAll(async () => {
    await controlPlane.$disconnect();
    await controlDb.teardown();
  });

  it('hashes emails case-insensitively and trimmed', () => {
    expect(emailHash('  Parent@Example.COM ')).toBe(emailHash('parent@example.com'));
  });

  it('upserts and finds a user by email without storing the address', async () => {
    const tenant = await controlPlane.tenant.create({
      data: { slug: 'dir-school', legalName: 'Dir School', status: 'ACTIVE' },
    });

    await indexTenantUser(controlPlane, tenant.id, { id: 'usr_1', email: 'parent@dir.test' });
    // Idempotent second write updates, never duplicates.
    await indexTenantUser(controlPlane, tenant.id, { id: 'usr_1', email: 'parent@dir.test' });

    const found = await findUserTenant(controlPlane, 'PARENT@dir.test');
    expect(found).toEqual({ tenantId: tenant.id, userId: 'usr_1' });

    const stored = await controlPlane.userDirectory.findFirst();
    expect(JSON.stringify(stored)).not.toContain('parent@dir.test');
    expect(await controlPlane.userDirectory.count()).toBe(1);
  });

  it('treats a mismatched userId as a miss', async () => {
    const tenant = await controlPlane.tenant.create({
      data: { slug: 'dir-school-2', legalName: 'Dir 2', status: 'ACTIVE' },
    });
    await indexTenantUser(controlPlane, tenant.id, { id: 'usr_real', email: 'x@y.test' });
    expect(await findUserTenant(controlPlane, 'x@y.test', 'usr_other')).toBeNull();
    expect(await findUserTenant(controlPlane, 'x@y.test', 'usr_real')).not.toBeNull();
  });

  it('returns null for an unknown email', async () => {
    expect(await findUserTenant(controlPlane, 'ghost@nowhere.test')).toBeNull();
  });

  it('deindexes a whole tenant', async () => {
    const tenant = await controlPlane.tenant.create({
      data: { slug: 'dir-school-3', legalName: 'Dir 3', status: 'ACTIVE' },
    });
    await indexTenantUser(controlPlane, tenant.id, { id: 'usr_a', email: 'a@t.test' });
    await indexTenantUser(controlPlane, tenant.id, { id: 'usr_b', email: 'b@t.test' });
    expect(await deindexTenant(controlPlane, tenant.id)).toBe(2);
    expect(await findUserTenant(controlPlane, 'a@t.test')).toBeNull();
  });
});
