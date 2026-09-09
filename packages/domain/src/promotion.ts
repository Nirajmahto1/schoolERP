// ──────────────────────────────────────────────
// Promotion engine (BUILD_PLAN 2.2.2)
//
// Every Indian school promotes a whole section every March. This engine makes
// that preview → confirm → reversible:
//
//   previewPromotion  — read-only plan: which students move to which class,
//                       who is being detained, next roll numbers.
//   executePromotion  — one transaction: create a PromotionBatch, close the
//                       old-year enrollments (status → PROMOTED/DETAINED),
//                       open the next-year enrollments, tag everything with
//                       the batch id.
//   reversePromotion  — delete the next-year rows and restore the old-year
//                       rows exactly as they were. Roll numbers are not
//                       reclaimed (sequences are gap-tolerant by design).
// ──────────────────────────────────────────────

import type { PrismaClient } from '@school-erp/database';
import type { EnrollmentStatus } from '@prisma/client';

export interface PromotionTarget {
  /** Explicit next-year class id; defaults to the next class by numericOrder. */
  classId?: string;
  /** Explicit next-year section id; defaults to the same section name. */
  sectionId?: string;
  /** Students who are detained this year (no next-year row, status DETAINED). */
  detainedStudentIds?: string[];
}

export interface PreviewPromotionInput {
  branchId: string;
  fromAcademicYearId: string;
  toAcademicYearId: string;
  /** The class whose ENROLLED students are being promoted. */
  fromClassId: string;
  /** Optional: only one section of the class. */
  fromSectionId?: string;
  detainedStudentIds?: string[];
}

export interface PromotionItem {
  studentId: string;
  admissionNo: string;
  studentName: string;
  fromEnrollmentId: string;
  fromClassId: string;
  fromClassName: string;
  fromSectionName: string;
  fromRollNo: string | null;
  toClassId: string | null; // null when detained
  toClassName: string | null;
  toSectionId: string | null;
  toRollNo: string | null;
  detained: boolean;
}

export interface PromotionPreview {
  branchId: string;
  fromAcademicYearId: string;
  toAcademicYearId: string;
  fromClassId: string;
  promoted: PromotionItem[];
  detained: PromotionItem[];
  promotedCount: number;
  detainedCount: number;
  /** Next class each student would move to, keyed by class id. */
  nextClassMap: Record<string, string>;
}

/**
 * Read-only plan. Uses `peekSequenceValue` for roll numbers so the preview
 * shows exactly what confirm would issue, without consuming anything.
 */
export async function previewPromotion(
  prisma: PrismaClient,
  input: PreviewPromotionInput,
): Promise<PromotionPreview> {
  const { branchId, fromAcademicYearId, toAcademicYearId, fromClassId } = input;

  const fromClass = await prisma.class.findUnique({
    where: { id: fromClassId },
    include: { sections: true },
  });
  if (!fromClass) throw new Error(`Class ${fromClassId} not found.`);

  // Next class by numericOrder in the target year.
  const nextClass = await prisma.class.findFirst({
    where: { branchId, academicYearId: toAcademicYearId, numericOrder: fromClass.numericOrder + 1 },
    include: { sections: true },
  });

  const enrollments = await prisma.studentEnrollment.findMany({
    where: {
      branchId,
      academicYearId: fromAcademicYearId,
      classId: fromClassId,
      ...(input.fromSectionId ? { sectionId: input.fromSectionId } : {}),
      status: 'ENROLLED',
      student: { isActive: true, deletedAt: null },
    },
    include: {
      section: true,
      student: { select: { admissionNo: true, firstName: true, lastName: true } },
    },
    orderBy: [{ section: { name: 'asc' } }, { rollNo: 'asc' }],
  });

  const detainedSet = new Set(input.detainedStudentIds ?? []);
  const nextClassMap: Record<string, string> = { [fromClassId]: nextClass?.id ?? '' };

  const items: PromotionItem[] = [];
  for (const e of enrollments) {
    const detained = detainedSet.has(e.studentId);
    let toClassId: string | null = null;
    let toSectionId: string | null = null;
    let toRollNo: string | null = null;

    if (!detained && nextClass) {
      const targetSection =
        nextClass.sections.find((s) => s.name === e.section.name) ?? nextClass.sections[0] ?? null;
      toClassId = nextClass.id;
      toSectionId = targetSection?.id ?? null;
      // Next roll number in the target section.
      if (targetSection) {
        const last = await prisma.studentEnrollment.findFirst({
          where: { academicYearId: toAcademicYearId, classId: nextClass.id, sectionId: targetSection.id },
          orderBy: { rollNo: 'desc' },
          select: { rollNo: true },
        });
        const lastNo = last?.rollNo ? parseInt(last.rollNo.replace(/\D/g, ''), 10) || 0 : 0;
        toRollNo = String(lastNo + 1);
      }
    }

    items.push({
      studentId: e.studentId,
      admissionNo: e.student.admissionNo,
      studentName: `${e.student.firstName} ${e.student.lastName}`,
      fromEnrollmentId: e.id,
      fromClassId,
      fromClassName: fromClass.name,
      fromSectionName: e.section.name,
      fromRollNo: e.rollNo,
      toClassId,
      toClassName: nextClass?.name ?? null,
      toSectionId,
      toRollNo,
      detained,
    });
  }

  const promoted = items.filter((i) => !i.detained);
  return {
    branchId,
    fromAcademicYearId,
    toAcademicYearId,
    fromClassId,
    promoted,
    detained: items.filter((i) => i.detained),
    promotedCount: promoted.length,
    detainedCount: items.length - promoted.length,
    nextClassMap,
  };
}

