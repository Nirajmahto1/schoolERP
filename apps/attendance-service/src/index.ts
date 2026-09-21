// ──────────────────────────────────────────────
// School ERP — Attendance Service (Daily only)
//
// Phase 2 shape: marking creates/updates an AttendanceSession per
// (branch, date, class, section) plus one AttendanceRecord per student.
// Percentages are read from AttendanceMonthlySummary (rebuilt here after
// marking), never recomputed from raw rows at request time.
// ──────────────────────────────────────────────

import { Router } from 'express';
import { PrismaClient, Prisma } from '@school-erp/database';
import { loadServiceEnv } from '@school-erp/config';
import { rebuildMonthlySummary } from '@school-erp/domain';
import { createServiceApp, listenWithGracefulShutdown, ctx, requireAssertion } from '@school-erp/auth';
import { buildOpenApiDocument } from '@school-erp/http';
import { mintAssertion } from '@school-erp/auth';
import { logger } from './utils/logger';

/** MUST equal the gateway route-table audience for this service. */
const SERVICE_NAME = 'attendance-service';

export interface AttendanceAppOptions {
  env: { INTERNAL_ASSERTION_PUBLIC_KEY: string };
  prisma: PrismaClient;
  /**
   * Where to POST absence-alert scans (peer call, not gateway round-trip).
   * Default: COMMUNICATION_SERVICE_URL from env.
   */
  communicationBaseUrl?: string;
  /**
   * Private assertion-signing key — a peer call mints its own 30-second
   * assertion. Optional: without it the live absence-alert path is skipped
   * (the communication-service morning sweep still covers the alert, so
   * marking must NEVER fail or slow down because of this).
   */
  internalAssertionPrivateKey?: string;
  /** Test seam: the fetch used for the peer call. */
  fetchImpl?: typeof fetch;
}

/**
 * App factory — split from the entrypoint so tests can inject a Prisma
 * client and an explicit env without booting the real process.
 */
export function createAttendanceApp(options: AttendanceAppOptions) {
  const { prisma } = options;
  const env = { INTERNAL_ASSERTION_PUBLIC_KEY: options.env.INTERNAL_ASSERTION_PUBLIC_KEY };

  // ── Live absence-alert fire (BUILD_PLAN 5.6 #1 / GATE 5) ──
  // After a successful /mark commit, tell communication-service to scan the
  // day's sessions. Fire-and-forget with a timeout: an alert is a same-
  // morning product with a cron safety net — marking must never block on it
  // (or fail because communication-service is down). The peer call mints a
  // 30-second assertion carrying the MARKER's identity, so the scan is
  // branch-scoped exactly like a direct user request would be.
  const communicationBaseUrl = options.communicationBaseUrl ?? process.env.COMMUNICATION_SERVICE_URL ?? 'http://localhost:4005';
  const peerFetch = options.fetchImpl ?? fetch;
  const fireAbsenceScan = (identity: { userId: string; email: string; tenantId: string; branchId: string | null }, date: Date): void => {
    if (!options.internalAssertionPrivateKey || !identity.branchId) return;
    const assertion = mintAssertion(
      {
        userId: identity.userId,
        email: identity.email,
        tenantId: identity.tenantId,
        branchId: identity.branchId,
        roles: ['SYSTEM'],
        audience: 'communication-service',
      },
      { privateKey: options.internalAssertionPrivateKey, ttlSeconds: 30 },
    );
    // Not awaited: run behind the response. A 5s timeout bounds the socket;
    // failures log and vanish — the sweep retries in ≤15 minutes anyway.
    void peerFetch(`${communicationBaseUrl}/absence-alerts/scan`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-assertion': assertion,
      },
      body: JSON.stringify({ date: date.toISOString().slice(0, 10), channel: 'WHATSAPP', drain: true }),
      signal: AbortSignal.timeout(5_000),
    })
      .then((res) => {
        if (!res.ok) logger.warn(`absence-scan peer call ${res.status} (sweep will cover)`);
      })
      .catch((err: unknown) => {
        logger.warn(`absence-scan peer call failed: ${(err as Error).message} (sweep will cover)`);
      });
  };

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
      '/attendance/staff/day-sheet': { get: { summary: 'Office kiosk: every staff member with their attendance row for one date (principal/admin)', tags: ['staff'], responses: { '200': { description: 'OK' } } } },
      '/attendance/staff/amend': { post: { summary: 'Office amendment: check-in/out, status set, or clear for a staff member (principal/admin)', tags: ['staff'], responses: { '200': { description: 'Amended' } } } },
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

    // Live absence alerts (5.6 #1): fire after the commit, behind the
    // response — never blocks or fails the marking itself.
    fireAbsenceScan({ userId, email: ctx(req).email, tenantId: ctx(req).tenantId, branchId }, day);

    res.json({ count: result.length, sessionId: session.id, message: 'Attendance marked successfully' });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

