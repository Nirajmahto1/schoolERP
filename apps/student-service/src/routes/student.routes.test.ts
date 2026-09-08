// ──────────────────────────────────────────────
// Student endpoint tests (BUILD_PLAN 0.7.3 + 0.7.4 + 0.5.4)
//
// • Forged-header test: a request straight at the service port with
//   x-user-role/x-school-id/x-user-id headers and no assertion gets 401.
// • Cross-tenant isolation: authenticate as tenant A, request tenant B's
//   resource id, assert 404 (never 403 — a 403 confirms existence).
// ──────────────────────────────────────────────

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { PrismaClient } from '@school-erp/database';
import {
  TestDatabase,
  assertionFor,
  seedTenant,
  testKeypair,
  type TenantSeed,
  type TestIdentity,
} from '@school-erp/testing';
import { createIdentityApp } from '../app';
import { makeIdentityTestEnv } from './test.setup';

const SERVICE = 'student-service';

describe('student endpoints', () => {
  let db: TestDatabase;
  let prisma: PrismaClient;
  let app: Express;
  let keypair: ReturnType<typeof testKeypair>;
  let alpha: TenantSeed;
  let beta: TenantSeed;

  beforeAll(async () => {
    db = await TestDatabase.create(process.env.DATABASE_URL as string);
    prisma = db.client();
    keypair = testKeypair();
    app = createIdentityApp({ env: makeIdentityTestEnv(db.url, keypair), prisma });
    alpha = await seedTenant(prisma, { code: 'ALPHA', name: 'Alpha School' });
    beta = await seedTenant(prisma, { code: 'BETA', name: 'Beta School' });
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await db.teardown();
  });

  /** A valid assertion as Alpha School's branch admin. */
  function asAlpha(overrides?: Partial<TestIdentity>): string {
    return assertionFor(keypair, SERVICE, {
      userId: alpha.adminUserId,
      email: 'admin@alpha.example.test',
      tenantId: alpha.schoolId,
      branchId: alpha.branchId,
      roles: ['BRANCH_ADMIN'],
      ...overrides,
    });
  }

  const newStudent = {
    admissionNo: 'ADM-9001',
    firstName: 'New',
    lastName: 'Student',
    dateOfBirth: '2014-06-01',
    gender: 'FEMALE' as const,
    classId: '',
    sectionId: '',
    address: 'Test Road',
    admissionDate: '2026-04-01',
  };

  // ── ADR-3: the forged-header test from BUILD_PLAN 0.5.4 ──
  it('rejects a forged-header SUPER_ADMIN request with 401', async () => {
    const res = await request(app)
      .get('/students')
      .set('x-user-role', 'SUPER_ADMIN')
      .set('x-user-id', 'attacker')
      .set('x-school-id', alpha.schoolId)
      .set('x-branch-id', alpha.branchId);

    expect(res.status).toBe(401);
  });

  it('rejects a write with forged identity headers', async () => {
    const res = await request(app)
      .post('/students')
      .set('x-user-role', 'SUPER_ADMIN')
      .set('x-school-id', alpha.schoolId)
      .send({ ...newStudent, classId: alpha.classId, sectionId: alpha.sectionId });

    expect(res.status).toBe(401);
  });

  it('rejects a request with no assertion at all', async () => {
    const res = await request(app).get('/students');
    expect(res.status).toBe(401);
  });

  it('rejects an assertion minted for a different service', async () => {
    const forFees = assertionFor(keypair, 'fee-service', {
      userId: alpha.adminUserId,
      email: 'admin@alpha.example.test',
      tenantId: alpha.schoolId,
      branchId: alpha.branchId,
      roles: ['BRANCH_ADMIN'],
    });
    const res = await request(app).get('/students').set('x-internal-assertion', forFees);
    expect(res.status).toBe(401);
  });

  // ── CRUD ──
  it('lists only the caller branch students', async () => {
    const res = await request(app).get('/students').set('x-internal-assertion', asAlpha());

    expect(res.status).toBe(200);
    const admissionNos = res.body.data.map((s: { admissionNo: string }) => s.admissionNo);
    expect(admissionNos).toContain('ADM-ALPHA');
    expect(admissionNos).not.toContain('ADM-BETA');
  });

  it('reads a student in the caller branch', async () => {
    const res = await request(app)
      .get(`/students/${alpha.studentId}`)
      .set('x-internal-assertion', asAlpha());

    expect(res.status).toBe(200);
    expect(res.body.firstName).toBe('Alpha School');
  });

  it('returns 404 for a nonexistent student id', async () => {
    const res = await request(app)
      .get('/students/does-not-exist')
      .set('x-internal-assertion', asAlpha());

    expect(res.status).toBe(404);
  });

  it('creates a student in the caller branch', async () => {
    const res = await request(app)
      .post('/students')
      .set('x-internal-assertion', asAlpha())
      .send({
        ...newStudent,
        classId: alpha.classId,
        sectionId: alpha.sectionId,
        parent: {
          fatherName: 'Father',
          fatherPhone: '9876500001',
          address: 'Test Road',
        },
      });

    expect(res.status).toBe(201);
    expect(res.body.branchId).toBe(alpha.branchId);
    expect(res.body.admissionNo).toBe('ADM-9001');
  });

  it('rejects a create without parent information', async () => {
    const res = await request(app)
      .post('/students')
      .set('x-internal-assertion', asAlpha())
      .send({ ...newStudent, classId: alpha.classId, sectionId: alpha.sectionId });

    expect(res.status).toBe(400);
  });

  it('rejects an invalid create payload', async () => {
    const res = await request(app)
      .post('/students')
      .set('x-internal-assertion', asAlpha())
      .send({ admissionNo: 'ADM-X' });

    expect(res.status).toBe(400);
  });

  // ── Cross-tenant isolation suite (BUILD_PLAN 0.7.4) ──
  it('isolation: reading tenant B student as tenant A returns 404', async () => {
    const res = await request(app)
      .get(`/students/${beta.studentId}`)
      .set('x-internal-assertion', asAlpha());

    expect(res.status).toBe(404);
  });

  it('isolation: updating tenant B student as tenant A returns 404', async () => {
    const res = await request(app)
      .put(`/students/${beta.studentId}`)
      .set('x-internal-assertion', asAlpha())
      .send({ firstName: 'Hacked' });

    expect(res.status).toBe(404);

    const stillIntact = await prisma.student.findUnique({
      where: { id: beta.studentId },
    });
    expect(stillIntact?.firstName).toBe('Beta School');
  });

  it('isolation: deleting tenant B student as tenant A returns 404', async () => {
    const res = await request(app)
      .delete(`/students/${beta.studentId}`)
      .set('x-internal-assertion', asAlpha());

    expect(res.status).toBe(404);

    const stillActive = await prisma.student.findUnique({
      where: { id: beta.studentId },
      select: { isActive: true },
    });
    expect(stillActive?.isActive).toBe(true);
  });

  it('isolation: listing as tenant A never returns tenant B students', async () => {
    // The create above added a third student to Alpha; Beta's student must
    // never appear in Alpha's list regardless.
    const res = await request(app).get('/students').set('x-internal-assertion', asAlpha());

    expect(res.status).toBe(200);
    for (const s of res.body.data as Array<{ admissionNo: string }>) {
      expect(s.admissionNo).not.toBe('ADM-BETA');
    }
  });
});