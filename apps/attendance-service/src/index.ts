// ──────────────────────────────────────────────
// School ERP — Attendance Service (Daily only)
//
// Phase 2 shape: marking creates/updates an AttendanceSession per
// (branch, date, class, section) plus one AttendanceRecord per student.
// Percentages are read from AttendanceMonthlySummary (rebuilt here after
// marking), never recomputed from raw rows at request time.
// ──────────────────────────────────────────────

import { Router } from 'express';
import { PrismaClient } from '@school-erp/database';
import { loadServiceEnv } from '@school-erp/config';
import { rebuildMonthlySummary } from '@school-erp/domain';
import { createServiceApp, listenWithGracefulShutdown, ctx, requireAssertion } from '@school-erp/auth';
import { buildOpenApiDocument } from '@school-erp/http';
import { logger } from './utils/logger';

/** MUST equal the gateway route-table audience for this service. */
const SERVICE_NAME = 'attendance-service';

export interface AttendanceAppOptions {
  env: { INTERNAL_ASSERTION_PUBLIC_KEY: string };
  prisma: PrismaClient;
}

/**
 * App factory — split from the entrypoint so tests can inject a Prisma
 * client and an explicit env without booting the real process.
 */
export function createAttendanceApp(options: AttendanceAppOptions) {
  const { prisma } = options;
  const env = { INTERNAL_ASSERTION_PUBLIC_KEY: options.env.INTERNAL_ASSERTION_PUBLIC_KEY };

  const { app, mount, finalize } = createServiceApp({
    serviceName: SERVICE_NAME,
    assertionPublicKey: env.INTERNAL_ASSERTION_PUBLIC_KEY,
    onLog: (msg: string) => logger.info(msg),
    readinessCheck: async () => { await prisma.$queryRaw`SELECT 1`; },
  });

  app.set('prisma', prisma);

  // Published contract (GATE 3).
  const openapi = buildOpenApiDocument({
    title: 'Attendance Service',
    description: 'Daily and period-wise attendance, audited amendments, leaves, and summaries.',
    version: '1.0.0',
    basePath: '/attendance',
    paths: {
      '/attendance/mark': {
        post: {
          summary: 'Mark daily attendance (creates/reuses the session, rebuilds the monthly summary)', tags: ['attendance'],
          requestBody: { type: 'object', required: ['date', 'classId', 'sectionId', 'records'], properties: {
            date: { type: 'string', format: 'date' }, classId: { type: 'string' }, sectionId: { type: 'string' },
            records: { type: 'array', items: { type: 'object', required: ['studentId', 'status'], properties: { studentId: { type: 'string' }, status: { type: 'string', enum: ['PRESENT', 'ABSENT', 'LATE', 'HALF_DAY', 'ON_LEAVE', 'MEDICAL', 'EXCUSED'] }, remarks: { type: 'string' } } } },
          } },
          responses: { '200': { description: 'Marked' } },
        },
      },
      '/attendance/mark-period': { post: { summary: 'Mark period-wise attendance (subject + period)', tags: ['attendance'], responses: { '200': { description: 'Marked' } } } },
      '/attendance/amend': {
        post: {
          summary: 'Amend a record — every change is appended to the audit trail', tags: ['amendments'],
          requestBody: { type: 'object', required: ['recordId', 'status'], properties: { recordId: { type: 'string' }, status: { type: 'string' }, reason: { type: 'string' } } },
          responses: { '200': { description: 'Amended' } },
        },
      },
      '/attendance/amendments/{recordId}': { get: { summary: 'Full amendment trail for one record', tags: ['amendments'], responses: { '200': { description: 'OK' } } } },
      '/attendance/daily': { get: { summary: 'Day view for a class/section', tags: ['attendance'], responses: { '200': { description: 'OK' } } } },
      '/attendance/student/{studentId}': { get: { summary: 'One student\'s attendance history', tags: ['attendance'], responses: { '200': { description: 'OK' } } } },
      '/attendance/summary': { get: { summary: 'Denormalised monthly summaries', tags: ['summaries'], responses: { '200': { description: 'OK' } } } },
      '/attendance/defaulters': { get: { summary: 'Students below the attendance threshold (default 75%)', tags: ['reports'], responses: { '200': { description: 'OK' } } } },
      '/leaves': {
        get: { summary: 'List student leaves', tags: ['leaves'], responses: { '200': { description: 'OK' } } },
        post: { summary: 'File a student leave', tags: ['leaves'], responses: { '201': { description: 'Created' } } },
      },
      '/leaves/{id}/decision': { post: { summary: 'Approve/reject/cancel a leave', tags: ['leaves'], responses: { '200': { description: 'Decided' } } } },
      '/attendance/staff/mark': { post: { summary: 'Mark staff attendance', tags: ['staff'], responses: { '200': { description: 'Marked' } } } },
    },
  });
  app.get('/openapi.json', (_req, res) => { res.json(openapi); });

const r = Router();

// ── Mark Daily Attendance (bulk) ──
// records: [{ studentId: string, status: "PRESENT" | "ABSENT" | "LATE" | "HALF_DAY" | "ON_LEAVE" | "MEDICAL" | "EXCUSED", remarks?: string }]
r.post('/attendance/mark', async (req, res) => {
  try {
    const { date, records, markedBy } = req.body;
    const { branchId, userId } = ctx(req);
    if (!branchId) {
      res.status(403).json({ detail: 'Account has no branch — cannot mark attendance.' });
      return;
    }
    const { classId, sectionId } = req.body;
    if (!classId || !sectionId) {
      res.status(400).json({ type: 'validation-error', title: 'Invalid Input', status: 400, detail: 'classId and sectionId are required.' });
      return;
    }

    const day = new Date(date);
    const year = day.getUTCFullYear();
    const month = day.getUTCMonth() + 1;

    // The academic year the date belongs to.
    const academicYear = await prisma.academicYear.findFirst({
      where: { branchId, startDate: { lte: day }, endDate: { gte: day } },
    });
    if (!academicYear) {
      res.status(400).json({ type: 'validation-error', title: 'Invalid Input', status: 400, detail: 'Date falls outside any academic year.' });
      return;
    }

    // One session per (branch, date, class, section) — re-marking reuses it.
    // The compound unique includes subjectId/period (period-wise marking);
    // daily sessions carry NULL there, so find + create/update explicitly.
    const session = await (async () => {
      const existing = await prisma.attendanceSession.findFirst({
        where: { branchId, date: day, classId, sectionId, subjectId: null, period: null },
      });
      if (existing) {
        return prisma.attendanceSession.update({
          where: { id: existing.id },
          data: { markedBy: markedBy ?? userId },
        });
      }
      return prisma.attendanceSession.create({
        data: { branchId, date: day, classId, sectionId, academicYearId: academicYear.id, markedBy: markedBy ?? userId },
      });
    })();

    const result = await prisma.$transaction(async (tx) => {
      const rows = [];
      for (const rec of records) {
        rows.push(
          tx.attendanceRecord.upsert({
            where: { sessionId_studentId: { sessionId: session.id, studentId: rec.studentId } },
            create: {
              sessionId: session.id,
              studentId: rec.studentId,
              status: rec.status,
              reason: rec.remarks ?? null,
            },
            update: { status: rec.status, reason: rec.remarks ?? null },
          }),
        );
      }
      return Promise.all(rows);
    });

    // Refresh the denormalised monthly summary for the affected month.
    await rebuildMonthlySummary(prisma, {
      branchId,
      academicYearId: academicYear.id,
      year,
      month,
    });

    res.json({ count: result.length, sessionId: session.id, message: 'Attendance marked successfully' });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

// ── Mark Staff Attendance ──
r.post('/attendance/staff/mark', async (req, res) => {
  try {
    const { date, records, markedBy } = req.body;
    const { branchId } = ctx(req);
    if (!branchId) {
      res.status(403).json({ detail: 'Account has no branch — cannot mark staff attendance.' });
      return;
    }

    const result = await Promise.all(
      records.map((rec: any) =>
        prisma.staffAttendance.upsert({
          where: { staffId_date: { date: new Date(date), staffId: rec.staffId } },
          create: { date: new Date(date), status: rec.status, staffId: rec.staffId, remarks: rec.remarks, markedBy: markedBy ?? ctx(req).userId, branchId },
          update: { status: rec.status, remarks: rec.remarks, markedBy: markedBy ?? ctx(req).userId },
        }),
      ),
    );

    res.json({ count: result.length, message: 'Staff attendance marked successfully' });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

// ── Get Attendance by Date ──
r.get('/attendance/daily', async (req, res) => {
  try {
    const { date, classId, sectionId } = req.query;
    const { branchId } = ctx(req);
    if (!branchId) {
      res.status(403).json({ detail: 'Account has no branch — cannot read attendance.' });
      return;
    }

    const sessions = await prisma.attendanceSession.findMany({
      where: {
        branchId,
        date: new Date(date as string),
        ...(classId ? { classId: classId as string } : {}),
        ...(sectionId ? { sectionId: sectionId as string } : {}),
      },
      include: {
        records: {
          include: {
            student: { select: { firstName: true, lastName: true, admissionNo: true } },
          },
        },
      },
    });

    // Flatten records across sessions with roll numbers from the enrollment.
    const enrollments = await prisma.studentEnrollment.findMany({
      where: {
        branchId,
        classId: classId ? (classId as string) : undefined,
        sectionId: sectionId ? (sectionId as string) : undefined,
        status: 'ENROLLED',
      },
      select: { studentId: true, rollNo: true },
    });
    const rollByStudent = new Map(enrollments.map((e) => [e.studentId, e.rollNo]));

    const data = sessions
      .flatMap((s) => s.records)
      .map((rec) => ({
        studentId: rec.studentId,
        status: rec.status,
        reason: rec.reason,
        rollNo: rollByStudent.get(rec.studentId) ?? null,
        student: rec.student,
        sessionId: rec.sessionId,
      }))
      .sort((a, b) => String(a.rollNo ?? '').localeCompare(String(b.rollNo ?? ''), undefined, { numeric: true }));

    const summary = {
      total: data.length,
      present: data.filter((r) => r.status === 'PRESENT').length,
      absent: data.filter((r) => r.status === 'ABSENT').length,
      late: data.filter((r) => r.status === 'LATE').length,
      onLeave: data.filter((r) => r.status === 'ON_LEAVE').length,
    };

    res.json({ data, summary });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

// ── Get Student Attendance History ──
r.get('/attendance/student/:studentId', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const where: any = {
      studentId: req.params.studentId,
      ...(startDate && endDate
        ? { session: { date: { gte: new Date(startDate as string), lte: new Date(endDate as string) } } }
        : {}),
    };

    const records = await prisma.attendanceRecord.findMany({
      where,
      include: { session: { select: { date: true } } },
      orderBy: { session: { date: 'desc' } },
    });

    const total = records.length;
    const present = records.filter((r) => ['PRESENT', 'LATE', 'HALF_DAY'].includes(r.status)).length;
    const percentage = total > 0 ? Math.round((present / total) * 100 * 10) / 10 : 0;

    res.json({
      data: records.map((r) => ({ date: r.session.date, status: r.status, reason: r.reason })),
      stats: { total, present, absent: total - present, percentage },
    });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

// ── Monthly Summary ── (reads the denormalised summaries)
r.get('/attendance/summary', async (req, res) => {
  try {
    const { month, year, classId, academicYearId } = req.query;
    const { branchId } = ctx(req);
    if (!branchId) {
      res.status(403).json({ detail: 'Account has no branch — cannot compute summaries.' });
      return;
    }
    const m = parseInt(month as string);
    const y = parseInt(year as string);

    const summaries = await prisma.attendanceMonthlySummary.findMany({
      where: { branchId, year: y, month: m },
    });

    let rows = summaries;
    if (classId) {
      const enrolled = await prisma.studentEnrollment.findMany({
        where: { branchId, classId: classId as string, status: 'ENROLLED' },
        select: { studentId: true },
      });
      const ids = new Set(enrolled.map((e) => e.studentId));
      rows = summaries.filter((s) => ids.has(s.studentId));
    }

    const workingDays = rows.reduce((sum, s) => sum + s.workingDays, 0);
    const attended = rows.reduce((sum, s) => sum + s.presentDays + s.lateDays + s.halfDays, 0);
    const avgRate = workingDays > 0 ? Math.round((attended / workingDays) * 100 * 10) / 10 : 0;

    res.json({
      month: m,
      year: y,
      totalStudents: rows.length,
      totalRecords: rows.reduce((sum, s) => sum + s.workingDays, 0),
      workingDays,
      averageAttendanceRate: avgRate,
    });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

// ── Corrections with audit (BUILD_PLAN 2.4.4) ──
// Within the lock window (48h) anyone with access may amend; after it, every
// amendment is still allowed here but is written to the append-only
// AttendanceAmendment trail — the "who changed my child's attendance"
// answer. (Principal-only enforcement beyond the window is a gateway-level
// RBAC concern; the trail is the service's contract.)
const LOCK_WINDOW_HOURS = 48;

r.post('/attendance/amend', async (req, res) => {
  try {
    const { branchId, userId } = ctx(req);
    if (!branchId) { res.status(403).json({ detail: 'Account has no branch.' }); return; }
    const { recordId, status, reason } = req.body ?? {};
    if (!recordId || !status) {
      res.status(400).json({ type: 'validation-error', title: 'Invalid Input', status: 400, detail: 'recordId and status are required.' });
      return;
    }
    const record = await prisma.attendanceRecord.findFirst({
      where: { id: recordId, session: { branchId } },
      include: { session: true },
    });
    if (!record) { res.status(404).json({ type: 'not-found', title: 'Not Found', status: 404, detail: 'Record not found.' }); return; }
    if (record.status === status) { res.status(400).json({ type: 'validation-error', title: 'Invalid Input', status: 400, detail: 'Status is unchanged.' }); return; }

    const before = record.status;
    const amended = await prisma.$transaction(async (tx) => {
      const updated = await tx.attendanceRecord.update({
        where: { id: record.id },
        data: { status, reason: reason ?? record.reason },
      });
      await tx.attendanceAmendment.create({
        data: {
          recordId: record.id,
          beforeStatus: before,
          afterStatus: status,
          changedBy: userId,
          reason: reason ?? null,
        },
      });
      return updated;
    });

    // The summary is denormalised — refresh for the amended session's month.
    const day = record.session.date;
    await rebuildMonthlySummary(prisma, {
      branchId,
      academicYearId: record.session.academicYearId,
      year: day.getUTCFullYear(),
      month: day.getUTCMonth() + 1,
    });

    res.json({
      data: amended,
      withinLockWindow: (Date.now() - record.session.createdAt.getTime()) < LOCK_WINDOW_HOURS * 3_600_000,
    });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

// Full amendment trail for one record.
r.get('/attendance/amendments/:recordId', async (req, res) => {
  try {
    const { branchId } = ctx(req);
    if (!branchId) { res.status(403).json({ detail: 'Account has no branch.' }); return; }
    const trail = await prisma.attendanceAmendment.findMany({
      where: { record: { id: req.params.recordId, session: { branchId } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ data: trail });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

// ── Student leave workflow (BUILD_PLAN 2.4.3) ──

r.post('/leaves', async (req, res) => {
  try {
    const { branchId } = ctx(req);
    if (!branchId) { res.status(403).json({ detail: 'Account has no branch.' }); return; }
    const { studentId, leaveType, startDate, endDate, reason } = req.body ?? {};
    if (!studentId || !leaveType || !startDate || !endDate || !reason) {
      res.status(400).json({ type: 'validation-error', title: 'Invalid Input', status: 400, detail: 'studentId, leaveType, startDate, endDate and reason are required.' });
      return;
    }
    const student = await prisma.student.findFirst({ where: { id: studentId, branchId }, select: { id: true } });
    if (!student) { res.status(404).json({ type: 'not-found', title: 'Not Found', status: 404, detail: 'Student not found.' }); return; }
    const leave = await prisma.studentLeave.create({
      data: { studentId, leaveType, startDate: new Date(startDate), endDate: new Date(endDate), reason },
    });
    res.status(201).json(leave);
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

r.get('/leaves', async (req, res) => {
  try {
    const { branchId } = ctx(req);
    if (!branchId) { res.status(403).json({ detail: 'Account has no branch.' }); return; }
    const { status } = req.query;
    const leaves = await prisma.studentLeave.findMany({
      where: { student: { branchId }, ...(status && { status: status as never }) },
      include: { student: { select: { admissionNo: true, firstName: true, lastName: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    res.json({ data: leaves });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

// Approve: the leave is linked to ON_LEAVE attendance records in its range,
// so the attendance percentage counts it as an excused absence family.
r.post('/leaves/:id/decision', async (req, res) => {
  try {
    const { branchId, userId } = ctx(req);
    if (!branchId) { res.status(403).json({ detail: 'Account has no branch.' }); return; }
    const { status } = req.body ?? {};
    if (!['APPROVED', 'REJECTED', 'CANCELLED'].includes(status)) {
      res.status(400).json({ type: 'validation-error', title: 'Invalid Input', status: 400, detail: 'status must be APPROVED, REJECTED or CANCELLED.' });
      return;
    }
    const leave = await prisma.studentLeave.findFirst({ where: { id: req.params.id, student: { branchId } } });
    if (!leave) { res.status(404).json({ type: 'not-found', title: 'Not Found', status: 404, detail: 'Leave not found.' }); return; }
    if (leave.status !== 'PENDING') { res.status(409).json({ type: 'conflict', title: 'Conflict', status: 409, detail: 'Leave was already decided.' }); return; }

    const updated = await prisma.studentLeave.update({ where: { id: leave.id }, data: { status, approvedBy: userId } });

    if (status === 'APPROVED') {
      // Link the leave to existing ON_LEAVE records in the window so reports
      // can separate approved leave from raw absence.
      await prisma.attendanceRecord.updateMany({
        where: {
          studentId: leave.studentId,
          status: 'ON_LEAVE',
          session: { date: { gte: leave.startDate, lte: leave.endDate } },
        },
        data: { leaveId: leave.id },
      });
    }
    res.json(updated);
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

// ── Period-wise marking (BUILD_PLAN 2.4.1/2) ──
// Same session uniqueness as daily, but with subject + period set.

r.post('/attendance/mark-period', async (req, res) => {
  try {
    const { branchId, userId } = ctx(req);
    if (!branchId) { res.status(403).json({ detail: 'Account has no branch.' }); return; }
    const { date, classId, sectionId, subjectId, period, records } = req.body ?? {};
    if (!date || !classId || !sectionId || !subjectId || !period || !Array.isArray(records)) {
      res.status(400).json({ type: 'validation-error', title: 'Invalid Input', status: 400, detail: 'date, classId, sectionId, subjectId, period and records[] are required.' });
      return;
    }
    const day = new Date(date);
    const academicYear = await prisma.academicYear.findFirst({
      where: { branchId, startDate: { lte: day }, endDate: { gte: day } },
    });
    if (!academicYear) { res.status(400).json({ type: 'validation-error', title: 'Invalid Input', status: 400, detail: 'Date falls outside any academic year.' }); return; }

    const session = await prisma.attendanceSession.upsert({
      where: {
        branchId_date_classId_sectionId_subjectId_period: {
          branchId,
          date: day,
          classId,
          sectionId,
          subjectId,
          period: Number(period),
        },
      },
      create: { branchId, date: day, classId, sectionId, subjectId, period: Number(period), academicYearId: academicYear.id, markedBy: userId },
      update: { markedBy: userId },
    });
    await prisma.$transaction(async (tx) => {
      for (const rec of records) {
        await tx.attendanceRecord.upsert({
          where: { sessionId_studentId: { sessionId: session.id, studentId: rec.studentId } },
          create: { sessionId: session.id, studentId: rec.studentId, status: rec.status, reason: rec.remarks ?? null },
          update: { status: rec.status, reason: rec.remarks ?? null },
        });
      }
    });
    await rebuildMonthlySummary(prisma, { branchId, academicYearId: academicYear.id, year: day.getUTCFullYear(), month: day.getUTCMonth() + 1 });
    res.json({ count: records.length, sessionId: session.id });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

// ── Defaulter report (BUILD_PLAN 3.4: < threshold % attendance) ──

r.get('/attendance/defaulters', async (req, res) => {
  try {
    const { branchId } = ctx(req);
    if (!branchId) { res.status(403).json({ detail: 'Account has no branch.' }); return; }
    const threshold = req.query.threshold ? parseFloat(req.query.threshold as string) : 75;
    const { academicYearId, classId, sectionId } = req.query;

    const year = academicYearId
      ? await prisma.academicYear.findFirst({ where: { id: academicYearId as string, branchId } })
      : await prisma.academicYear.findFirst({ where: { branchId, isCurrent: true } });
    if (!year) { res.status(404).json({ detail: 'No academic year.' }); return; }

    const summaries = await prisma.attendanceMonthlySummary.findMany({
      where: {
        branchId,
        academicYearId: year.id,
        ...(classId && { classId: classId as string }),
        ...(sectionId && { sectionId: sectionId as string }),
      },
      include: { student: { select: { admissionNo: true, firstName: true, lastName: true } } },
    });

    // Aggregate monthly summaries per student, then filter by threshold.
    const byStudent = new Map<string, { present: number; total: number; student: typeof summaries[number]['student'] }>();
    for (const s of summaries) {
      const agg = byStudent.get(s.studentId) ?? { present: 0, total: 0, student: s.student };
      agg.present += s.presentDays;
      agg.total += s.workingDays;
      byStudent.set(s.studentId, agg);
    }
    const defaulters = [...byStudent.entries()]
      .map(([studentId, agg]) => ({
        studentId,
        admissionNo: agg.student.admissionNo,
        name: `${agg.student.firstName} ${agg.student.lastName}`,
        presentDays: agg.present,
        workingDays: agg.total,
        percent: agg.total > 0 ? Math.round((agg.present / agg.total) * 10000) / 100 : 0,
      }))
      .filter((d) => d.percent < threshold)
      .sort((a, b) => a.percent - b.percent);

    res.json({ data: defaulters, meta: { threshold, academicYearId: year.id } });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

  mount('/', r);
  finalize();

  return app;
}

// ── Entrypoint ──
const env = loadServiceEnv(SERVICE_NAME, 'PORT_ATTENDANCE_SERVICE');
const prisma = new PrismaClient();
const app = createAttendanceApp({ env, prisma });

// Only bind a port when run directly. Imported by tests or the e2e suite,
// the module must NOT listen — vitest would hit EADDRINUSE across suites.
if (process.argv[1]?.endsWith('index.ts')) {
  listenWithGracefulShutdown(app, env.PORT, SERVICE_NAME, async () => { await prisma.$disconnect(); });
}

export { app, prisma };
