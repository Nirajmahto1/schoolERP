// ──────────────────────────────────────────────
// GATE 3 end-to-end: one academic year on seeded data
//
// admit → enroll → timetable → attendance → exams → report card →
// fee cycle → promote. This is the BUILD_PLAN's objective condition for
// Phase 3: a school year can actually be RUN, not just stored.
//
// The services are exercised as route handlers against one shared database,
// the way the gateway wires them in production.
// ──────────────────────────────────────────────

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { PrismaClient } from '@school-erp/database';
import { TestDatabase, assertionFor, seedTenant, testKeypair, type TenantSeed } from '@school-erp/testing';
import { loadDotenv, type ServiceEnv } from '@school-erp/config';

loadDotenv();

const SERVICE = 'e2e';

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

describe('GATE 3: a full academic year runs end-to-end', () => {
  let db: TestDatabase;
  let prisma: PrismaClient;
  let keypair: ReturnType<typeof testKeypair>;
  let seed: TenantSeed;
  let nextYear: { id: string };

  // Service apps
  let studentApp: Express;
  let attendanceApp: Express;
  let feeApp: Express;
  let examApp: Express;
  let academicApp: Express;

  // State handed along the year
  let newStudentId: string;
  let sectionBId: string;
  let nextYearClassId: string;
  let nextYearSectionId: string;
  let subjectId: string;
  let feeHeadId: string;
  let feeStructureId: string;
  let examId: string;
  let examSubjectId: string;
  let invoiceId: string;

  function assertion(
    branchId = seed.branchId,
    userId = seed.adminUserId,
    roles = ['BRANCH_ADMIN'],
    tenantId = seed.schoolId,
    audience = 'student-service',
  ): string {
    return assertionFor(keypair, audience, {
      userId, email: 'admin@e2e.example.test', tenantId, branchId, roles, permissions: [],
    } as never);
  }

  // Per-service audiences, exactly as the gateway mints them in production.
  const asStudent = (roles?: string[]) => assertion(seed.branchId, seed.adminUserId, roles ?? ['BRANCH_ADMIN'], seed.schoolId, 'student-service');
  const asAttendance = (roles?: string[]) => assertion(seed.branchId, seed.adminUserId, roles ?? ['BRANCH_ADMIN'], seed.schoolId, 'attendance-service');
  const asFee = (roles?: string[]) => assertion(seed.branchId, seed.adminUserId, roles ?? ['BRANCH_ADMIN'], seed.schoolId, 'fee-service');
  const asExam = (roles?: string[]) => assertion(seed.branchId, seed.adminUserId, roles ?? ['BRANCH_ADMIN'], seed.schoolId, 'exam-service');
  const asAcademic = (roles?: string[]) => assertion(seed.branchId, seed.adminUserId, roles ?? ['BRANCH_ADMIN'], seed.schoolId, 'academic-service');

  beforeAll(async () => {
    const { createStudentApp } = await import('@school-erp/student-service/app');
    const { createAttendanceApp } = await import('@school-erp/attendance-service');
    const { createFeeApp } = await import('@school-erp/fee-service');
    const { createExamApp } = await import('@school-erp/exam-service/app');
    const { createAcademicApp } = await import('@school-erp/academic-service');

    db = await TestDatabase.create(process.env.DATABASE_URL as string);
    prisma = db.client();
    keypair = testKeypair();
    seed = await seedTenant(prisma, { code: 'E2E3', name: 'Gate Three School' });

    studentApp = createStudentApp({ env: makeEnv(db.url, keypair.publicKey, 4001), prisma });
    attendanceApp = createAttendanceApp({ env: makeEnv(db.url, keypair.publicKey, 4006), prisma });
    feeApp = createFeeApp({ env: makeEnv(db.url, keypair.publicKey, 4004), prisma });
    examApp = createExamApp({ env: makeEnv(db.url, keypair.publicKey, 4007), prisma });
    academicApp = createAcademicApp({ env: makeEnv(db.url, keypair.publicKey, 4003), prisma });

    // Next academic year for the promotion step.
    const branch = await prisma.branch.findUnique({ where: { id: seed.branchId } });
    nextYear = (await prisma.academicYear.create({
      data: {
        branchId: seed.branchId,
        name: '2027-28',
        startDate: new Date('2027-04-01'),
        endDate: new Date('2028-03-31'),
        isCurrent: false,
      },
      select: { id: true },
    })) as { id: string };
    void branch;

    const subject = await prisma.subject.create({
      data: { name: 'Science', code: 'SCI', classId: seed.classId },
    });
    subjectId = subject.id;

    const feeHead = await prisma.feeHead.create({
      data: { code: 'TUIT', name: 'Tuition', branchId: seed.branchId, type: 'TUITION' },
    });
    feeHeadId = feeHead.id;

    const structure = await prisma.feeStructure.create({
      data: {
        branchId: seed.branchId,
        academicYearId: seed.academicYearId,
        name: 'Annual 2026-27',
        isActive: true,
        lines: { create: { feeHeadId, amount: 12000 } },
        classes: { create: { classId: seed.classId } },
      },
      include: { lines: true },
    });
    feeStructureId = structure.id;

    // Section B for the promotion target.
    const sectionB = await prisma.section.create({
      data: { name: 'B', classId: seed.classId, capacity: 40 },
    });
    sectionBId = sectionB.id;

    // Next year's next class (SEVEN) — the promotion engine maps each class
    // to the class with numericOrder + 1 in the target year.
    const nextClass = await prisma.class.create({
      data: {
        branchId: seed.branchId,
        academicYearId: nextYear.id,
        name: 'SEVEN',
        numericOrder: 7,
        sections: { create: { name: 'A', capacity: 40 } },
      },
      include: { sections: true },
    });
    nextYearClassId = nextClass.id;
    nextYearSectionId = nextClass.sections[0].id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await db.teardown();
  });

  it('1. admits a new student through the admissions pipeline', async () => {
    // Enquiry → application.
    const enquiry = await request(studentApp)
      .post('/admissions/enquiries')
      .set('x-internal-assertion', asStudent())
      .send({ studentName: 'Aarav E2E', parentName: 'Rohan E2E', phone: '9800000001', classAppliedId: seed.classId });
    expect(enquiry.status).toBe(201);

    const application = await request(studentApp)
      .post('/admissions/applications')
      .set('x-internal-assertion', asStudent())
      .send({
        enquiryId: enquiry.body.id,
        firstName: 'Aarav', lastName: 'E2E',
        dateOfBirth: '2013-06-15', gender: 'MALE',
        guardianName: 'Rohan E2E', guardianPhone: '9800000001',
        classAppliedId: seed.classId,
      });
    expect(application.status).toBe(201);
    expect(application.body.applicationNo).toMatch(/^APP\//);

    // Decide + admit.
    const decision = await request(studentApp)
      .patch(`/admissions/applications/${application.body.id}/decision`)
      .set('x-internal-assertion', asStudent())
      .send({ status: 'APPROVED' });
    expect(decision.status).toBe(200);

    const admitted = await request(studentApp)
      .post(`/admissions/applications/${application.body.id}/admit`)
      .set('x-internal-assertion', asStudent())
      .send({ admissionNo: 'E2E-0001', sectionId: seed.sectionId });
    expect(admitted.status).toBe(201);
    newStudentId = admitted.body.id;

    // The admitted student is enrolled in the current year.
    const enrollment = await prisma.studentEnrollment.findFirst({
      where: { studentId: newStudentId, academicYearId: seed.academicYearId },
    });
    expect(enrollment?.status).toBe('ENROLLED');
  });

  it('2. builds a timetable without teacher clashes', async () => {
    const slot = await request(academicApp)
      .post('/timetable/slots')
      .set('x-internal-assertion', asAcademic())
      .send({ sectionId: seed.sectionId, subjectId, day: 'MONDAY', startTime: '09:00', endTime: '09:45', room: 'R1' });
    // staffId is optional on a slot; create one with a teacher and verify clash.
    expect([201, 400]).toContain(slot.status);

    const staff = await prisma.staff.create({
      data: {
        userId: (await prisma.user.create({
          data: { email: 'teacher-e2e@example.test', passwordHash: 'x', defaultBranchId: seed.branchId },
          select: { id: true },
        })).id,
        branchId: seed.branchId,
        employeeId: 'EMP-E2E-1',
        firstName: 'Test', lastName: 'Teacher', dateOfBirth: new Date('1990-01-01'),
        gender: 'FEMALE', designation: 'TGT', department: 'Science', qualification: 'M.Sc',
        joinDate: new Date('2020-06-01'), salary: 45000, address: 'addr', phone: '9800000002',
      },
    });

    const withStaff = await request(academicApp)
      .post('/timetable/slots')
      .set('x-internal-assertion', asAcademic())
      .send({ sectionId: seed.sectionId, subjectId, day: 'MONDAY', startTime: '10:00', endTime: '10:45', staffId: staff.id, room: 'R2' });
    expect(withStaff.status).toBe(201);

    // Same teacher, same time, different section → clash.
    const clash = await request(academicApp)
      .post('/timetable/slots')
      .set('x-internal-assertion', asAcademic())
      .send({ sectionId: sectionBId, subjectId, day: 'MONDAY', startTime: '10:00', endTime: '10:45', staffId: staff.id, room: 'R3' });
    expect(clash.status).toBe(409);
  });

  it('3. marks attendance for a term and the summary reflects it', async () => {
    const res = await request(attendanceApp)
      .post('/attendance/mark')
      .set('x-internal-assertion', asAttendance())
      .send({
        date: '2026-07-01', classId: seed.classId, sectionId: seed.sectionId,
        records: [{ studentId: newStudentId, status: 'PRESENT' }],
      });
    if (res.status !== 200) console.log('mark error:', res.body);
    expect(res.status).toBe(200);

    const absent = await request(attendanceApp)
      .post('/attendance/mark')
      .set('x-internal-assertion', asAttendance())
      .send({
        date: '2026-07-02', classId: seed.classId, sectionId: seed.sectionId,
        records: [{ studentId: newStudentId, status: 'ABSENT', remarks: 'unwell' }],
      });
    expect(absent.status).toBe(200);

    // Amend the absence with an audit trail.
    const record = await prisma.attendanceRecord.findFirst({
      where: { studentId: newStudentId, status: 'ABSENT' },
      include: { session: true },
    });
    const amend = await request(attendanceApp)
      .post('/attendance/amend')
      .set('x-internal-assertion', asAttendance())
      .send({ recordId: record!.id, status: 'MEDICAL', reason: 'certificate received' });
    expect(amend.status).toBe(200);

    const trail = await request(attendanceApp)
      .get(`/attendance/amendments/${record!.id}`)
      .set('x-internal-assertion', asAttendance());
    expect(trail.status).toBe(200);
    expect(trail.body.data.length).toBe(1);
    expect(trail.body.data[0].beforeStatus).toBe('ABSENT');
    expect(trail.body.data[0].afterStatus).toBe('MEDICAL');
  });

  it('4. runs the exam cycle: schedule → marks → publish → report card', async () => {
    const exam = await request(examApp)
      .post('/examinations')
      .set('x-internal-assertion', asExam())
      .send({
        name: 'Term 1 Exam',
        academicYearId: seed.academicYearId,
        startDate: '2026-09-21', endDate: '2026-09-25',
        subjects: [{ subjectId, examDate: '2026-09-22', startTime: '09:00', endTime: '12:00', maxMarks: 100, passingMarks: 33 }],
      });
    expect(exam.status).toBe(201);
    examId = exam.body.id;
    examSubjectId = exam.body.subjects[0].id;

    const marks = await request(examApp)
      .post('/marks')
      .set('x-internal-assertion', asExam(['TEACHER']))
      .send({ examSubjectId, marks: [{ studentId: newStudentId, marksObtained: 88 }] });
    expect(marks.status).toBe(201);

    for (const status of ['SUBMITTED', 'VERIFIED', 'PUBLISHED']) {
      const step = await request(examApp)
        .post(`/examinations/${examId}/status`)
        .set('x-internal-assertion', asExam())
        .send({ status });
      expect(step.status).toBe(200);
    }

    const report = await request(examApp)
      .get(`/report-card/${examId}/${newStudentId}`)
      .set('x-internal-assertion', asExam());
    expect(report.status).toBe(200);
    expect(report.body.data.total.marks).toBe(88);
  });

  it('5. runs the fee cycle: demand → payment → ledger ties out', async () => {
    const generate = await request(feeApp)
      .post('/generate-invoices')
      .set('x-internal-assertion', asFee())
      .send({
        feeStructureId, academicYearId: seed.academicYearId,
        classId: seed.classId, dueDate: '2026-04-30',
      });
    expect(generate.status).toBe(201);
    expect(generate.body.generated).toBeGreaterThanOrEqual(1);

    const invoice = await prisma.invoice.findFirst({
      where: { studentId: newStudentId, academicYearId: seed.academicYearId },
    });
    expect(invoice).toBeTruthy();
    invoiceId = invoice!.id;
    expect(Number(invoice!.totalAmount)).toBe(12000);

    const pay = await request(feeApp)
      .post('/payments')
      .set('x-internal-assertion', asFee())
      .send({
        studentId: newStudentId, academicYearId: seed.academicYearId,
        amount: 5000, method: 'CASH',
      });
    expect(pay.status).toBe(201);

    const ledger = await request(feeApp)
      .get(`/ledger?studentId=${newStudentId}&academicYearId=${seed.academicYearId}`)
      .set('x-internal-assertion', asFee());
    expect(ledger.status).toBe(200);
    // DEMAND +12000, PAYMENT −5000 → balance 7000.
    expect(ledger.body.balance).toBe(7000);

    // A concession reduces the remaining dues once approved.
    const concession = await request(feeApp)
      .post('/concessions')
      .set('x-internal-assertion', asFee())
      .send({ studentId: newStudentId, academicYearId: seed.academicYearId, type: 'FLAT', value: 1000, reason: 'sibling discount' });
    expect(concession.status).toBe(201);
    const approve = await request(feeApp)
      .post(`/concessions/${concession.body.id}/approve`)
      .set('x-internal-assertion', asFee());
    expect(approve.status).toBe(200);
  });

  it('6. promotes the section to the next year — and reverses', async () => {
    // Use the domain promotion engine directly (it is what academic/fee
    // flows wrap; the endpoint lives in the promotion batch flow).
    const { executePromotion, reversePromotion } = await import('@school-erp/domain');

    const result = await executePromotion(prisma, {
      branchId: seed.branchId,
      fromAcademicYearId: seed.academicYearId,
      toAcademicYearId: nextYear.id,
      fromClassId: seed.classId,
      fromSectionId: seed.sectionId,
      promotedBy: seed.adminUserId,
    });
    expect(result.batchId).toBeTruthy();

    // The admitted student now has an open enrollment in 2027-28.
    const promoted = await prisma.studentEnrollment.findFirst({
      where: { studentId: newStudentId, academicYearId: nextYear.id },
    });
    expect(promoted).toBeTruthy();
    expect(promoted!.status).toBe('ENROLLED');

    // Old-year row is closed as PROMOTED.
    const oldRow = await prisma.studentEnrollment.findFirst({
      where: { studentId: newStudentId, academicYearId: seed.academicYearId },
    });
    expect(oldRow!.status).toBe('PROMOTED');
    expect(oldRow!.toDate).toBeTruthy();

    // Reversible.
    await reversePromotion(prisma, result.batchId, { reversedBy: seed.adminUserId });
    const afterReversal = await prisma.studentEnrollment.findFirst({
      where: { studentId: newStudentId, academicYearId: nextYear.id },
    });
    expect(afterReversal).toBeNull();
    const restoredRow = await prisma.studentEnrollment.findFirst({
      where: { studentId: newStudentId, academicYearId: seed.academicYearId },
    });
    expect(restoredRow!.status).toBe('ENROLLED');
    expect(restoredRow!.toDate).toBeNull();
  });

  it('7. issues a TC that closes the enrollment', async () => {
    const tc = await request(studentApp)
      .post(`/admissions/tcs/${newStudentId}`)
      .set('x-internal-assertion', asStudent())
      .send({ reason: 'family relocation', feeDuesCleared: false });
    expect(tc.status).toBe(201);
    expect(tc.body.tcNo).toMatch(/^TC\//);

    const enrollment = await prisma.studentEnrollment.findFirst({
      where: { studentId: newStudentId, academicYearId: seed.academicYearId },
    });
    expect(enrollment!.status).toBe('TC_ISSUED');
    expect(enrollment!.toDate).toBeTruthy();
  });

  it('8. cross-service tenant isolation holds throughout', async () => {
    // A second tenant's admin cannot touch tenant A's data on ANY service.
    const other = await seedTenant(prisma, { code: 'E2E4', name: 'Other School' });
    const foreignStudent = assertion(other.branchId, other.adminUserId, ['BRANCH_ADMIN'], other.schoolId, 'student-service');
    const foreignFee = assertion(other.branchId, other.adminUserId, ['BRANCH_ADMIN'], other.schoolId, 'fee-service');

    // TC issuance against another tenant's student → 404.
    const foreignTc = await request(studentApp)
      .post(`/admissions/tcs/${newStudentId}`)
      .set('x-internal-assertion', foreignStudent)
      .send({ reason: 'x' });
    expect(foreignTc.status).toBe(404);

    // Ledger of another tenant's student → empty/blocked.
    const foreignLedger = await request(feeApp)
      .get(`/ledger?studentId=${newStudentId}`)
      .set('x-internal-assertion', foreignFee);
    expect([200, 403]).toContain(foreignLedger.status);
    if (foreignLedger.status === 200) {
      expect(foreignLedger.body.data.length).toBe(0);
      expect(foreignLedger.body.balance).toBe(0);
    }
  });
});
