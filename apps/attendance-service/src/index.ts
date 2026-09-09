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
import { createServiceApp, listenWithGracefulShutdown, ctx } from '@school-erp/auth';
import { logger } from './utils/logger';

const SERVICE_NAME = 'attendance-service';
const env = loadServiceEnv(SERVICE_NAME, 'PORT_ATTENDANCE_SERVICE');
const prisma = new PrismaClient();

// No CORS, no dotenv, no per-service port fallback. Configuration comes from
// @school-erp/config (missing var = crash at boot), and every non-health route
// is gated behind a gateway-signed, audience-bound assertion (GATE 0).
const { app, mount, finalize } = createServiceApp({
  serviceName: SERVICE_NAME,
  assertionPublicKey: env.INTERNAL_ASSERTION_PUBLIC_KEY,
  onLog: (msg: string) => logger.info(msg),
  readinessCheck: async () => { await prisma.$queryRaw`SELECT 1`; },
});

app.set('prisma', prisma);

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
    const session = await prisma.attendanceSession.upsert({
      where: {
        branchId_date_classId_sectionId_subjectId_period: {
          branchId,
          date: day,
          classId,
          sectionId,
          subjectId: null as unknown as string,
          period: null as unknown as number,
        },
      },
      create: { branchId, date: day, classId, sectionId, academicYearId: academicYear.id, markedBy: markedBy ?? userId },
      update: { markedBy: markedBy ?? userId },
    });

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

mount('/', r);
finalize();

listenWithGracefulShutdown(app, env.PORT, SERVICE_NAME, async () => { await prisma.$disconnect(); });

export { app, prisma };
