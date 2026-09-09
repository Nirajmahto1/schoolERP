// ──────────────────────────────────────────────
// Attendance engine (BUILD_PLAN 2.4)
//
// One session = one marking pass (daily, or period-wise with subject+period).
// Records hang off the session. After a session is locked (e.g. 48h window),
// only a principal can amend and every amendment is logged with before/after.
// Percentages are read from the denormalised AttendanceMonthlySummary, never
// computed by scanning raw rows at request time.
// ──────────────────────────────────────────────

import type { PrismaClient } from '@school-erp/database';
import type { AttendanceStatus } from '@prisma/client';

export interface MarkAttendanceInput {
  branchId: string;
  academicYearId: string;
  date: Date;
  classId: string;
  sectionId: string;
  markedBy: string;
  subjectId?: string | null;
  period?: number | null;
  records: Array<{
    studentId: string;
    status: AttendanceStatus;
    reason?: string | null;
    leaveId?: string | null;
  }>;
}

/**
 * Find or create the session for a marking pass, then upsert the records.
 * The unique index treats NULL subject/period as distinct, so daily-session
 * uniqueness for (branch, date, class, section) is enforced here in app code.
 */
export async function markAttendance(prisma: PrismaClient, input: MarkAttendanceInput) {
  return prisma.$transaction(async (tx) => {
    let session = await tx.attendanceSession.findFirst({
      where: {
        branchId: input.branchId,
        date: input.date,
        classId: input.classId,
        sectionId: input.sectionId,
        subjectId: input.subjectId ?? null,
        period: input.period ?? null,
      },
    });

    if (!session) {
      session = await tx.attendanceSession.create({
        data: {
          branchId: input.branchId,
          date: input.date,
          classId: input.classId,
          sectionId: input.sectionId,
          academicYearId: input.academicYearId,
          subjectId: input.subjectId ?? null,
          period: input.period ?? null,
          markedBy: input.markedBy,
        },
      });
    } else if (session.lockedAt) {
      throw new Error('Attendance session is locked — only a principal can amend it.');
    }

    for (const r of input.records) {
      await tx.attendanceRecord.upsert({
        where: {
          sessionId_studentId: { sessionId: session!.id, studentId: r.studentId },
        },
        create: {
          sessionId: session!.id,
          studentId: r.studentId,
          status: r.status,
          reason: r.reason ?? null,
          leaveId: r.leaveId ?? null,
        },
        update: { status: r.status, reason: r.reason ?? null, leaveId: r.leaveId ?? null },
      });
    }

    return tx.attendanceSession.findUniqueOrThrow({
      where: { id: session.id },
      include: { records: true },
    });
  });
}

export interface AmendAttendanceInput {
  recordId: string;
  newStatus: AttendanceStatus;
  changedBy: string;
  /** The caller's role — only PRINCIPAL may amend a locked session. */
  actorRole?: string;
  reason?: string | null;
}

/**
 * Amend a record with an audit trail (2.4.4). Locked sessions require a
 * principal; every change is logged in attendance_amendments before/after.
 */
export async function amendAttendance(prisma: PrismaClient, input: AmendAttendanceInput) {
  return prisma.$transaction(async (tx) => {
    const record = await tx.attendanceRecord.findUnique({
      where: { id: input.recordId },
      include: { session: true },
    });
    if (!record) throw new Error(`Attendance record ${input.recordId} not found.`);

    if (record.session.lockedAt && input.actorRole !== 'PRINCIPAL') {
      throw new Error('Attendance session is locked — only a principal can amend it.');
    }

    await tx.attendanceAmendment.create({
      data: {
        recordId: record.id,
        beforeStatus: record.status,
        afterStatus: input.newStatus,
        changedBy: input.changedBy,
        reason: input.reason ?? null,
      },
    });

    return tx.attendanceRecord.update({
      where: { id: record.id },
      data: { status: input.newStatus, reason: input.reason ?? record.reason },
    });
  });
}

/** Lock a session against further edits (the 48h window close, 2.4.4). */
export async function lockSession(prisma: PrismaClient, sessionId: string, lockedBy: string) {
  return prisma.attendanceSession.update({
    where: { id: sessionId },
    data: { lockedAt: new Date() },
  });
}

export interface WorkingDaysInput {
  branchId: string;
  from: Date;
  to: Date;
}

/**
 * Working days in a range: weekdays minus branch holidays and non-working
 * calendar entries (2.2.5 — attendance percentage is meaningless without it).
 */
