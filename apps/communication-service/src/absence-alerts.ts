// ──────────────────────────────────────────────
// Absence alert trigger (BUILD_PLAN 5.6 #1)
//
// "Absence alert (same morning)" — the plan's most time-sensitive automated
// notification, and GATE 5's first criterion ("reaches a real phone within
// 2 minutes of marking").
//
// Two ways a parent gets alerted, and both matter:
//   • LIVE: attendance-service fires this scan right after a /mark call —
//     the teacher marks, the phone buzzes in the pickup line.
//   • SWEEP: a morning cron scans the day's sessions (a teacher marked
//     late, or the live call failed) — the parent still hears that morning.
//
// Idempotency is the whole trick: the live path and the cron both call the
// same scan for the same date, so a student must not get two alerts. The
// boundary is the NotificationLog row itself — one QUEUED/SENT row per
// (student, date, template) already in the log means skip. LATE/HALF_DAY/
// ON_LEAVE/MEDICAL/EXCUSED are not absences; only ABSENT alerts.
//
// Rows land on every opted-in guardian with channel WHATSAPP, urgent —
// quiet hours never hold back a same-morning absence alert (§5.8 allows
// transactional urgency).
// ──────────────────────────────────────────────

import type { PrismaClient } from '@school-erp/database';
import { decryptField } from '@school-erp/auth';

export const ABSENCE_TEMPLATE = 'absence_alert';

export interface AbsenceScanResult {
  date: string;
  sessionsScanned: number;
  studentsAbsent: number;
  alertsQueued: number;
  /** Students skipped because an alert for this date already exists. */
  alreadyAlerted: number;
  /** Students skipped because no opted-in guardian with contact info exists. */
  skippedNoGuardian: number;
}

/**
 * Scan a branch's daily attendance sessions for `date` and queue one urgent
 * WhatsApp alert per absent student. Safe to run repeatedly for the same
 * date (cron + live path share it), and per-branch (multi-tenant isolation:
 * School A's 7:40am mark never scans School B).
 */
export async function scanAbsencesForDate(
  prisma: PrismaClient,
  branchId: string,
  date: Date,
  opts: { channel?: 'WHATSAPP' | 'SMS' | 'PUSH'; urgent?: boolean } = {},
): Promise<AbsenceScanResult> {
  const channel = opts.channel ?? 'WHATSAPP';
  const dayStart = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

  // Daily sessions only (subjectId/period NULL) for this branch + date.
  const sessions = await prisma.attendanceSession.findMany({
    where: { branchId, date: dayStart, subjectId: null, period: null },
    select: { id: true, classId: true, sectionId: true },
  });

  const result: AbsenceScanResult = {
    date: dayStart.toISOString().slice(0, 10),
    sessionsScanned: sessions.length,
    studentsAbsent: 0,
    alertsQueued: 0,
    alreadyAlerted: 0,
    skippedNoGuardian: 0,
  };
  if (sessions.length === 0) return result;

  const absentRecords = await prisma.attendanceRecord.findMany({
    where: { sessionId: { in: sessions.map((s) => s.id) }, status: 'ABSENT' },
    select: { studentId: true },
    distinct: ['studentId'],
  });
  result.studentsAbsent = absentRecords.length;
  if (absentRecords.length === 0) return result;

  // Idempotency boundary: which of these students already have an absence
  // alert row for this date (any status — QUEUED counts; the drainer owns
  // the row from there). One query, not one per student.
  const since = new Date(dayStart.getTime() - 24 * 3600 * 1000);
  const existing = await prisma.notificationLog.findMany({
    where: {
      branchId,
      channel,
      template: ABSENCE_TEMPLATE,
      recipientType: 'GUARDIAN',
      createdAt: { gte: since },
      body: { contains: `#${dayStart.toISOString().slice(0, 10)}` },
    },
    select: { recipientId: true },
  });
  const studentsWithAlerts = new Set(
    (
      await prisma.studentGuardian.findMany({
        where: { guardianId: { in: existing.map((e) => e.recipientId) } },
        select: { studentId: true },
      })
    ).map((r) => r.studentId),
  );

  for (const rec of absentRecords) {
    if (studentsWithAlerts.has(rec.studentId)) {
      result.alreadyAlerted++;
      continue;
    }

    const student = await prisma.student.findUnique({
      where: { id: rec.studentId },
      select: { firstName: true, lastName: true, admissionNo: true, guardians: { where: { receivesComms: true }, select: { guardianId: true } } },
    });
    if (!student || student.guardians.length === 0) {
      result.skippedNoGuardian++;
      continue;
    }

    // Guardian phones are encrypted at rest (Phase 12.5); delivery needs plaintext.
    const guardians = (await prisma.guardian.findMany({
      where: { id: { in: student.guardians.map((g) => g.guardianId) } },
      select: { id: true, userId: true, fullName: true, phone: true, email: true },
    })).map((g) => ({ ...g, phone: decryptField(g.phone) }));
    const contactable = guardians.filter((g) => g.phone || g.email || g.userId);
    if (contactable.length === 0) {
      result.skippedNoGuardian++;
      continue;
    }

    const body = `Attendance notice #${dayStart.toISOString().slice(0, 10)}: ${student.firstName} ${student.lastName} (${student.admissionNo}) was marked ABSENT today. If this is unexpected, please contact the school office.`;

    await prisma.notificationLog.createMany({
      data: contactable.map((g) => ({
        branchId,
        channel,
        template: ABSENCE_TEMPLATE,
        recipientType: 'GUARDIAN',
        recipientId: channel === 'PUSH' && g.userId ? g.userId : g.id,
        recipient: channel === 'PUSH' ? undefined : g.phone ?? g.email,
        subject: 'Absence alert',
        body,
        status: 'QUEUED' as const,
      })),
    });
    result.alertsQueued += contactable.length;
  }

  return result;
}
