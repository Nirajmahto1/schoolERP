// ──────────────────────────────────────────────
// GATE 2 verification (BUILD_PLAN): the five objective conditions that must
// hold before Phase 3 starts. Runs against a freshly-migrated schema
// (0000 → 0001 → 0002) with the demo seed.
//
//   1. New schema migrated; seed produces a realistic multi-branch,
//      2-academic-year school.
//   2. Reproduce a PREVIOUS year's report card and attendance percentage
//      from history.
//   3. Fee ledger balances tie out against invoices and payments for every
//      seeded student.
//   4. Promotion engine promotes a section and is reversible.
//   5. No global unique constraints remain in the tenant schema.
// ──────────────────────────────────────────────

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@school-erp/database';
import { TestDatabase } from '@school-erp/testing';
import { seedDemoTenant, gradeFor } from './demo-seed';
import { enrollmentForYear } from './enrollments';
import { previewPromotion, executePromotion, reversePromotion } from './promotion';
import { tieOut, postDemand, postPayment, reconcileStudent } from './fees';
import { attendancePercentage } from './attendance';
import { nextSequenceValue } from './sequences';

const GLOBAL_UNIQUE_FIELDS = ['admissionNo', 'isbn', 'vehicleNo', 'receiptNo', 'invoiceNo', 'employeeId'];

