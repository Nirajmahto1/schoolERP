// ──────────────────────────────────────────────
// Enrollment helpers (BUILD_PLAN 2.2.1)
//
// Everything — attendance, report cards, fees, TCs — hangs off the enrollment,
// never the student row. The invariant enforced here: exactly one enrollment
// row per (studentId, academicYearId). Promotion CLOSES the old row (status →
// PROMOTED, toDate set) and opens a new one for the next year.
// ──────────────────────────────────────────────

import type { PrismaClient } from '@school-erp/database';
import type { EnrollmentStatus } from '@prisma/client';

export interface EnrollStudentInput {
  studentId: string;
  branchId: string;
  academicYearId: string;
  classId: string;
  sectionId: string;
  rollNo?: string | null;
  fromDate: Date;
  status?: EnrollmentStatus;
  createdBy?: string | null;
}

/**
 * Create a student's enrollment for an academic year. Throws if the student
 * already has a row for that year (the caller must close the previous row
 * first — e.g. via the promotion engine).
 */
export async function enrollStudent(
  prisma: PrismaClient,
  input: EnrollStudentInput,
) {
  const existing = await prisma.studentEnrollment.findUnique({
    where: {
      studentId_academicYearId: {
        studentId: input.studentId,
        academicYearId: input.academicYearId,
      },
    },
    select: { id: true },
  });
  if (existing) {
    throw new Error(
      `Student ${input.studentId} already has an enrollment for academic year ${input.academicYearId}. ` +
        'Close the previous row (promotion / status change) before re-enrolling.',
    );
  }
  return prisma.studentEnrollment.create({
    data: {
      studentId: input.studentId,
      branchId: input.branchId,
      academicYearId: input.academicYearId,
      classId: input.classId,
      sectionId: input.sectionId,
      rollNo: input.rollNo ?? null,
      status: input.status ?? 'ENROLLED',
      fromDate: input.fromDate,
      createdBy: input.createdBy ?? null,
    },
  });
}

export interface CurrentEnrollmentOptions {
  /** Defaults to the tenant's current academic year. */
  academicYearId?: string;
  /** Only return ENROLLED rows (excludes PROMOTED/DETAINED/LEFT). */
  activeOnly?: boolean;
}

/**
 * The student's live enrollment. `activeOnly` defaults to true: a student
 * whose row was closed by promotion has no "current" enrollment.
 */
export async function currentEnrollment(
  prisma: PrismaClient,
  studentId: string,
  options: CurrentEnrollmentOptions = {},
) {
  const academicYearId =
    options.academicYearId ??
    (
      await prisma.academicYear.findFirst({
        where: { isCurrent: true },
        orderBy: { startDate: 'desc' },
        select: { id: true },
      })
    )?.id;

  if (!academicYearId) return null;

  return prisma.studentEnrollment.findFirst({
    where: {
      studentId,
      academicYearId,
      ...(options.activeOnly === false ? {} : { status: 'ENROLLED' }),
    },
    include: { class: true, section: true, academicYear: true },
  });
}

/**
 * The class/section a student attended in a given academic year — the
 * historical answer that the old live `Student.classId` pointer could never
 * give (BUILD_PLAN 2.2 / GATE 2 "reproduce the previous year").
 */
export async function enrollmentForYear(
  prisma: PrismaClient,
  studentId: string,
  academicYearId: string,
) {
  return prisma.studentEnrollment.findUnique({
    where: {
      studentId_academicYearId: { studentId, academicYearId },
    },
    include: { class: true, section: true },
  });
}