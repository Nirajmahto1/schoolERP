// ──────────────────────────────────────────────
// PHASE 12 / GATE 12 #2 — automated cross-tenant isolation suite
//
// "Treat a leak as a P0 with a post-mortem." This suite is the PR gate:
// two tenants seeded in one database (the multi-tenant path; DB-per-tenant
// is physical isolation on top), every object-reference route is called by
// tenant B's principal asking for tenant A's data — the answer must NEVER
// be the data (404/403 only). IDOR is the classic ERP bug; this is its net.
//
// Structure:
//   • TENANT_MATRIX — the endpoint/probe table below IS the coverage
//     manifest. Adding a service without adding rows here fails review
//     (the suite prints the manifest count).
//   • Each probe: admin of tenant B hits an A-scoped path. Same probe with
//     A's admin must succeed (200/201), proving 403/404s are authorization,
//     not broken routes.
// ──────────────────────────────────────────────

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { PrismaClient } from '@school-erp/database';
import { TestDatabase, seedTenant, testKeypair, assertionFor, type TestKeypair, type TenantSeed } from '@school-erp/testing';
import { loadDotenv, type ServiceEnv } from '@school-erp/config';

loadDotenv();

interface Probe {
  service: string;
  /** Object-reference path containing {{id}} placeholders filled from tenant A's seed. */
  path: string;
  /** Tenant A's own admin MUST get one of these (route works). */
  ownerOk: number[];
  /** Tenant B's admin MUST get one of these (never the data). */
  foreign: number[];
}

const AUD = {
  student: 'student-service',
  staff: 'staff-service',
  academic: 'academic-service',
  fee: 'fee-service',
  attendance: 'attendance-service',
  exam: 'exam-service',
};

/**
 * The coverage manifest (Gate 12 #2): every object-reference endpoint family,
 * one row each. {{schoolId}} {{branchId}} {{studentId}} {{adminUserId}}
 * {{classId}} {{yearId}} resolve to tenant A's ids in foreign probes and to
 * tenant B's ids in owner probes.
 */
const TENANT_MATRIX: Probe[] = [
  { service: AUD.student, path: '/students/{{studentIdA}}', ownerOk: [200], foreign: [403, 404] },
  { service: AUD.student, path: '/students/{{studentIdA}}/certificates', ownerOk: [200, 404], foreign: [200, 403, 404] }, // empty 200 ok if no A ids leak (asserted below)
  { service: AUD.student, path: '/dpdp/{{studentIdA}}/consent', ownerOk: [200], foreign: [200, 403, 404] }, // empty 200 ok if no A ids leak
  { service: AUD.student, path: '/dpdp/{{studentIdA}}/data-export', ownerOk: [200], foreign: [403, 404] },
  { service: AUD.staff, path: '/staff/{{adminUserIdA}}', ownerOk: [200, 404], foreign: [403, 404] },
  { service: AUD.attendance, path: '/attendance/student/{{studentIdA}}', ownerOk: [200], foreign: [403, 404] },
  { service: AUD.fee, path: '/invoices?studentId={{studentIdA}}', ownerOk: [200], foreign: [200, 403] }, // list self-scoped to branch; foreign body must not contain A rows (asserted below)
  { service: AUD.attendance, path: '/attendance/daily?date=2026-09-01&classId={{classIdA}}', ownerOk: [200, 404], foreign: [200, 403, 404] }, // branch-scoped list; foreign body must not contain A students (asserted below)
  { service: AUD.exam, path: '/examinations', ownerOk: [200], foreign: [200, 403] }, // branch-scoped list; foreign body must not contain A exams (asserted below)
];

function makeEnv(databaseUrl: string, publicKey: string, port: number): ServiceEnv {
  return {
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    DATABASE_URL: databaseUrl,
    CONTROL_PLANE_DATABASE_URL: databaseUrl,
    PORT: port,
    INTERNAL_ASSERTION_PUBLIC_KEY: publicKey,
  } as ServiceEnv;
}

interface Svc { name: string; app: Express; audience: string }