describe('GATE 2 — domain model redesign', () => {
  let db: TestDatabase;
  let prisma: PrismaClient;

  beforeAll(async () => {
    db = await TestDatabase.create(process.env.DATABASE_URL as string);
    prisma = db.client();
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await db.teardown();
  });

  it('2.1 migrates the new schema and seeds a realistic school', async () => {
    const seed = await seedDemoTenant(prisma, {
      code: 'G2',
      schoolName: 'Gate Two Public School',
      branches: 2,
      studentsPerBranch: 20,
      attendanceDaysPerYear: 15,
    });

    // 2 branches × 20 students, 2 enrollments per student.
    expect(seed.branchIds).toHaveLength(2);
    expect(seed.stats.students).toBe(40);
    expect(seed.stats.enrollments).toBe(80);
    expect(seed.stats.attendanceRecords).toBeGreaterThan(0);
    expect(seed.stats.examResults).toBeGreaterThan(0);
    expect(seed.stats.invoices).toBe(40 * 3);
    expect(seed.stats.ledgerEntries).toBe(40 * 3 + seed.stats.payments);

    // The migrated schema exposes the Phase-2 models.
    const [enrollments, sessions, ledger] = await Promise.all([
      prisma.studentEnrollment.count(),
      prisma.attendanceSession.count(),
      prisma.feeLedger.count(),
    ]);
    expect(enrollments).toBe(80);
    expect(sessions).toBeGreaterThan(0);
    expect(ledger).toBe(seed.stats.ledgerEntries);

    // The legacy tables are gone.
    const legacy = await prisma.$queryRaw<Array<{ tablename: string }>>`
      SELECT tablename FROM pg_tables
      WHERE schemaname = current_schema()
        AND tablename IN ('parents', 'attendances', 'fee_invoices', 'fee_items')`;
    expect(legacy).toEqual([]);
  });

  it('2.2 reproduces a previous year report card and attendance from history', async () => {
    const seed = await seedDemoTenant(prisma, {
      code: 'G2RC',
      schoolName: 'History School',
      branches: 1,
      studentsPerBranch: 20,
      attendanceDaysPerYear: 15,
    });
    const branchId = seed.branchIds[0];
    const student = await prisma.student.findFirstOrThrow({
      where: { branchId },
      select: { id: true },
    });

    // The historical enrollment — what the old live Student.classId could
    // never answer.
    const pastEnrollment = await enrollmentForYear(prisma, student.id, seed.academicYearIds.past);
    expect(pastEnrollment).not.toBeNull();
    expect(pastEnrollment!.class.name).toBeTruthy();

    // Previous year's report card: every subject has a result, grades are
    // consistent with the CBSE band, and the total is reproducible.
    const results = await prisma.examResult.findMany({
      where: {
        studentId: student.id,
        examSubject: { examination: { academicYearId: seed.academicYearIds.past } },
      },
      include: { examSubject: { include: { subject: true, examination: true } } },
    });
    expect(results.length).toBe(5);
    const total = results.reduce((sum, r) => sum + Number(r.marksObtained), 0);
    expect(total).toBeGreaterThan(0);
    for (const r of results) {
      expect(gradeFor(Number(r.marksObtained))).toBe(r.grade);
    }
    const pctTotal = Math.round((total / (results.length * 100)) * 10000) / 100;
    expect(pctTotal).toBeGreaterThan(40);

    // Previous year's attendance percentage: the denormalised summary must
    // equal a recompute over that year's raw records.
    const summaryPct = await attendancePercentage(prisma, { studentId: student.id, year: 2024 });
    expect(summaryPct).toBeGreaterThan(80);
    const records = await prisma.attendanceRecord.findMany({
      where: { studentId: student.id, session: { academicYearId: seed.academicYearIds.past } },
    });
    const attended = records.filter((r) => ['PRESENT', 'LATE', 'HALF_DAY'].includes(r.status)).length;
    const rawPct = records.length > 0 ? Math.round((attended / records.length) * 10000) / 100 : 0;
    expect(summaryPct).toBe(rawPct);
  });

  it('2.3 fee ledger balances tie out against invoices and payments for every student', async () => {
    const seed = await seedDemoTenant(prisma, {
      code: 'G2FEE',
      schoolName: 'Ledger School',
      branches: 1,
      studentsPerBranch: 20,
      attendanceDaysPerYear: 10,
    });

    const mismatches = (await tieOut(prisma, {
      branchId: seed.branchIds[0],
      academicYearId: seed.academicYearIds.current,
    })).filter((r) => Math.abs(r.difference) > 0.01);

    expect(mismatches).toEqual([]);

    // And the engine itself keeps the invariant when posting a fresh demand
    // and a partial payment.
    const student = await prisma.student.findFirstOrThrow({
      where: { branchId: seed.branchIds[0] },
      select: { id: true, branchId: true },
    });
    const tuitionHead = await prisma.feeHead.findFirstOrThrow({
      where: { branchId: seed.branchIds[0], code: 'TUITION' },
    });
    const invoice = await postDemand(prisma, {
      branchId: student.branchId,
      academicYearId: seed.academicYearIds.current,
      studentId: student.id,
      lines: [{ feeHeadId: tuitionHead.id, amount: 2000, description: 'June tuition' }],
      dueDate: new Date('2025-06-10'),
    });
    await postPayment(prisma, {
      branchId: student.branchId,
      academicYearId: seed.academicYearIds.current,
      studentId: student.id,
      amount: 800,
      method: 'UPI',
      invoiceIds: [invoice.id],
      idempotencyKey: 'gate2-idem-1',
    });
    const before = await reconcileStudent(prisma, { studentId: student.id, academicYearId: seed.academicYearIds.current });
    expect(before.difference).toBe(0);

    // A replayed idempotency key must not double-credit.
    const dup = await postPayment(prisma, {
      branchId: student.branchId,
      academicYearId: seed.academicYearIds.current,
      studentId: student.id,
      amount: 800,
      method: 'UPI',
      invoiceIds: [invoice.id],
      idempotencyKey: 'gate2-idem-1',
    });
    expect(dup.duplicate).toBe(true);
    const after = await reconcileStudent(prisma, { studentId: student.id, academicYearId: seed.academicYearIds.current });
    expect(after.difference).toBe(0);
  });

  it('2.4 the promotion engine promotes a section and is reversible', async () => {
    const seed = await seedDemoTenant(prisma, {
      code: 'G2PRO',
      schoolName: 'Promotion School',
      branches: 1,
      studentsPerBranch: 30,
      attendanceDaysPerYear: 5,
    });
    const branchId = seed.branchIds[0];

    // A future academic year + classes to promote into.
    const future = await prisma.academicYear.create({
      data: {
        name: '2026-27',
        startDate: new Date('2026-04-01'),
        endDate: new Date('2027-03-31'),
        isCurrent: false,
        branchId,
      },
    });

    const currentClasses = await prisma.class.findMany({
      where: { branchId, academicYearId: seed.academicYearIds.current },
      include: { sections: true },
      orderBy: { numericOrder: 'asc' },
    });
    const source = currentClasses[4]; // a middle class with sections
    expect(source.sections.length).toBeGreaterThan(0);

    for (const c of currentClasses) {
      await prisma.class.create({
        data: {
          name: c.name,
          numericOrder: c.numericOrder + 1,
          branchId,
          academicYearId: future.id,
          sections: { create: c.sections.map((s) => ({ name: s.name, capacity: s.capacity })) },
        },
      });
    }

    const preview = await previewPromotion(prisma, {
      branchId,
      fromAcademicYearId: seed.academicYearIds.current,
      toAcademicYearId: future.id,
      fromClassId: source.id,
      fromSectionId: source.sections[0].id,
    });
    expect(preview.promotedCount).toBeGreaterThan(0);
    expect(preview.promoted[0].toClassId).toBeTruthy();

    const result = await executePromotion(prisma, {
      branchId,
      fromAcademicYearId: seed.academicYearIds.current,
      toAcademicYearId: future.id,
      fromClassId: source.id,
      fromSectionId: source.sections[0].id,
      promotedBy: 'gate2-principal',
    });
    expect(result.batchId).toBeTruthy();
    expect(result.promotedCount).toBe(preview.promotedCount);

    // Old rows are closed, new rows exist tagged with the batch.
    const closed = await prisma.studentEnrollment.count({
      where: {
        academicYearId: seed.academicYearIds.current,
        classId: source.id,
        sectionId: source.sections[0].id,
        status: 'PROMOTED',
      },
    });
    expect(closed).toBe(preview.promotedCount);

    const opened = await prisma.studentEnrollment.count({
      where: { academicYearId: future.id, promotionBatchId: result.batchId, status: 'ENROLLED' },
    });
    expect(opened).toBe(preview.promotedCount);

    // Reversal restores everything.
    await reversePromotion(prisma, result.batchId, { reversedBy: 'gate2-principal' });
    const restored = await prisma.studentEnrollment.count({
      where: {
        academicYearId: seed.academicYearIds.current,
        classId: source.id,
        sectionId: source.sections[0].id,
        status: 'ENROLLED',
      },
    });
    expect(restored).toBe(preview.promotedCount);
    const orphaned = await prisma.studentEnrollment.count({
      where: { academicYearId: future.id, promotionBatchId: result.batchId },
    });
    expect(orphaned).toBe(0);
  });

  it('2.5 no global unique constraints remain in the tenant schema', async () => {
    const indexes = await prisma.$queryRaw<Array<{ tablename: string; indexname: string; indexdef: string }>>`
      SELECT tablename, indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = current_schema()`;

    const offenders: string[] = [];
    for (const idx of indexes) {
      if (!/CREATE UNIQUE/.test(idx.indexdef)) continue;
      for (const field of GLOBAL_UNIQUE_FIELDS) {
        if (idx.indexdef.includes(`"${field}"`) && !idx.indexdef.includes('"branchId"')) {
          offenders.push(`${idx.tablename}.${idx.indexname} (${field})`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('2.6 sequences issue gap-tolerant, formatted numbers', async () => {
    const seed = await seedDemoTenant(prisma, {
      code: 'G2SEQ',
      schoolName: 'Sequence School',
      branches: 1,
      studentsPerBranch: 5,
      attendanceDaysPerYear: 5,
    });
    const branchId = seed.branchIds[0];

    // Override the format for this branch's ADMISSION sequence.
    await prisma.sequence.update({
      where: { branchId_code: { branchId, code: 'ADMISSION' } },
      data: { format: 'DPS/{AY}/{SEQ}' },
    });
    const a = await nextSequenceValue(prisma, { branchId, code: 'ADMISSION' });
    const b = await nextSequenceValue(prisma, { branchId, code: 'ADMISSION' });
    expect(a).toMatch(/^DPS\/2025-26\/\d+$/);
    expect(Number(b.split('/')[2])).toBe(Number(a.split('/')[2]) + 1);
  });
});