export async function workingDays(prisma: PrismaClient, input: WorkingDaysInput): Promise<number> {
  const [holidays, nonWorking] = await Promise.all([
    prisma.holiday.findMany({
      where: {
        branchId: input.branchId,
        date: { gte: input.from, lte: input.to },
      },
      select: { date: true },
    }),
    prisma.academicCalendar.findMany({
      where: {
        branchId: input.branchId,
        date: { gte: input.from, lte: input.to },
        isWorkingDay: false,
      },
      select: { date: true },
    }),
  ]);
  const off = new Set<string>([
    ...holidays.map((h) => h.date.toISOString().slice(0, 10)),
    ...nonWorking.map((c) => c.date.toISOString().slice(0, 10)),
  ]);

  let count = 0;
  for (let d = new Date(input.from); d <= input.to; d.setDate(d.getDate() + 1)) {
    const day = d.getDay();
    if (day === 0 || day === 6) continue;
    if (off.has(d.toISOString().slice(0, 10))) continue;
    count++;
  }
  return count;
}

export interface RebuildSummaryInput {
  branchId: string;
  academicYearId: string;
  year: number;
  month: number; // 1-12
}

/**
 * Rebuild the denormalised monthly summary for one branch/month (2.4.6).
 * Never compute a term's percentage by scanning raw rows at request time.
 */
export async function rebuildMonthlySummary(prisma: PrismaClient, input: RebuildSummaryInput) {
  const { branchId, academicYearId, year, month } = input;
  const from = new Date(Date.UTC(year, month - 1, 1));
  const to = new Date(Date.UTC(year, month, 0));
  const workDays = await workingDays(prisma, { branchId, from, to });

  const enrollments = await prisma.studentEnrollment.findMany({
    where: { branchId, academicYearId, status: 'ENROLLED' },
    select: { studentId: true },
  });

  const rows = [];
  for (const { studentId } of enrollments) {
    const records = await prisma.attendanceRecord.findMany({
      where: {
        studentId,
        session: {
          branchId,
          date: { gte: from, lte: to },
        },
      },
      include: { session: { select: { date: true } } },
    });

    const counts = {
      presentDays: 0,
      absentDays: 0,
      lateDays: 0,
      halfDays: 0,
      leaveDays: 0,
      medicalDays: 0,
      excusedDays: 0,
    };
    for (const r of records) {
      switch (r.status) {
        case 'PRESENT': counts.presentDays++; break;
        case 'ABSENT': counts.absentDays++; break;
        case 'LATE': counts.lateDays++; break;
        case 'HALF_DAY': counts.halfDays++; break;
        case 'ON_LEAVE': counts.leaveDays++; break;
        case 'MEDICAL': counts.medicalDays++; break;
        case 'EXCUSED': counts.excusedDays++; break;
      }
    }

    const attended = counts.presentDays + counts.halfDays + counts.lateDays;
    const percentage = workDays > 0 ? Math.round((attended / workDays) * 10000) / 100 : 0;

    rows.push({
      studentId,
      branchId,
      academicYearId,
      year,
      month,
      workingDays: workDays,
      ...counts,
      percentage,
      rebuiltAt: new Date(),
    });
  }

  // Upsert in chunks.
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    await Promise.all(
      chunk.map((row) =>
        prisma.attendanceMonthlySummary.upsert({
          where: { studentId_year_month: { studentId: row.studentId, year, month } },
          update: { ...row },
          create: row,
        }),
      ),
    );
  }
  return { students: rows.length, workingDays: workDays };
}

export interface PercentageInput {
  studentId: string;
  year: number;
  month?: number;
}

/**
 * Attendance percentage from the denormalised summary (never raw rows).
 */
export async function attendancePercentage(prisma: PrismaClient, input: PercentageInput): Promise<number> {
  const summaries = await prisma.attendanceMonthlySummary.findMany({
    where: {
      studentId: input.studentId,
      year: input.year,
      ...(input.month ? { month: input.month } : {}),
    },
  });
  if (summaries.length === 0) return 0;
  const totalDays = summaries.reduce((sum, s) => sum + s.workingDays, 0);
  const attended = summaries.reduce(
    (sum, s) => sum + s.presentDays + s.halfDays + s.lateDays,
    0,
  );
  return totalDays > 0 ? Math.round((attended / totalDays) * 10000) / 100 : 0;
}