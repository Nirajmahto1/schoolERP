// ──────────────────────────────────────────────
// School ERP — Attendance Service (Daily only)
// ──────────────────────────────────────────────

import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import dotenv from 'dotenv';
import { PrismaClient } from '@school-erp/database';
import { logger } from './utils/logger';
import { ctx } from '@school-erp/auth';

dotenv.config({ path: '../../.env' });

const app = express();
const prisma = new PrismaClient();
const PORT = process.env.PORT_ATTENDANCE_SERVICE || 4006;

app.use(cors());
app.use(express.json());
app.use(morgan('combined', { stream: { write: (msg) => logger.info(msg.trim()) } }));
app.set('prisma', prisma);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'attendance-service', timestamp: new Date().toISOString() });
});

// ── Mark Daily Attendance (bulk) ──
app.post('/attendance/mark', async (req, res) => {
  try {
    const { date, records, markedBy } = req.body;
    const { branchId } = ctx(req);
    // records: [{ studentId: string, status: "PRESENT" | "ABSENT" | "LATE" | "HALF_DAY" | "ON_LEAVE", remarks?: string }]

    const result = await Promise.all(
      records.map((r: any) =>
        prisma.attendance.upsert({
          where: { date_studentId: { date: new Date(date), studentId: r.studentId } },
          create: { date: new Date(date), status: r.status, studentId: r.studentId, remarks: r.remarks, markedBy, branchId },
          update: { status: r.status, remarks: r.remarks, markedBy },
        })
      )
    );

    res.json({ count: result.length, message: 'Attendance marked successfully' });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

// ── Mark Staff Attendance ──
app.post('/attendance/staff/mark', async (req, res) => {
  try {
    const { date, records, markedBy } = req.body;
    const { branchId } = ctx(req);

    const result = await Promise.all(
      records.map((r: any) =>
        prisma.attendance.upsert({
          where: { date_staffId: { date: new Date(date), staffId: r.staffId } },
          create: { date: new Date(date), status: r.status, staffId: r.staffId, remarks: r.remarks, markedBy, branchId },
          update: { status: r.status, remarks: r.remarks, markedBy },
        })
      )
    );

    res.json({ count: result.length, message: 'Staff attendance marked successfully' });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

// ── Get Attendance by Date ──
app.get('/attendance/daily', async (req, res) => {
  try {
    const { date, classId, sectionId } = req.query;
    const { branchId } = ctx(req);

    const where: any = { branchId, date: new Date(date as string), studentId: { not: null } };

    const records = await prisma.attendance.findMany({
      where,
      include: {
        student: {
          select: { firstName: true, lastName: true, admissionNo: true, rollNo: true, classId: true, sectionId: true },
        },
      },
      orderBy: { student: { rollNo: 'asc' } },
    });

    // Filter by class/section if provided
    const filtered = records.filter(r => {
      if (classId && r.student?.classId !== classId) return false;
      if (sectionId && r.student?.sectionId !== sectionId) return false;
      return true;
    });

    const summary = {
      total: filtered.length,
      present: filtered.filter(r => r.status === 'PRESENT').length,
      absent: filtered.filter(r => r.status === 'ABSENT').length,
      late: filtered.filter(r => r.status === 'LATE').length,
      onLeave: filtered.filter(r => r.status === 'ON_LEAVE').length,
    };

    res.json({ data: filtered, summary });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

// ── Get Student Attendance History ──
app.get('/attendance/student/:studentId', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const where: any = { studentId: req.params.studentId };
    if (startDate && endDate) {
      where.date = { gte: new Date(startDate as string), lte: new Date(endDate as string) };
    }

    const records = await prisma.attendance.findMany({ where, orderBy: { date: 'desc' } });

    const total = records.length;
    const present = records.filter(r => r.status === 'PRESENT' || r.status === 'LATE').length;
    const percentage = total > 0 ? Math.round((present / total) * 100 * 10) / 10 : 0;

    res.json({ data: records, stats: { total, present, absent: total - present, percentage } });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

// ── Monthly Summary ──
app.get('/attendance/summary', async (req, res) => {
  try {
    const { month, year, classId } = req.query;
    const { branchId } = ctx(req);
    const m = parseInt(month as string);
    const y = parseInt(year as string);
    const startDate = new Date(y, m - 1, 1);
    const endDate = new Date(y, m, 0);

    const records = await prisma.attendance.findMany({
      where: { branchId, date: { gte: startDate, lte: endDate }, studentId: { not: null } },
      include: { student: { select: { classId: true, sectionId: true } } },
    });

    const filtered = classId ? records.filter(r => r.student?.classId === classId) : records;
    const totalDays = endDate.getDate();
    const avgRate = filtered.length > 0
      ? Math.round((filtered.filter(r => r.status === 'PRESENT').length / filtered.length) * 100 * 10) / 10
      : 0;

    res.json({ month: m, year: y, totalRecords: filtered.length, workingDays: totalDays, averageAttendanceRate: avgRate });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

process.on('SIGTERM', async () => { await prisma.$disconnect(); process.exit(0); });
app.listen(PORT, () => console.log(`📋 Attendance Service running on http://localhost:${PORT}`));
export { app, prisma };