export interface ExecutePromotionInput extends PreviewPromotionInput {
  promotedBy?: string | null;
}

export interface PromotionResult {
  batchId: string;
  promotedCount: number;
  detainedCount: number;
  items: PromotionItem[];
}

/**
 * Confirm the preview: creates the batch, closes the old enrollments and
 * opens the new ones — all in one transaction.
 */
export async function executePromotion(
  prisma: PrismaClient,
  input: ExecutePromotionInput,
): Promise<PromotionResult> {
  const preview = await previewPromotion(prisma, input);

  const fromYear = await prisma.academicYear.findUnique({ where: { id: input.fromAcademicYearId } });
  const toYear = await prisma.academicYear.findUnique({ where: { id: input.toAcademicYearId } });
  if (!fromYear || !toYear) throw new Error('Academic year not found.');

  const batchId = await prisma.$transaction(async (tx) => {
    const batch = await tx.promotionBatch.create({
      data: {
        branchId: input.branchId,
        fromAcademicYearId: input.fromAcademicYearId,
        toAcademicYearId: input.toAcademicYearId,
        classId: input.fromClassId,
        sectionId: input.fromSectionId ?? null,
        stats: {
          promoted: preview.promotedCount,
          detained: preview.detainedCount,
          promotedAt: new Date().toISOString(),
        },
        createdBy: input.promotedBy ?? null,
      },
    });

    // Close the old-year rows.
    const allItems = [...preview.promoted, ...preview.detained];
    for (const item of allItems) {
      const status: EnrollmentStatus = item.detained ? 'DETAINED' : 'PROMOTED';
      await tx.studentEnrollment.update({
        where: { id: item.fromEnrollmentId },
        data: {
          status,
          toDate: fromYear.endDate,
          promotionBatchId: batch.id,
        },
      });
    }

    // Open the new-year rows.
    for (const item of preview.promoted) {
      if (!item.toClassId || !item.toSectionId) continue;
      await tx.studentEnrollment.create({
        data: {
          studentId: item.studentId,
          branchId: input.branchId,
          academicYearId: input.toAcademicYearId,
          classId: item.toClassId,
          sectionId: item.toSectionId,
          rollNo: item.toRollNo,
          status: 'ENROLLED',
          fromDate: toYear.startDate,
          promotionBatchId: batch.id,
          createdBy: input.promotedBy ?? null,
        },
      });
    }

    return batch.id;
  });

  return {
    batchId,
    promotedCount: preview.promotedCount,
    detainedCount: preview.detainedCount,
    items: [...preview.promoted, ...preview.detained],
  };
}

/**
 * Reversible batch: delete the next-year rows created by the batch and
 * restore the old-year rows to ENROLLED exactly as they were.
 */
export async function reversePromotion(
  prisma: PrismaClient,
  batchId: string,
  options: { reversedBy?: string | null } = {},
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const batch = await tx.promotionBatch.findUnique({ where: { id: batchId } });
    if (!batch) throw new Error(`Promotion batch ${batchId} not found.`);
    if (batch.status === 'REVERSED') {
      throw new Error(`Promotion batch ${batchId} is already reversed.`);
    }

    // Remove only the next-year enrollments this batch created. (Old-year
    // rows carry the same batch tag — they must be restored, not deleted.)
    await tx.studentEnrollment.deleteMany({
      where: { promotionBatchId: batchId, academicYearId: batch.toAcademicYearId },
    });

    // Restore the closed old-year rows.
    await tx.studentEnrollment.updateMany({
      where: { promotionBatchId: batchId, academicYearId: batch.fromAcademicYearId },
      data: { status: 'ENROLLED', toDate: null },
    });

    await tx.promotionBatch.update({
      where: { id: batchId },
      data: {
        status: 'REVERSED',
        reversedAt: new Date(),
        reversedBy: options.reversedBy ?? null,
        stats: { ...(batch.stats as Record<string, unknown>), reversedAt: new Date().toISOString() },
      },
    });
  });
}