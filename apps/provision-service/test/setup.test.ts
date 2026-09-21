// ──────────────────────────────────────────────
// Provision service tests
//
// The setup wizard is the deployment's front door — its guards are the
// product. Asserts: empty-DB lock, one-shot bootstrap completeness
// (school/branch/owner/year/class ladder/permissions), branch management,
// and that the gated surface refuses anonymous callers.
// ──────────────────────────────────────────────

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import type { Express } from 'express';
import type { PrismaClient } from '@school-erp/database';
import { TestDatabase, assertionFor, testKeypair } from '@school-erp/testing';
import { createProvisionApp } from '../src/app';
import { makeProvisionTestEnv } from '../src/test.setup';
import { setLogoStorageDir } from '../src/logo';

const SERVICE = 'provision-service';

const VALID = {
  schoolName: 'Sunrise Public School',
  schoolCode: 'SPS',
  address: '1 Sunrise Road',
  city: 'Noida',
  state: 'UP',
  pincode: '201301',
  phone: '9876543210',
  email: 'office@sunrise.test',
  branchName: 'Main Campus',
  branchCode: 'MAIN',
  adminEmail: 'owner@sunrise.test',
  adminPassword: 'CorrectHorse9!',
};

let testLogoDir: string;

describe('provision service — setup wizard', () => {
  /**
   * Reset the tenant side between scenarios, in FK-dependency order
   * (academic_years and staff RESTRICT branch deletion; students/enrollments
   * RESTRICT classes). The extra tables make the wipe safe even when this
   * suite runs against a shared dev database that already holds data.
   * Role/permission catalog rows are kept.
   */
  async function wipeTenant(): Promise<void> {
    await prisma.attendanceRecord?.deleteMany?.();
    await prisma.studentEnrollment.deleteMany();
    await prisma.student.deleteMany();
    await prisma.invoice?.deleteMany?.();
    await prisma.feePayment?.deleteMany?.();
    await prisma.staff.deleteMany();
    await prisma.teacherSubject?.deleteMany?.();
    await prisma.class.deleteMany();
    await prisma.academicYear.deleteMany();
    await prisma.school.deleteMany();
    await prisma.userRoleAssignment.deleteMany();
    await prisma.user.deleteMany();
  }
  let db: TestDatabase;
  let prisma: PrismaClient;
  let app: Express;
  let keypair: ReturnType<typeof testKeypair>;

  beforeAll(async () => {
    db = await TestDatabase.create(process.env.DATABASE_URL as string);
    prisma = db.client();
    keypair = testKeypair();
    app = createProvisionApp({ env: makeProvisionTestEnv(db.url, keypair), prisma });
    // A throwaway temp dir — never the repo's real data/logos.
    testLogoDir = path.join(tmpdir(), `provision-test-logos-${Date.now()}`);
    setLogoStorageDir(testLogoDir);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await db.teardown();
    await rm(testLogoDir, { recursive: true, force: true });
  });

  /** Wipe, then re-bootstrap the base tenant (no logo) via the public API. */
  async function prepareBaseState(): Promise<void> {
    await wipeTenant();
    const res = await request(app).post('/setup').send(VALID);
    if (res.status !== 201) throw new Error(`prepareBaseState failed: ${JSON.stringify(res.body)}`);
  }

  it('reports unprovisioned on a fresh database', async () => {
    const res = await request(app).get('/setup/status');
    expect(res.status).toBe(200);
    expect(res.body.provisioned).toBe(false);
  });

  it('rejects a weak password before creating anything', async () => {
    const res = await request(app).post('/setup').send({ ...VALID, adminPassword: 'short' });
    expect(res.status).toBe(400);
    expect(await prisma.school.count()).toBe(0);
  });

  it('completes first-run setup and creates the full structure', async () => {
    const res = await request(app).post('/setup').send(VALID);
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);

    const school = await prisma.school.findFirst({ include: { branches: true } });
    expect(school?.name).toBe('Sunrise Public School');
    expect(school?.code).toBe('SPS');
    expect(school?.branches).toHaveLength(1);

    const admin = await prisma.user.findUnique({
      where: { email: 'owner@sunrise.test' },
      include: { roleAssignments: { include: { role: true } } },
    });
    expect(admin).toBeTruthy();
    const codes = admin!.roleAssignments.map((a) => a.role.code).sort();
    expect(codes).toEqual(['PRINCIPAL', 'SUPER_ADMIN']);
    expect(await bcrypt.compare('CorrectHorse9!', admin!.passwordHash)).toBe(true);

    // Class ladder provisioned for the new branch.
    const classes = await prisma.class.findMany({ where: { branchId: school!.branches[0].id } });
    expect(classes.length).toBeGreaterThanOrEqual(15);

    // Owner's permissions resolve — the dashboard renders.
    const perms = await prisma.rolePermission.count({
      where: { role: { code: 'SUPER_ADMIN' } },
    });
    expect(perms).toBeGreaterThanOrEqual(40);

    // Current academic year exists and is flagged current.
    const year = await prisma.academicYear.findFirst({ where: { branchId: school!.branches[0].id } });
    expect(year?.isCurrent).toBe(true);
  });

  it('locks the wizard after the first successful run', async () => {
    const res = await request(app).post('/setup').send({
      ...VALID,
      schoolCode: 'OTHER',
      adminEmail: 'other@sunrise.test',
    });
    expect(res.status).toBe(409);
    expect(res.body.type).toBe('already-provisioned');
    expect(await prisma.school.count()).toBe(1);
  });

  it('status flips to provisioned', async () => {
    const res = await request(app).get('/setup/status');
    expect(res.status).toBe(200);
    expect(res.body.provisioned).toBe(true);
  });

  it('serves the school profile for the dashboard chrome', async () => {
    const res = await request(app).get('/setup/school');
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Sunrise Public School');
    expect(typeof res.body.code).toBe('string');
    expect(res.body.logoUrl).toBeNull();
  });

  it('accepts a real PNG logo upload (magic bytes verified)', async () => {
    // Wipe and start clean for the upload scenario.
    await wipeTenant();

    // Minimal VALID PNG: 8-byte signature + IHDR chunk is enough for the
    // magic check (the browser does the real rendering; we validate bytes).
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
    ]);
    const res = await request(app)
      .post('/setup')
      .field('schoolName', VALID.schoolName)
      .field('schoolCode', VALID.schoolCode)
      .field('adminEmail', VALID.adminEmail)
      .field('adminPassword', VALID.adminPassword)
      .attach('logo', png, { filename: 'logo.png', contentType: 'image/png' });
    expect(res.status).toBe(201);
    expect(res.body.logoUrl).toMatch(/^\/setup\/logo\/logo_\d+_[a-f0-9]+\.png$/);

    const school = await prisma.school.findFirst();
    expect(school?.logo).toBe(res.body.logoUrl);

    // The stored file must be servable through the public route.
    const serve = await request(app).get(res.body.logoUrl);
    expect(serve.status).toBe(200);
    expect(serve.headers['content-type']).toContain('image/png');
  });

  it('rejects a fake JPG (wrong magic bytes) without creating anything', async () => {
    await wipeTenant();

    const fakeJpg = Buffer.from('<html>this is not an image</html>');
    const res = await request(app)
      .post('/setup')
      .field('schoolName', VALID.schoolName)
      .field('schoolCode', VALID.schoolCode)
      .field('adminEmail', VALID.adminEmail)
      .field('adminPassword', VALID.adminPassword)
      .attach('logo', fakeJpg, { filename: 'logo.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(415);
    expect(res.body.type).toBe('logo-invalid');
    expect(await prisma.school.count()).toBe(0);
  });

  it('rejects a text file with an image content-type', async () => {
    await wipeTenant();
    const res = await request(app)
      .post('/setup')
      .field('schoolName', VALID.schoolName)
      .field('schoolCode', VALID.schoolCode)
      .field('adminEmail', VALID.adminEmail)
      .field('adminPassword', VALID.adminPassword)
      .attach('logo', Buffer.from('definitely not an image'), { filename: 'x.png', contentType: 'image/png' });
    expect(res.status).toBe(415);
    expect(await prisma.school.count()).toBe(0);
  });

  it('refuses anonymous branch management', async () => {
    const res = await request(app).get('/branches');
    expect(res.status).toBe(401);
  });

  it('lists branches with counts for the owner', async () => {
    await prepareBaseState();
    const admin = await prisma.user.findUnique({ where: { email: 'owner@sunrise.test' } });
    const assertion = assertionFor(keypair, SERVICE, {
      userId: admin!.id,
      email: admin!.email,
      tenantId: 'test-tenant',
      branchId: null,
      roles: ['SUPER_ADMIN'],
    });
    const res = await request(app).get('/branches').set('x-internal-assertion', assertion);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].code).toBe('MAIN');
  });

  it('refuses branch management to non-admin roles', async () => {
    const teacher = await prisma.user.create({
      data: {
        email: 'teacher@sunrise.test',
        passwordHash: await bcrypt.hash('CorrectHorse9!', 10),
        roleAssignments: { create: { roleId: (await prisma.role.findUnique({ where: { code: 'TEACHER' } }))!.id } },
      },
    });
    const assertion = assertionFor(keypair, SERVICE, {
      userId: teacher.id,
      email: teacher.email,
      tenantId: 'test-tenant',
      branchId: null,
      roles: ['TEACHER'],
    });
    const res = await request(app).get('/branches').set('x-internal-assertion', assertion);
    expect(res.status).toBe(403);
    const res2 = await request(app)
      .post('/branches')
      .set('x-internal-assertion', assertion)
      .send({ name: 'Sneaky Branch', code: 'SNEAK' });
    expect(res2.status).toBe(403);
  });

  it('adds a branch with its own academic year and class ladder', async () => {
    await prepareBaseState();
    const admin = await prisma.user.findUnique({ where: { email: 'owner@sunrise.test' } });
    const assertion = assertionFor(keypair, SERVICE, {
      userId: admin!.id,
      email: admin!.email,
      tenantId: 'test-tenant',
      branchId: null,
      roles: ['SUPER_ADMIN'],
    });
    const res = await request(app)
      .post('/branches')
      .set('x-internal-assertion', assertion)
      .send({ name: 'North Campus', code: 'NORTH' });
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);

    const year = await prisma.academicYear.findFirst({ where: { branchId: res.body.branchId } });
    expect(year?.isCurrent).toBe(true);
    const classes = await prisma.class.count({ where: { branchId: res.body.branchId } });
    expect(classes).toBeGreaterThanOrEqual(15);

    // Branch code must stay unique within the school.
    const dup = await request(app)
      .post('/branches')
      .set('x-internal-assertion', assertion)
      .send({ name: 'Duplicate', code: 'NORTH' });
    expect(dup.status).toBe(409);
  });
});
