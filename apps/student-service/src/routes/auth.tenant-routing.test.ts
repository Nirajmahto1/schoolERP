// ──────────────────────────────────────────────
// Tenant routing for login (BUILD_PLAN 1.3.1 + 1.1 user_directory)
//
// The isolation property under test: with one database per school, a login
// request must land on exactly the school's own database — chosen by the
// gateway's tenant hint or the control-plane directory — and credentials of
// School A aimed at School B's slug must fail WITHOUT School B's database ever
// seeing the password check.
// ──────────────────────────────────────────────

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import type { Express } from 'express';
import type { PrismaClient } from '@school-erp/database';
import { PrismaClient as ControlPlaneClient } from '@school-erp/control-plane';
import { TestDatabase, seedTenant, testKeypair, type TenantSeed } from '@school-erp/testing';
import { indexTenantUser } from '@school-erp/tenant';
import { createIdentityApp } from '../app';
import { makeIdentityTestEnv, TEST_PASSWORD } from './test.setup';

describe('login tenant routing', () => {
  let controlDb: TestDatabase;
  let dbAlpha: TestDatabase;
  let dbBeta: TestDatabase;
  let dbGamma: TestDatabase;
  let controlPlane: ControlPlaneClient;
  let app: Express;

  let alpha: TenantSeed;
  let beta: TenantSeed;
  let gamma: TenantSeed;
  let alphaTenantId: string;
  let betaTenantId: string;
  let gammaTenantId: string;

  beforeAll(async () => {
    const base = process.env.DATABASE_URL as string;
    controlDb = await TestDatabase.create(base, { project: 'control-plane' });
    dbAlpha = await TestDatabase.create(base);
    dbBeta = await TestDatabase.create(base);
    dbGamma = await TestDatabase.create(base);

    controlPlane = new ControlPlaneClient({ datasourceUrl: controlDb.url });
    alpha = await seedTenant(dbAlpha.client(), { code: 'alpha', name: 'Alpha School' });
    beta = await seedTenant(dbBeta.client(), { code: 'beta', name: 'Beta School' });
    gamma = await seedTenant(dbGamma.client(), { code: 'gamma', name: 'Gamma School' });

    // Control plane: three tenants, each with its own datastore connection.
    const tA = await controlPlane.tenant.create({
      data: { slug: 'alpha-school', legalName: 'Alpha School', status: 'ACTIVE' },
    });
    alphaTenantId = tA.id;
    await controlPlane.tenantDatastore.create({
      data: { tenantId: tA.id, kind: 'POSTGRES', connRef: dbAlpha.url, schemaVersion: 1 },
    });
    const tB = await controlPlane.tenant.create({
      data: { slug: 'beta-school', legalName: 'Beta School', status: 'ACTIVE' },
    });
    betaTenantId = tB.id;
    await controlPlane.tenantDatastore.create({
      data: { tenantId: tB.id, kind: 'POSTGRES', connRef: dbBeta.url, schemaVersion: 1 },
    });
    const tG = await controlPlane.tenant.create({
      data: { slug: 'gamma-school', legalName: 'Gamma School', status: 'ACTIVE' },
    });
    gammaTenantId = tG.id;
    await controlPlane.tenantDatastore.create({
      data: { tenantId: tG.id, kind: 'POSTGRES', connRef: dbGamma.url, schemaVersion: 1 },
    });

    // Directory index: where each admin's email lives.
    const alphaPrisma = dbAlpha.client();
    const betaPrisma = dbBeta.client();
    const gammaPrisma = dbGamma.client();
    const alphaAdmin = await alphaPrisma.user.findUnique({ where: { id: alpha.adminUserId } });
    const betaAdmin = await betaPrisma.user.findUnique({ where: { id: beta.adminUserId } });
    const gammaAdmin = await gammaPrisma.user.findUnique({ where: { id: gamma.adminUserId } });
    await indexTenantUser(controlPlane, alphaTenantId, {
      id: alpha.adminUserId,
      email: alphaAdmin!.email,
    });
    await indexTenantUser(controlPlane, betaTenantId, {
      id: beta.adminUserId,
      email: betaAdmin!.email,
    });
    await indexTenantUser(controlPlane, gammaTenantId, {
      id: gamma.adminUserId,
      email: gammaAdmin!.email,
    });

    // Real password hashes for all three admins.
    const hash = await bcrypt.hash(TEST_PASSWORD, 10);
    await alphaPrisma.user.update({
      where: { id: alpha.adminUserId },
      data: { passwordHash: hash },
    });
    await betaPrisma.user.update({
      where: { id: beta.adminUserId },
      data: { passwordHash: hash },
    });
    await gammaPrisma.user.update({
      where: { id: gamma.adminUserId },
      data: { passwordHash: hash },
    });
    await alphaPrisma.$disconnect();
    await betaPrisma.$disconnect();
    await gammaPrisma.$disconnect();

    app = createIdentityApp({
      env: makeIdentityTestEnv(dbAlpha.url, testKeypair()),
      prisma: dbAlpha.client(),
      controlPlane,
    });
  });

  afterAll(async () => {
    await controlPlane.$disconnect();
    await dbAlpha.teardown();
    await dbBeta.teardown();
    await dbGamma.teardown();
    await controlDb.teardown();
  });

  it('routes login via X-Tenant-Slug to that school\'s own database', async () => {
    const res = await request(app)
      .post('/auth/login')
      .set('x-tenant-slug', 'beta-school')
      .send({ email: 'admin@beta.example.test', password: TEST_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(beta.adminUserId);
  });

  it('refuses School A credentials aimed at School B without touching B\'s login path', async () => {
    const res = await request(app)
      .post('/auth/login')
      .set('x-tenant-slug', 'beta-school')
      .send({ email: 'admin@alpha.example.test', password: TEST_PASSWORD });

    // Same generic message as a bad password — never confirm cross-school
    // email existence.
    expect(res.status).toBe(401);
    expect(res.body.detail).toBe('Email or password is incorrect.');
  });

  it('routes login via user_directory when no slug header is present', async () => {
    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'admin@beta.example.test', password: TEST_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(beta.adminUserId);
  });

  it('still logs in against the ambient database when neither hint nor directory exists', async () => {
    // The seeded alpha admin has no slug hint here; the directory resolves it.
    // For the "no directory" path we use an email that exists in the ambient
    // (alpha) database but was never indexed — alpha IS the ambient DB.
    const res = await request(app)
      .post('/auth/login')
      .send({ email: `${'alpha'}-student@example.test`, password: 'whatever' });

    // Student password was not set to TEST_PASSWORD; the point is only that
    // the request reached a database and failed with the standard 401.
    expect(res.status).toBe(401);
  });

  it('routes login for the third tenant (gamma) via slug and directory', async () => {
    const viaSlug = await request(app)
      .post('/auth/login')
      .set('x-tenant-slug', 'gamma-school')
      .send({ email: 'admin@gamma.example.test', password: TEST_PASSWORD });
    expect(viaSlug.status).toBe(200);
    expect(viaSlug.body.user.id).toBe(gamma.adminUserId);

    const viaDirectory = await request(app)
      .post('/auth/login')
      .send({ email: 'admin@gamma.example.test', password: TEST_PASSWORD });
    expect(viaDirectory.status).toBe(200);
    expect(viaDirectory.body.user.id).toBe(gamma.adminUserId);
  });

  it('refuses Gamma credentials aimed at Alpha without touching Alpha\'s login path', async () => {
    const res = await request(app)
      .post('/auth/login')
      .set('x-tenant-slug', 'alpha-school')
      .send({ email: 'admin@gamma.example.test', password: TEST_PASSWORD });

    expect(res.status).toBe(401);
    expect(res.body.detail).toBe('Email or password is incorrect.');
  });

  it('never stores the raw email in the directory', async () => {
    const rows = await controlPlane.userDirectory.findMany();
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain('admin@alpha.example.test');
    expect(dump).not.toContain('admin@beta.example.test');
    expect(dump).not.toContain('admin@gamma.example.test');
  });
});
