// ──────────────────────────────────────────────
// Exam service tests (BUILD_PLAN 3.6 + GATE 3)
//
// The publication workflow is the scandal-preventer: nothing is visible
// until PUBLISHED, marks freeze at PUBLISHED, every mark change is audited.
// ──────────────────────────────────────────────

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { PrismaClient } from '@school-erp/database';
import { TestDatabase, assertionFor, seedTenant, testKeypair, type TenantSeed } from '@school-erp/testing';
import { createExamApp, SERVICE_NAME } from '../src/app';
import { loadDotenv, type ServiceEnv } from '@school-erp/config';
import { testSecret } from '@school-erp/testing';

loadDotenv();

function makeEnv(databaseUrl: string, publicKey: string): ServiceEnv {
  return {
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    DATABASE_URL: databaseUrl,
    CONTROL_PLANE_DATABASE_URL: databaseUrl,
    PORT: 4007,
    INTERNAL_ASSERTION_PUBLIC_KEY: publicKey,
  } as ServiceEnv;
}

describe('exam service', () => {
  let db: TestDatabase;
  let prisma: PrismaClient;
  let app: Express;
  let keypair: ReturnType<typeof testKeypair>;
  let seed: TenantSeed;
  let subjectId: string;
  let examId: string;
  let examSubjectId: string;

  function as(role: string, overrides?: Record<string, unknown>): string {
    return assertionFor(keypair, SERVICE, {
      userId: seed.adminUserId,
      email: 'admin@exmt.example.test',
      tenantId: seed.schoolId,
      branchId: seed.branchId,
      roles: [role],
      permissions: [],
      ...overrides,
    } as never);
  }
  const SERVICE = SERVICE_NAME;

  beforeAll(async () => {
    db = await TestDatabase.create(process.env.DATABASE_URL as string);
    prisma = db.client();
    keypair = testKeypair();
    app = createExamApp({ env: makeEnv(db.url, keypair.publicKey), prisma });
    seed = await seedTenant(prisma, { code: 'EXMT', name: 'Exam School' });

    const subject = await prisma.subject.create({
      data: { name: 'Mathematics', code: 'MATH', classId: seed.classId },
    });
    subjectId = subject.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await db.teardown();
  });

  it('creates an examination with subjects', async () => {
    const res = await request(app)
      .post('/examinations')
      .set('x-internal-assertion', as('BRANCH_ADMIN'))
      .send({
        name: 'Half-Yearly 2026',
        academicYearId: seed.academicYearId,
        startDate: '2026-09-01',
        endDate: '2026-09-05',
        subjects: [{ subjectId, examDate: '2026-09-02', startTime: '09:00', endTime: '12:00', maxMarks: 100, passingMarks: 33 }],
      });
    expect(res.status).toBe(201);
    examId = res.body.id;
    examSubjectId = res.body.subjects[0].id;
  });

  it('enters marks with an audit row', async () => {
    const res = await request(app)
      .post('/marks')
      .set('x-internal-assertion', as('TEACHER'))
      .send({
        examSubjectId,
        marks: [{ studentId: seed.studentId, marksObtained: 78 }],
      });
    expect(res.status).toBe(201);
    expect(res.body.entered).toBe(1);

    const result = await prisma.examResult.findFirst({ where: { examSubjectId, studentId: seed.studentId } });
    expect(result?.enteredBy).toBeTruthy();
    const audit = await prisma.markEntryAudit.findFirst({ where: { examResultId: result!.id } });
    expect(audit?.afterMarks.toString()).toBe('78');
  });

  it('audits mark corrections with before/after', async () => {
    const res = await request(app)
      .post('/marks')
      .set('x-internal-assertion', as('TEACHER'))
      .send({
        examSubjectId,
        marks: [{ studentId: seed.studentId, marksObtained: 82, remarks: 'recount after revaluation' }],
      });
    expect(res.status).toBe(201);

    const result = await prisma.examResult.findFirst({ where: { examSubjectId, studentId: seed.studentId } });
    const audits = await prisma.markEntryAudit.findMany({ where: { examResultId: result!.id }, orderBy: { createdAt: 'asc' } });
    expect(audits.length).toBe(2);
    expect(audits[1].beforeMarks?.toString()).toBe('78');
    expect(audits[1].afterMarks.toString()).toBe('82');
  });

  it('rejects invalid workflow transitions', async () => {
    // ENTRY → VERIFIED skips a step.
    const skip = await request(app)
      .post(`/examinations/${examId}/status`)
      .set('x-internal-assertion', as('PRINCIPAL'))
      .send({ status: 'VERIFIED' });
    expect(skip.status).toBe(409);
  });

  it('gates the report card until PUBLISHED and freezes marks after', async () => {
    // Not published → 404 (existence hidden).
    const hidden = await request(app)
      .get(`/report-card/${examId}/${seed.studentId}`)
      .set('x-internal-assertion', as('PARENT'));
    expect(hidden.status).toBe(404);

    // Walk the workflow: SUBMITTED → VERIFIED → PUBLISHED.
    for (const status of ['SUBMITTED', 'VERIFIED', 'PUBLISHED']) {
      const step = await request(app)
        .post(`/examinations/${examId}/status`)
        .set('x-internal-assertion', as('PRINCIPAL'))
        .send({ status });
      expect(step.status).toBe(200);
    }

    // Now the report card is visible and grades correctly (78→82 is 82%).
    const report = await request(app)
      .get(`/report-card/${examId}/${seed.studentId}`)
      .set('x-internal-assertion', as('PARENT'));
    expect(report.status).toBe(200);
    expect(report.body.data.subjects[0].marksObtained).toBe(82);
    expect(report.body.data.subjects[0].percent).toBe(82);
    expect(report.body.data.total.percent).toBe(82);

    // Frozen after publication.
    const frozen = await request(app)
      .post('/marks')
      .set('x-internal-assertion', as('TEACHER'))
      .send({ examSubjectId, marks: [{ studentId: seed.studentId, marksObtained: 10 }] });
    expect(frozen.status).toBe(409);
  });

  it('refuses to publish an exam with no marks', async () => {
    const empty = await request(app)
      .post('/examinations')
      .set('x-internal-assertion', as('BRANCH_ADMIN'))
      .send({
        name: 'Annual 2026',
        academicYearId: seed.academicYearId,
        startDate: '2027-03-01',
        endDate: '2027-03-08',
        subjects: [{ subjectId, examDate: '2027-03-02', startTime: '09:00', endTime: '12:00', maxMarks: 100, passingMarks: 33 }],
      });
    const emptyExamId = empty.body.id;
    for (const status of ['SUBMITTED', 'VERIFIED']) {
      await request(app).post(`/examinations/${emptyExamId}/status`).set('x-internal-assertion', as('PRINCIPAL')).send({ status });
    }
    const publish = await request(app)
      .post(`/examinations/${emptyExamId}/status`)
      .set('x-internal-assertion', as('PRINCIPAL'))
      .send({ status: 'PUBLISHED' });
    expect(publish.status).toBe(409);
  });

  it('rejects marks above maxMarks and forged assertions', async () => {
    const exam2 = await request(app)
      .post('/examinations')
      .set('x-internal-assertion', as('BRANCH_ADMIN'))
      .send({
        name: 'Unit Test 1',
        academicYearId: seed.academicYearId,
        startDate: '2026-07-01',
        endDate: '2026-07-02',
        subjects: [{ subjectId, examDate: '2026-07-01', startTime: '09:00', endTime: '10:00', maxMarks: 20, passingMarks: 8 }],
      });
    const esId = exam2.body.subjects[0].id;

    const over = await request(app)
      .post('/marks')
      .set('x-internal-assertion', as('TEACHER'))
      .send({ examSubjectId: esId, marks: [{ studentId: seed.studentId, marksObtained: 25 }] });
    expect(over.status).toBe(400);

    const forged = await request(app)
      .get(`/report-card/${examId}/${seed.studentId}`)
      .set('x-user-role', 'PRINCIPAL')
      .set('x-user-id', 'attacker');
    expect(forged.status).toBe(401);
  });
});