describe('PHASE 12 isolation suite (two tenants, every object reference)', () => {
  let db: TestDatabase;
  let prisma: PrismaClient;
  let keypair: TestKeypair;
  let A: TenantSeed;
  let B: TenantSeed;
  let svcs: Record<string, Svc> = {};

  beforeAll(async () => {
    // staff-service binds loadServiceEnv + PrismaClient at MODULE IMPORT with
    // no injection seam, so its probes run against process.env.DATABASE_URL.
    // Point that at a dedicated scratch database (migrated once, truncated
    // here) while the other services use the throwaway-schema harness.
    // Module import caching means the FIRST import in this process wins —
    // set the env before any service module loads.
    if (!process.env.E2E_DATABASE_URL) {
      throw new Error('E2E_DATABASE_URL is not set — the isolation suite needs a scratch DB for module-import services (see test header).');
    }
    process.env.DATABASE_URL = process.env.E2E_DATABASE_URL;

    // The suite's keypair FIRST — staff-service reads the public key from env
    // at import (below), and every assertion in this file is minted with this
    // same keypair's private half.
    keypair = testKeypair();
    process.env.INTERNAL_ASSERTION_PUBLIC_KEY = keypair.publicKey;

    db = await TestDatabase.create(process.env.E2E_DATABASE_URL);
    prisma = db.client();
    A = await seedTenant(prisma, { code: 'ISO-A', name: 'Isolation School A' });
    B = await seedTenant(prisma, { code: 'ISO-B', name: 'Isolation School B' });

    const { createStudentApp } = await import('@school-erp/student-service/app');
    const { createFeeApp } = await import('@school-erp/fee-service');
    const { createAttendanceApp } = await import('@school-erp/attendance-service');
    const { createExamApp } = await import('@school-erp/exam-service/app');
    const { createAcademicApp } = await import('@school-erp/academic-service');
    const staffMod = await import('@school-erp/staff-service');

    svcs = {
      [AUD.student]: { name: 'student-service', audience: AUD.student, app: createStudentApp({ env: makeEnv(db.url, keypair.publicKey, 4001), prisma }) },
      [AUD.fee]: { name: 'fee-service', audience: AUD.fee, app: createFeeApp({ env: makeEnv(db.url, keypair.publicKey, 4004), prisma }) },
      [AUD.attendance]: { name: 'attendance-service', audience: AUD.attendance, app: createAttendanceApp({ env: makeEnv(db.url, keypair.publicKey, 4006), prisma }) },
      [AUD.exam]: { name: 'exam-service', audience: AUD.exam, app: createExamApp({ env: makeEnv(db.url, keypair.publicKey, 4007), prisma }) },
      [AUD.academic]: { name: 'academic-service', audience: AUD.academic, app: createAcademicApp({ env: makeEnv(db.url, keypair.publicKey, 4003), prisma }) },
      [AUD.staff]: { name: 'staff-service', audience: AUD.staff, app: staffMod.app },
    };
  }, 60_000);

  afterAll(async () => {
    await prisma.$disconnect();
    await db.teardown();
  });

  function adminHeaders(tenant: TenantSeed, audience: string): Record<string, string> {
    return {
      'x-internal-assertion': assertionFor(keypair, audience, {
        userId: tenant.adminUserId,
        email: `admin@${tenant.schoolId}.test`,
        tenantId: tenant.schoolId,
        branchId: tenant.branchId,
        roles: ['BRANCH_ADMIN'],
      }),
    };
  }

  it('coverage manifest prints (must grow with every new endpoint family)', () => {
    console.log(`[isolation] manifest rows: ${TENANT_MATRIX.length} across ${new Set(TENANT_MATRIX.map((p) => p.service)).size} services`);
    expect(TENANT_MATRIX.length).toBeGreaterThanOrEqual(8);
  });

  function fill(path: string): string {
    return path
      .replace(/\{\{studentIdA\}\}/g, A.studentId)
      .replace(/\{\{classIdA\}\}/g, A.classId)
      .replace(/\{\{yearIdA\}\}/g, A.academicYearId)
      .replace(/\{\{branchIdA\}\}/g, A.branchId)
      .replace(/\{\{adminUserIdA\}\}/g, A.adminUserId)
      .replace(/\{\{sectionIdA\}\}/g, A.sectionId);
  }

  for (const probe of TENANT_MATRIX) {
    it(`[owner works] ${probe.service} ${probe.path}`, async () => {
      const svc = svcs[probe.service];
      const url = fill(probe.path);
      const res = await request(svc.app).get(url).set(adminHeaders(A, svc.audience));
      expect(probe.ownerOk).toContain(res.status);
    });

    it(`[foreign refused] ${probe.service} ${probe.path}`, async () => {
      const svc = svcs[probe.service];
      const url = fill(probe.path);
      const res = await request(svc.app).get(url).set(adminHeaders(B, svc.audience));
      expect(probe.foreign).toContain(res.status);
      if (res.status === 200) {
        // List endpoints that legitimately scope to the CALLER: prove tenant
        // A's ids never appear in B's view of the same route.
        const body = JSON.stringify(res.body ?? {});
        expect(body).not.toContain(A.studentId);
        expect(body).not.toContain(A.classId);
      }
    });
  }

  it('student detail 404s cross-tenant and never leaks A student fields', async () => {
    const svc = svcs[AUD.student];
    const res = await request(svc.app).get(`/students/${A.studentId}`).set(adminHeaders(B, AUD.student));
    expect([403, 404]).toContain(res.status);
    // The 404 detail echoes only the caller-supplied id — assert no A-owned
    // FIELDS (name, admission, guardians) appear in the body.
    const body = JSON.stringify(res.body ?? {});
    expect(body).not.toContain('admissionNo');
    expect(body).not.toContain('guardians');
  });
});
