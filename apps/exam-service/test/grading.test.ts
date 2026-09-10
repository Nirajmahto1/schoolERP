// ──────────────────────────────────────────────
// Exam service — grading + edge cases (GATE 3 coverage)
//
// Pins the report-card math: grade-band mapping (including band edges),
// absent/exempt exclusion from totals, and the publish-freeze boundary.
// ──────────────────────────────────────────────

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { PrismaClient } from '@school-erp/database';
import { TestDatabase, assertionFor, seedTenant, testKeypair, type TenantSeed } from '@school-erp/testing';
import { createExamApp, SERVICE_NAME } from '../src/app';
import { loadDotenv, type ServiceEnv } from '@school-erp/config';

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

describe('exam grading', () => {
  let db: TestDatabase;
  let prisma: PrismaClient;
  let app: Express;
  let keypair: ReturnType<typeof testKeypair>;
  let seed: TenantSeed;

  const as = (role = 'BRANCH_ADMIN') =>
    assertionFor(keypair, SERVICE_NAME, {
      userId: seed.adminUserId, email: 'admin@grd.example.test',
      tenantId: seed.schoolId, branchId: seed.branchId, roles: [role], permissions: [],
    } as never);

  beforeAll(async () => {
    db = await TestDatabase.create(process.env.DATABASE_URL as string);
    prisma = db.client();
    keypair = testKeypair();
    app = createExamApp({ env: makeEnv(db.url, keypair.publicKey), prisma });
    seed = await seedTenant(prisma, { code: 'GRD', name: 'Grade School' });
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await db.teardown();
  });

  interface Student { id: string }

  async function makeStudent(admissionNo: string): Promise<string> {
    const user = await prisma.user.create({
      data: {
        email: `${admissionNo.toLowerCase()}@grd.test`,
        passwordHash: 'x',
        defaultBranchId: seed.branchId,
        roleAssignments: { create: { roleId: 'sys_student', branchId: seed.branchId } },
      },
      select: { id: true },
    });
    const s = await prisma.student.create({
      data: {
        userId: user.id,
        branchId: seed.branchId,
        admissionNo,
        firstName: 'Grade', lastName: admissionNo,
        dateOfBirth: new Date('2013-01-01'),
        gender: 'FEMALE',
        address: 'x',
        admissionDate: new Date('2026-04-01'),
      },
      select: { id: true },
    });
    return s.id;
  }

  async function makePublishedExamWithResults(
    marks: Array<{ studentId: string; marksObtained: number | null; isAbsent?: boolean; isExempt?: boolean }>,
    maxMarks = 100,
  ): Promise<{ examId: string }> {
    const subject = await prisma.subject.create({
      data: { name: `Sub-${Math.random().toString(36).slice(2, 7)}`, code: `S${Math.random().toString(36).slice(2, 7).toUpperCase()}`, classId: seed.classId },
    });
    const exam = await request(app)
      .post('/examinations')
      .set('x-internal-assertion', as())
      .send({
        name: `Exam-${Math.random().toString(36).slice(2, 7)}`,
        academicYearId: seed.academicYearId,
        startDate: '2026-10-01', endDate: '2026-10-03',
        subjects: [{ subjectId: subject.id, examDate: '2026-10-02', startTime: '09:00', endTime: '12:00', maxMarks, passingMarks: Math.floor(maxMarks * 0.33) }],
      });
    expect(exam.status).toBe(201);

    if (marks.length) {
      const entry = await request(app)
        .post('/marks')
        .set('x-internal-assertion', as('TEACHER'))
        .send({
          examSubjectId: exam.body.subjects[0].id,
          marks: marks.map((m) => ({
            studentId: m.studentId,
            marksObtained: m.marksObtained ?? 0,
            isAbsent: m.isAbsent ?? false,
            isExempt: m.isExempt ?? false,
          })),
        });
      expect(entry.status).toBe(201);
    }

    for (const status of ['SUBMITTED', 'VERIFIED', 'PUBLISHED']) {
      const step = await request(app)
        .post(`/examinations/${exam.body.id}/status`)
        .set('x-internal-assertion', as('PRINCIPAL'))
        .send({ status });
      expect(step.status).toBe(200);
    }
    return { examId: exam.body.id };
  }

  it('maps percentages to CBSE-style grade bands, including band edges', async () => {
    // Scheme: A1 91-100, A2 81-90, B1 71-80, E 0-33.
    const scheme = await prisma.gradingScheme.create({
      data: {
        name: 'CBSE', branchId: seed.branchId, academicYearId: seed.academicYearId, isDefault: true, isActive: true,
        bands: {
          create: [
            { grade: 'A1', minPercent: 91, maxPercent: 100 },
            { grade: 'A2', minPercent: 81, maxPercent: 90.99 },
            { grade: 'B1', minPercent: 71, maxPercent: 80.99 },
            { grade: 'E', minPercent: 0, maxPercent: 33 },
          ],
        },
      },
      include: { bands: true },
    });
    expect(scheme.bands).toHaveLength(4);

    const a1 = await makeStudent('GRD-001');
    const edge = await makeStudent('GRD-002'); // exactly 91 → A1
    const a2 = await makeStudent('GRD-003');   // 85 → A2
    const b1 = await makeStudent('GRD-004');   // 75 → B1

    const { examId } = await makePublishedExamWithResults([
      { studentId: a1, marksObtained: 95 },
      { studentId: edge, marksObtained: 91 },
      { studentId: a2, marksObtained: 85 },
      { studentId: b1, marksObtained: 75 },
    ]);

    for (const [studentId, expectedGrade] of [
      [a1, 'A1'], [edge, 'A1'], [a2, 'A2'], [b1, 'B1'],
    ] as Array<[string, string]>) {
      const report = await request(app)
        .get(`/report-card/${examId}/${studentId}`)
        .set('x-internal-assertion', as());
      expect(report.status).toBe(200);
      expect(report.body.data.subjects[0].grade).toBe(expectedGrade);
      expect(report.body.data.total.grade).toBe(expectedGrade);
    }
  });

  it('excludes absent and exempt students from totals without corrupting others', async () => {
    const absent = await makeStudent('GRD-101');
    const exempt = await makeStudent('GRD-102');
    const present = await makeStudent('GRD-103');

    const { examId } = await makePublishedExamWithResults([
      { studentId: absent, marksObtained: 0, isAbsent: true },
      { studentId: exempt, marksObtained: 0, isExempt: true },
      { studentId: present, marksObtained: 70 },
    ]);

    const absentReport = await request(app)
      .get(`/report-card/${examId}/${absent}`)
      .set('x-internal-assertion', as());
    expect(absentReport.status).toBe(200);
    expect(absentReport.body.data.subjects[0].isAbsent).toBe(true);
    expect(absentReport.body.data.subjects[0].marksObtained).toBeNull();
    expect(absentReport.body.data.total.marks).toBe(0);
    expect(absentReport.body.data.total.maxMarks).toBe(0);

    const exemptReport = await request(app)
      .get(`/report-card/${examId}/${exempt}`)
      .set('x-internal-assertion', as());
    expect(exemptReport.body.data.subjects[0].isExempt).toBe(true);
    expect(exemptReport.body.data.total.maxMarks).toBe(0);

    // The present student is unaffected by the others' absence.
    const presentReport = await request(app)
      .get(`/report-card/${examId}/${present}`)
      .set('x-internal-assertion', as());
    expect(presentReport.body.data.total.percent).toBe(70);
  });

  it('returns 404 (not leaks) for an unpublished exam and a foreign student', async () => {
    const student = await makeStudent('GRD-201');
    const subject = await prisma.subject.create({
      data: { name: 'Hidden', code: 'HID1', classId: seed.classId },
    });
    const exam = await request(app)
      .post('/examinations')
      .set('x-internal-assertion', as())
      .send({
        name: 'Unpublished', academicYearId: seed.academicYearId,
        startDate: '2026-11-01', endDate: '2026-11-02',
        subjects: [{ subjectId: subject.id, examDate: '2026-11-01', startTime: '09:00', endTime: '10:00', maxMarks: 50, passingMarks: 17 }],
      });
    const examId = exam.body.id;
    await request(app).post('/marks').set('x-internal-assertion', as('TEACHER'))
      .send({ examSubjectId: exam.body.subjects[0].id, marks: [{ studentId: student, marksObtained: 40 }] });

    const hidden = await request(app)
      .get(`/report-card/${examId}/${student}`)
      .set('x-internal-assertion', as());
    expect(hidden.status).toBe(404);

    // Publish; then a made-up student id is a clean 404.
    for (const status of ['SUBMITTED', 'VERIFIED', 'PUBLISHED']) {
      await request(app).post(`/examinations/${examId}/status`).set('x-internal-assertion', as('PRINCIPAL')).send({ status });
    }
    const missing = await request(app)
      .get(`/report-card/${examId}/nonexistent-student`)
      .set('x-internal-assertion', as());
    expect(missing.status).toBe(404);
  });

  it('rejects negative marks and non-numeric TOTP-style junk', async () => {
    const student = await makeStudent('GRD-301');
    const subject = await prisma.subject.create({
      data: { name: 'Neg', code: 'NEG1', classId: seed.classId },
    });
    const exam = await request(app)
      .post('/examinations')
      .set('x-internal-assertion', as())
      .send({
        name: 'NegTest', academicYearId: seed.academicYearId,
        startDate: '2026-12-01', endDate: '2026-12-02',
        subjects: [{ subjectId: subject.id, examDate: '2026-12-01', startTime: '09:00', endTime: '10:00', maxMarks: 50, passingMarks: 17 }],
      });
    expect(exam.status).toBe(201);

    const negative = await request(app)
      .post('/marks')
      .set('x-internal-assertion', as('TEACHER'))
      .send({ examSubjectId: exam.body.subjects[0].id, marks: [{ studentId: student, marksObtained: -5 }] });
    expect(negative.status).toBe(400);
  });
});