// ── Staff SELF-mark (GPS geofenced) ──
// POST /attendance/staff/self-mark { latitude, longitude }
// The rules that make this trustworthy rather than decorative:
//   • TIME comes from the server clock (`markedAt`), never the device — a
//     phone at 09:00 might believe it is 07:00.
//   • PLACE is checked against the branch's BOUNDING BOX — two latitudes and
//     two longitudes entered on the ERP branch form. The mark is accepted
//     only when the reported position is equal to or between the bounds on
//     BOTH axes (inclusive corners count as inside). No box configured →
//     refused (409), not silently accepted.
//   • MOCK LOCATIONS are refused: the app flags them (geolocator isMocked /
//     Android isFromMockProvider), and any mock flag arrives as
//     `mocked: true` — 409 with a message that names the reason.
r.post('/attendance/staff/self-mark', async (req, res) => {
  try {
    const { userId, branchId } = ctx(req);
    if (!userId) { res.status(401).json({ detail: 'Unauthorized' }); return; }
    if (!branchId) { res.status(403).json({ detail: 'Account has no branch — cannot self-mark.' }); return; }

    const lat = Number(req.body?.latitude);
    const lng = Number(req.body?.longitude);
    const mocked = req.body?.mocked === true;
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      res.status(400).json({ detail: 'Valid latitude and longitude are required.' });
      return;
    }
    if (mocked) {
      res.status(409).json({ detail: 'Mock location detected — turn off developer options / fake GPS and try again.' });
      return;
    }

    const staff = await prisma.staff.findFirst({ where: { userId, deletedAt: null } });
    if (!staff) { res.status(404).json({ detail: 'No staff record for this account.' }); return; }

    const branch = await prisma.branch.findUnique({
      where: { id: branchId },
      select: { name: true, minLatitude: true, maxLatitude: true, minLongitude: true, maxLongitude: true, lateAfterMinutes: true },
    });
    if (
      !branch ||
      branch.minLatitude == null || branch.maxLatitude == null ||
      branch.minLongitude == null || branch.maxLongitude == null
    ) {
      res.status(409).json({ detail: 'This branch has no attendance area configured. Ask the admin to set the two latitude/longitude bounds on the branch page.' });
      return;
    }

    // Inclusive bounding-box test: equal-to counts as inside, so a fix taken
    // standing exactly on an entered corner is not bounced by float noise.
    const inside =
      lat >= Number(branch.minLatitude) && lat <= Number(branch.maxLatitude) &&
      lng >= Number(branch.minLongitude) && lng <= Number(branch.maxLongitude);
    if (!inside) {
      res.status(409).json({ detail: `You appear to be outside ${branch.name}'s attendance area — attendance can be marked only between the latitude/longitude bounds set for the branch.` });
      return;
    }

    // Server time is the truth for both the attendance date and the mark.
    // The FIRST mark of the day is the arrival; a SECOND mark records the
    // departure (checkoutAt). A third is refused — the pair is complete and
    // edits go through an admin, not by re-playing the GPS call.
    const now = new Date();
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const existing = await prisma.staffAttendance.findUnique({
      where: { staffId_date: { staffId: staff.id, date: day } },
    });

    if (existing?.checkoutAt) {
      res.status(409).json({
        detail: `Attendance already complete for today — checked in ${existing.markedAt?.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })}, checked out ${existing.checkoutAt.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })}. Ask the office for any correction.`,
      });
      return;
    }

    const isCheckout = Boolean(existing?.markedAt);

    // Late-arrival detection: the cutoff is minutes past midnight in the
    // branch's local time (Asia/Kolkata — Indian schools; the attendance
    // DATE bucket is UTC but the working day is not). A check-in after the
    // cutoff books LATE with the minutes over recorded as remarks. Null
    // cutoff on the branch = the check is off, everything is PRESENT.
    let status = 'PRESENT' as 'PRESENT' | 'LATE';
    let lateBy: number | null = null;
    if (!isCheckout && branch.lateAfterMinutes != null) {
      const ist = new Date(now.getTime() + 5.5 * 3600 * 1000); // UTC+5:30
      const minutesIntoIstDay = ist.getUTCHours() * 60 + ist.getUTCMinutes();
      if (minutesIntoIstDay > branch.lateAfterMinutes) {
        status = 'LATE';
        lateBy = minutesIntoIstDay - branch.lateAfterMinutes;
      }
    }

    const row = isCheckout
      ? await prisma.staffAttendance.update({
          where: { id: existing!.id },
          data: { checkoutAt: now },
        })
      : await prisma.staffAttendance.upsert({
          where: { staffId_date: { staffId: staff.id, date: day } },
          create: {
            staffId: staff.id, branchId, date: day, status,
            markedBy: userId, markedAt: now,
            remarks: lateBy != null ? `Late by ${lateBy} min` : null,
            lateMinutes: lateBy,
            latitude: lat.toFixed(7), longitude: lng.toFixed(7),
          },
          update: {
            status, markedBy: userId, markedAt: now,
            remarks: lateBy != null ? `Late by ${lateBy} min` : null,
            lateMinutes: lateBy,
            latitude: lat.toFixed(7), longitude: lng.toFixed(7),
          },
        });

    res.json({
      ok: true,
      kind: isCheckout ? 'CHECKOUT' : 'CHECKIN',
      status: row.status,
      lateBy,
      markedAt: row.markedAt,
      checkoutAt: row.checkoutAt,
      message: isCheckout
        ? 'Checked out ✓ — see you tomorrow!'
        : lateBy != null
          ? `Checked in ✓ — marked LATE by ${lateBy} min.`
          : 'Checked in ✓',
    });
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

// ── My month calendar (staff/teacher app) ──
// GET /attendance/staff/me?month=9&year=2026 → one row per marked day for the
// caller's own staff record, plus a per-status tally. The mobile Attendance
// tab renders this as a month calendar (present/absent/leave/late).
r.get('/attendance/staff/me', async (req, res) => {
  try {
    const prisma: PrismaClient = req.app.get('prisma');
    const { userId } = ctx(req);
    if (!userId) { res.status(401).json({ detail: 'Unauthorized' }); return; }

    const staff = await prisma.staff.findUnique({ where: { userId }, select: { id: true } });
    if (!staff) { res.status(404).json({ detail: 'No staff record for this account.' }); return; }

    const now = new Date();
    const month = req.query.month ? parseInt(String(req.query.month), 10) : now.getMonth() + 1; // 1..12
    const year = req.query.year ? parseInt(String(req.query.year), 10) : now.getFullYear();
    if (!(month >= 1 && month <= 12) || !(year >= 2000 && year <= 2100)) {
      res.status(400).json({ detail: 'month must be 1..12 and year a sane value.' });
      return;
    }

    const from = new Date(Date.UTC(year, month - 1, 1));
    const to = new Date(Date.UTC(year, month, 1));
    const rows = await prisma.staffAttendance.findMany({
      where: { staffId: staff.id, date: { gte: from, lt: to } },
      orderBy: { date: 'asc' },
      select: { date: true, status: true, remarks: true, markedAt: true, checkoutAt: true, lateMinutes: true },
    });

    const tally = { PRESENT: 0, ABSENT: 0, ON_LEAVE: 0, LATE: 0, HALF_DAY: 0 } as Record<string, number>;
    let totalLateMinutes = 0;
    const days = rows.map((r) => {
      tally[r.status] = (tally[r.status] ?? 0) + 1;
      if (r.lateMinutes != null) totalLateMinutes += r.lateMinutes;
      // Worked minutes when both ends are recorded — computed server-side so
      // every client agrees on the number.
      const workedMinutes =
        r.markedAt && r.checkoutAt
          ? Math.max(0, Math.round((r.checkoutAt.getTime() - r.markedAt.getTime()) / 60000))
          : null;
      return {
        date: r.date.toISOString().slice(0, 10),
        status: r.status,
        remarks: r.remarks,
        checkInAt: r.markedAt?.toISOString() ?? null,
        checkOutAt: r.checkoutAt?.toISOString() ?? null,
        workedMinutes,
        lateMinutes: r.lateMinutes,
      };
    });

    res.json({ month, year, days, tally, lateCount: tally.LATE, totalLateMinutes, markedDays: days.length });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

// ── Monthly punctuality report (principal/admin) ──
// GET /attendance/staff/punctuality?month=&year=
// One row per ACTIVE staff member of the caller's branch: attendance counts,
// late count + minutes, average check-in time, and a punctuality rate
// (on-time check-ins ÷ marking days with a check-in). Role-gated: only
// PRINCIPAL / SUPER_ADMIN / BRANCH_ADMIN / ACADEMIC_HEAD may read the whole
// branch; everyone else is refused — a teacher must not see colleagues.
r.get('/attendance/staff/punctuality', async (req, res) => {
  try {
    const { branchId, roles } = ctx(req);
    const allowed = ['PRINCIPAL', 'SUPER_ADMIN', 'BRANCH_ADMIN', 'ACADEMIC_HEAD'];
    if (!branchId) { res.status(403).json({ detail: 'Account has no branch.' }); return; }
    if (!roles?.some((r: string) => allowed.includes(r))) {
      res.status(403).json({ detail: 'Only principals and admins can view the branch punctuality report.' });
      return;
    }

    const now = new Date();
    const month = req.query.month ? parseInt(String(req.query.month), 10) : now.getMonth() + 1;
    const year = req.query.year ? parseInt(String(req.query.year), 10) : now.getFullYear();
    if (!(month >= 1 && month <= 12) || !(year >= 2000 && year <= 2100)) {
      res.status(400).json({ detail: 'month must be 1..12 and year a sane value.' });
      return;
    }

    const from = new Date(Date.UTC(year, month - 1, 1));
    const to = new Date(Date.UTC(year, month, 1));

    const staff = await prisma.staff.findMany({
      where: { branchId, deletedAt: null, isActive: true },
      select: { id: true, employeeId: true, firstName: true, lastName: true, designation: true, department: true, photo: true },
      orderBy: { firstName: 'asc' },
    });

    const rows = await prisma.staffAttendance.findMany({
      where: { branchId, date: { gte: from, lt: to } },
      select: { staffId: true, status: true, markedAt: true, checkoutAt: true, lateMinutes: true },
    });

    const byStaff = new Map<string, typeof rows>();
    for (const r of rows) {
      const list = byStaff.get(r.staffId) ?? [];
      list.push(r);
      byStaff.set(r.staffId, list);
    }

    const report = staff.map((s) => {
      const mine = byStaff.get(s.id) ?? [];
      const count = (st: string) => mine.filter((r) => r.status === st).length;
      const lateCount = count('LATE');
      const totalLateMinutes = mine.reduce((sum, r) => sum + (r.lateMinutes ?? 0), 0);

      const checkIns = mine.map((r) => r.markedAt).filter((t): t is Date => t != null);
      // Average check-in in IST (the working-day clock), HH:MM.
      let avgCheckIn: string | null = null;
      if (checkIns.length > 0) {
        const totalMin = checkIns.reduce((sum, t) => {
          const ist = new Date(t.getTime() + 5.5 * 3600 * 1000);
          return sum + ist.getUTCHours() * 60 + ist.getUTCMinutes();
        }, 0);
        const avg = Math.round(totalMin / checkIns.length);
        avgCheckIn = `${String(Math.floor(avg / 60) % 24).padStart(2, '0')}:${String(avg % 60).padStart(2, '0')}`;
      }

      const checkOuts = mine.map((r) => r.checkoutAt).filter((t): t is Date => t != null);
      const markedDays = mine.length;
      const punctualityRate = checkIns.length > 0
        ? Math.round(((checkIns.length - lateCount) / checkIns.length) * 100)
        : null;

      return {
        staffId: s.id,
        name: `${s.firstName} ${s.lastName}`.trim(),
        employeeId: s.employeeId,
        designation: s.designation,
        department: s.department,
        photo: s.photo,
        markedDays,
        present: count('PRESENT') + count('LATE'), // LATE still worked the day
        lateCount,
        totalLateMinutes,
        absent: count('ABSENT'),
        onLeave: count('ON_LEAVE'),
        halfDays: count('HALF_DAY'),
        avgCheckIn,
        checkOutCount: checkOuts.length,
        punctualityRate,
      };
    });

    // Most-late first, then by total minutes — the principal's attention order.
    report.sort((a, b) => b.lateCount - a.lateCount || b.totalLateMinutes - a.totalLateMinutes);

    res.json({ month, year, staff: report, generatedAt: now.toISOString() });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

// ── Office attendance desk ──
// The self-mark flow's escape hatch: a staff member who forgot the phone, has
// it dead at the gate, or came without it gets marked by the office — the
// row is indistinguishable in shape from a GPS mark except markedBy records
// WHICH office account wrote it (the audit line), and no coordinates exist.
// Role-gated to the same leadership set as the punctuality report; a teacher
// must not be able to write colleagues' rows.
const OFFICE_DESK_ROLES = ['PRINCIPAL', 'SUPER_ADMIN', 'BRANCH_ADMIN', 'ACADEMIC_HEAD'];

function officeDayFromYmd(ymd: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  const d = new Date(`${ymd}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function officeIso(t: Date | null | undefined): string | null {
  return t ? t.toISOString() : null;
}

// GET /attendance/staff/day-sheet?date=YYYY-MM-DD
// Every ACTIVE staff member of the branch with their row for that date (or
// null when unmarked) — the kiosk renders exactly this, nothing inferred.
r.get('/attendance/staff/day-sheet', async (req, res) => {
  try {
    const { branchId, roles } = ctx(req);
    if (!branchId) { res.status(403).json({ detail: 'Account has no branch.' }); return; }
    if (!roles?.some((x: string) => OFFICE_DESK_ROLES.includes(x))) {
      res.status(403).json({ detail: 'Only principals and admins can use the office attendance desk.' });
      return;
    }

    const day = officeDayFromYmd(String(req.query.date ?? ''));
    if (!day) { res.status(400).json({ detail: 'date must be YYYY-MM-DD.' }); return; }

    const staff = await prisma.staff.findMany({
      where: { branchId, deletedAt: null, isActive: true },
      select: { id: true, employeeId: true, firstName: true, lastName: true, designation: true, department: true, photo: true, userId: true },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
    });
    const rows = await prisma.staffAttendance.findMany({
      where: { branchId, date: day },
      select: { staffId: true, status: true, remarks: true, markedAt: true, checkoutAt: true, lateMinutes: true, markedBy: true },
    });
    const byStaff = new Map(rows.map((row) => [row.staffId, row]));

    const list = staff.map((s) => {
      const row = byStaff.get(s.id) ?? null;
      return {
        staffId: s.id,
        userId: s.userId,
        name: `${s.firstName} ${s.lastName}`.trim(),
        employeeId: s.employeeId,
        designation: s.designation,
        department: s.department,
        photo: s.photo,
        hasUser: Boolean(s.userId),
        record: row && {
          status: row.status,
          remarks: row.remarks,
          checkInAt: officeIso(row.markedAt),
          checkOutAt: officeIso(row.checkoutAt),
          lateMinutes: row.lateMinutes,
          markedBy: row.markedBy,
        },
      };
    });

    const marked = list.filter((s) => s.record).length;
    res.json({ date: day.toISOString().slice(0, 10), marked, total: list.length, staff: list });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

// POST /attendance/staff/amend
//   { staffId, date, action, remarks?, lateMinutes? }
//   action: CHECK_IN | CHECK_OUT | SET_PRESENT | SET_LATE | SET_ABSENT |
//           SET_ON_LEAVE | SET_HALF_DAY | CLEAR
// CHECK_IN/CHECK_OUT stamp the SERVER clock. Status sets for ABSENT/ON_LEAVE
// wipe any GPS times (an absent person has no check-in); CLEAR deletes the
// row so a mistaken mark can be redone from scratch. The last writer lands
// in markedBy — the audit trail the punctuality report reads.
r.post('/attendance/staff/amend', async (req, res) => {
  try {
    const { branchId, userId, roles } = ctx(req);
    if (!userId) { res.status(401).json({ detail: 'Unauthorized' }); return; }
    if (!branchId) { res.status(403).json({ detail: 'Account has no branch.' }); return; }
    if (!roles?.some((x: string) => OFFICE_DESK_ROLES.includes(x))) {
      res.status(403).json({ detail: 'Only principals and admins can amend staff attendance.' });
      return;
    }

    const { staffId, action, remarks, lateMinutes } = req.body ?? {};
    const day = officeDayFromYmd(String(req.body?.date ?? ''));
    if (!staffId || !day) {
      res.status(400).json({ detail: 'staffId and date (YYYY-MM-DD) are required.' });
      return;
    }
    const ACTIONS = ['CHECK_IN', 'CHECK_OUT', 'SET_PRESENT', 'SET_LATE', 'SET_ABSENT', 'SET_ON_LEAVE', 'SET_HALF_DAY', 'CLEAR'] as const;
    if (!ACTIONS.includes(action)) {
      res.status(400).json({ detail: `action must be one of ${ACTIONS.join(', ')}.` });
      return;
    }

    const staff = await prisma.staff.findFirst({
      where: { id: staffId, branchId, deletedAt: null },
      select: { id: true, firstName: true, lastName: true },
    });
    if (!staff) {
      res.status(404).json({ detail: 'Staff member not found in your branch.' });
      return;
    }

    const existing = await prisma.staffAttendance.findUnique({
      where: { staffId_date: { staffId: staff.id, date: day } },
    });
    const name = `${staff.firstName} ${staff.lastName}`.trim();
    const now = new Date();

    // Branch cutoff re-used for office CHECK_INs so a late office check-in is
    // booked LATE exactly like a GPS one would be.
    const branch = await prisma.branch.findUnique({
      where: { id: branchId },
      select: { lateAfterMinutes: true },
    });

    if (action === 'CLEAR') {
      if (!existing) { res.status(404).json({ detail: 'Nothing recorded for that day.' }); return; }
      await prisma.staffAttendance.delete({ where: { id: existing.id } });
      res.json({ ok: true, action, message: `${name}'s ${day.toISOString().slice(0, 10)} record cleared.` });
      return;
    }

    if (action === 'CHECK_IN') {
      if (existing?.checkoutAt) {
        res.status(409).json({ detail: `${name} already has a complete pair for that day — clear the record first to re-mark.` });
        return;
      }
      let status: 'PRESENT' | 'LATE' = 'PRESENT';
      let lateBy: number | null = null;
      if (branch?.lateAfterMinutes != null) {
        const ist = new Date(now.getTime() + 5.5 * 3600 * 1000);
        const minutesIntoIstDay = ist.getUTCHours() * 60 + ist.getUTCMinutes();
        if (minutesIntoIstDay > branch.lateAfterMinutes) {
          status = 'LATE';
          lateBy = minutesIntoIstDay - branch.lateAfterMinutes;
        }
      }
      const row = await prisma.staffAttendance.upsert({
        where: { staffId_date: { staffId: staff.id, date: day } },
        create: {
          staffId: staff.id, branchId, date: day, status,
          markedBy: userId, markedAt: now,
          remarks: remarks ?? (lateBy != null ? `Office check-in — late by ${lateBy} min` : 'Office check-in'),
          lateMinutes: lateBy,
        },
        update: {
          status, markedBy: userId, markedAt: now,
          remarks: remarks ?? (lateBy != null ? `Office check-in — late by ${lateBy} min` : 'Office check-in'),
          lateMinutes: lateBy,
        },
      });
      res.json({ ok: true, action, record: { status: row.status, checkInAt: officeIso(row.markedAt), checkOutAt: officeIso(row.checkoutAt), lateMinutes: row.lateMinutes }, message: `${name} checked in.` });
      return;
    }

    if (action === 'CHECK_OUT') {
      if (!existing?.markedAt) {
        res.status(409).json({ detail: `${name} has no check-in for that day — a check-out cannot exist without one.` });
        return;
      }
      if (existing.checkoutAt) {
        res.status(409).json({ detail: `${name} already checked out at ${existing.checkoutAt.toISOString()}.` });
        return;
      }
      const row = await prisma.staffAttendance.update({
        where: { id: existing.id },
        data: { checkoutAt: now, markedBy: userId, ...(remarks ? { remarks } : {}) },
      });
      res.json({ ok: true, action, record: { status: row.status, checkInAt: officeIso(row.markedAt), checkOutAt: officeIso(row.checkoutAt), lateMinutes: row.lateMinutes }, message: `${name} checked out.` });
      return;
    }

    // SET_* actions. ABSENT / ON_LEAVE wipe GPS times (a person who did not
    // come has no check-in); PRESENT / LATE / HALF_DAY keep existing times so
    // an office status-fix never destroys a genuine GPS pair.
    const statusMap: Record<string, 'PRESENT' | 'LATE' | 'ABSENT' | 'ON_LEAVE' | 'HALF_DAY'> = {
      SET_PRESENT: 'PRESENT', SET_LATE: 'LATE', SET_ABSENT: 'ABSENT',
      SET_ON_LEAVE: 'ON_LEAVE', SET_HALF_DAY: 'HALF_DAY',
    };
    const status = statusMap[action];
    const wipeTimes = status === 'ABSENT' || status === 'ON_LEAVE';
    const row = await prisma.staffAttendance.upsert({
      where: { staffId_date: { staffId: staff.id, date: day } },
      create: {
        staffId: staff.id, branchId, date: day, status,
        markedBy: userId,
        remarks: remarks ?? `Office: ${status}`,
        lateMinutes: status === 'LATE' ? Math.max(0, Number(lateMinutes) || 0) : null,
      },
      update: {
        status, markedBy: userId,
        remarks: remarks ?? existing?.remarks ?? `Office: ${status}`,
        lateMinutes: status === 'LATE' ? Math.max(0, Number(lateMinutes) || 0) : null,
        ...(wipeTimes ? { markedAt: null, checkoutAt: null } : {}),
      },
    });
    res.json({ ok: true, action, record: { status: row.status, checkInAt: officeIso(row.markedAt), checkOutAt: officeIso(row.checkoutAt), lateMinutes: row.lateMinutes }, message: `${name} set to ${status}.` });
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
// Isolation (Phase 12): the student must belong to the caller's branch — the
// studentId in the URL is untrusted object reference (the IDOR classic). A
// student from another branch 404s exactly as if absent.
r.get('/attendance/student/:studentId', async (req, res) => {
  try {
    const { branchId } = ctx(req);
    if (!branchId) { res.status(403).json({ detail: 'Account has no branch.' }); return; }
    const student = await prisma.student.findFirst({
      where: { id: req.params.studentId, branchId, deletedAt: null },
      select: { id: true },
    });
    if (!student) { res.status(404).json({ detail: 'Student not found.' }); return; }
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
// Boot ONLY when run directly — importing this module (tests, e2e) must be
// side-effect-free; module-scope loadServiceEnv exits CI suites that import
// the app factory without a real .env.
if (process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js')) {
  const env = loadServiceEnv(SERVICE_NAME, 'PORT_ATTENDANCE_SERVICE');
  const prisma = new PrismaClient();
  const app = createAttendanceApp({
    env,
    prisma,
    communicationBaseUrl: env.COMMUNICATION_SERVICE_URL,
    // Peer-call signing material (optional per ADR-3): present here so the
    // live absence-alert fire works; a deployment without it still marks
    // attendance and relies on the communication-service morning sweep.
    internalAssertionPrivateKey: env.INTERNAL_ASSERTION_PRIVATE_KEY,
  });
  listenWithGracefulShutdown(app, env.PORT, SERVICE_NAME, async () => { await prisma.$disconnect(); });
}
