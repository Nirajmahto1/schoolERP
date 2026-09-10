// ──────────────────────────────────────────────
// GATE 3 contract + isolation sweep
//
// "OpenAPI spec published for all services" — every service must serve a
// valid document at /openapi.json, and every non-health route must reject
// unauthenticated (forged-header) access. Runs against the real app
// factories, so a route added without a spec or a gate fails here.
// ──────────────────────────────────────────────

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { PrismaClient } from '@school-erp/database';
import { TestDatabase, seedTenant, testKeypair } from '@school-erp/testing';
import { loadDotenv, type ServiceEnv } from '@school-erp/config';

loadDotenv();

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

interface ServiceUnderTest {
  name: string;
  app: Express;
  /** A gated path that should 401 without an assertion. */
  gatedPath: string;
}

describe('GATE 3: contracts and gates on every service', () => {
  let db: TestDatabase;
  let prisma: PrismaClient;
  let services: ServiceUnderTest[] = [];

  beforeAll(async () => {
    db = await TestDatabase.create(process.env.DATABASE_URL as string);
    prisma = db.client();
    const keypair = testKeypair();
    await seedTenant(prisma, { code: 'G3CT', name: 'Contract School' });

    const { createStudentApp } = await import('@school-erp/student-service/app');
    const { createAttendanceApp } = await import('@school-erp/attendance-service');
    const { createFeeApp } = await import('@school-erp/fee-service');
    const { createExamApp } = await import('@school-erp/exam-service/app');
    const { createAcademicApp } = await import('@school-erp/academic-service');
    const { createCommunicationApp } = await import('@school-erp/communication-service');
    const staffMod = await import('@school-erp/staff-service');

    services = [
      { name: 'student-service', app: createStudentApp({ env: makeEnv(db.url, keypair.publicKey, 4001), prisma }), gatedPath: '/students' },
      { name: 'attendance-service', app: createAttendanceApp({ env: makeEnv(db.url, keypair.publicKey, 4006), prisma }), gatedPath: '/attendance/daily' },
      { name: 'fee-service', app: createFeeApp({ env: makeEnv(db.url, keypair.publicKey, 4004), prisma }), gatedPath: '/invoices' },
      { name: 'exam-service', app: createExamApp({ env: makeEnv(db.url, keypair.publicKey, 4007), prisma }), gatedPath: '/examinations' },
      { name: 'academic-service', app: createAcademicApp({ env: makeEnv(db.url, keypair.publicKey, 4003), prisma }), gatedPath: '/classes' },
      { name: 'communication-service', app: createCommunicationApp({ env: makeEnv(db.url, keypair.publicKey, 4005), prisma }), gatedPath: '/announcements' },
      { name: 'staff-service', app: staffMod.app, gatedPath: '/hr' },
    ];
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await db.teardown();
  });

  it('every service serves a valid OpenAPI 3.1 document', async () => {
    for (const svc of services) {
      const res = await request(svc.app).get('/openapi.json');
      if (res.status !== 200) throw new Error(`${svc.name}: /openapi.json → ${res.status}`);
      const doc = res.body as Record<string, unknown>;
      if (doc.openapi !== '3.1.0') throw new Error(`${svc.name}: openapi version is ${doc.openapi}`);
      if (!doc.info) throw new Error(`${svc.name}: missing info block`);
      const paths = Object.keys(doc.paths as Record<string, unknown>);
      if (paths.length === 0) throw new Error(`${svc.name}: spec declares no paths`);
      if (JSON.stringify(doc.security) !== JSON.stringify([{ internalAssertion: [] }])) {
        throw new Error(`${svc.name}: global security must be the internal assertion`);
      }
    }
  });

  it('every service rejects forged identity headers on gated routes', async () => {
    for (const svc of services) {
      const res = await request(svc.app)
        .get(svc.gatedPath)
        .set('x-user-id', 'attacker')
        .set('x-user-role', 'SUPER_ADMIN')
        .set('x-branch-id', 'whatever');
      if (res.status !== 401) throw new Error(`${svc.name}: ${svc.gatedPath} without assertion → ${res.status}, expected 401`);
    }
  });

  it('every service keeps /health public and /openapi.json public', async () => {
    for (const svc of services) {
      const health = await request(svc.app).get('/health');
      if (health.status !== 200 || health.body.status !== 'ok') {
        throw new Error(`${svc.name}: /health → ${health.status}`);
      }
      const spec = await request(svc.app).get('/openapi.json');
      if (spec.status !== 200) throw new Error(`${svc.name}: /openapi.json → ${spec.status}`);
    }
  });
});
