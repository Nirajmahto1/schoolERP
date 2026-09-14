// ──────────────────────────────────────────────
// Exam triggers (BUILD_PLAN 5.6: exam schedule + result published)
//
// Two notices, both driven by the Examination publication workflow (2.6.5):
//
//   • EXAM_SCHEDULE — an examination starts within `daysAhead` days (default
//     7): one notice per opted-in guardian naming the exam and its dates.
//     Fired by the daily sweep and re-firable manually.
//   • RESULT_PUBLISHED — an examination's status crossed to PUBLISHED: one
//     notice per guardian pointing at the portal. Fired by ops right after
//     publishing (the exam-service transition is the natural future hook).
//
// Idempotency, same contract as absence/fee triggers: the NotificationLog
// row's template tag (`exam_schedule:<examId>` / `exam_results:<examId>`)
// dedupes — re-scans and double-fires queue nothing.
// ──────────────────────────────────────────────

import type { PrismaClient } from '@school-erp/database';

export interface ExamTriggerScanResult {
  examsFound: number;
  noticesQueued: number;
  alreadyNotified: number;
  skippedNoGuardian: number;
}

interface GuardianContact {
  id: string;
  userId: string | null;
  phone: string | null;
  email: string | null;
}

/** Guardians of every enrolled student of the branch, opted in, contactable. */
async function branchGuardians(prisma: PrismaClient, branchId: string): Promise<GuardianContact[]> {
  const enrollments = await prisma.studentEnrollment.findMany({
    where: { branchId, status: 'ENROLLED', toDate: null },
    select: { student: { select: { isActive: true, guardians: { where: { receivesComms: true }, select: { guardianId: true } } } } },
  });
  const guardianIds = [
    ...new Set(
      enrollments
        .filter((e) => e.student.isActive)
        .flatMap((e) => e.student.guardians.map((g) => g.guardianId)),
    ),
  ];
  if (guardianIds.length === 0) return [];
  const guardians = await prisma.guardian.findMany({
    where: { id: { in: guardianIds } },
    select: { id: true, userId: true, phone: true, email: true },
  });
  return guardians.filter((g) => g.phone || g.email || g.userId);
}

async function queueToGuardians(
  prisma: PrismaClient,
  branchId: string,
  guardians: GuardianContact[],
  channel: 'WHATSAPP' | 'SMS' | 'EMAIL' | 'PUSH',
  template: string,
  subject: string,
  body: string,
): Promise<number> {
  if (guardians.length === 0) return 0;
  await prisma.notificationLog.createMany({
    data: guardians.map((g) => ({
      branchId,
      channel,
      template,
      recipientType: 'GUARDIAN',
      recipientId: channel === 'PUSH' && g.userId ? g.userId : g.id,
      recipient: channel === 'PUSH' ? undefined : g.phone ?? g.email,
      subject,
      body,
      status: 'QUEUED' as const,
    })),
  });
  return guardians.length;
}

/**
 * Scan for examinations starting within `daysAhead` days and queue one
 * schedule notice per opted-in guardian. Idempotent per examination.
 */
export async function scanExamSchedules(
  prisma: PrismaClient,
  branchId: string,
  date: Date,
  opts: { channel?: 'WHATSAPP' | 'SMS' | 'EMAIL' | 'PUSH'; daysAhead?: number } = {},
): Promise<ExamTriggerScanResult> {
  const channel = opts.channel ?? 'WHATSAPP';
  const daysAhead = opts.daysAhead ?? 7;

  const dayStart = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const windowEnd = new Date(dayStart);
  windowEnd.setUTCDate(windowEnd.getUTCDate() + daysAhead);

  const result: ExamTriggerScanResult = { examsFound: 0, noticesQueued: 0, alreadyNotified: 0, skippedNoGuardian: 0 };

  const exams = await prisma.examination.findMany({
    where: {
      branchId,
      startDate: { gte: dayStart, lte: windowEnd },
      status: { in: ['ENTRY', 'SUBMITTED', 'VERIFIED'] }, // not yet published, still upcoming
    },
    select: { id: true, name: true, startDate: true, endDate: true },
  });

  // Dedupe: which exams already have a schedule notice?
  const existing = await prisma.notificationLog.findMany({
    where: { branchId, template: { startsWith: 'exam_schedule:' } },
    select: { template: true },
    distinct: ['template'],
  });
  const already = new Set(existing.map((e) => e.template));

  let guardians: GuardianContact[] | null = null;
  for (const exam of exams) {
    result.examsFound++;
    const tag = `exam_schedule:${exam.id}`;
    if (already.has(tag)) {
      result.alreadyNotified++;
      continue;
    }
    guardians ??= await branchGuardians(prisma, branchId);
    if (guardians.length === 0) {
      result.skippedNoGuardian++;
      continue;
    }
    const fmt = (d: Date) =>
      d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
    const body = `Examination notice: ${exam.name} begins ${fmt(exam.startDate)} and runs through ${fmt(exam.endDate)}. Please ensure your ward is prepared and present on all exam days.`;
    result.noticesQueued += await queueToGuardians(prisma, branchId, guardians, channel, tag, 'Examination schedule', body);
    already.add(tag);
  }
  return result;
}

/**
 * Notify every opted-in guardian that an examination's results are published
 * and visible on the portal. Called by ops (and later by exam-service's
 * PUBLISHED transition). Idempotent per examination.
 */
export async function notifyResultsPublished(
  prisma: PrismaClient,
  branchId: string,
  examinationId: string,
  opts: { channel?: 'WHATSAPP' | 'SMS' | 'EMAIL' | 'PUSH' } = {},
): Promise<ExamTriggerScanResult> {
  const channel = opts.channel ?? 'WHATSAPP';
  const result: ExamTriggerScanResult = { examsFound: 1, noticesQueued: 0, alreadyNotified: 0, skippedNoGuardian: 0 };

  const exam = await prisma.examination.findFirst({
    where: { id: examinationId, branchId },
    select: { id: true, name: true, status: true },
  });
  if (!exam) throw new Error(`Examination ${examinationId} not found in this branch.`);
  if (exam.status !== 'PUBLISHED') {
    throw new Error(`Examination is ${exam.status}, not PUBLISHED — results are not visible to parents yet (2.6.5).`);
  }

  const tag = `exam_results:${exam.id}`;
  const existing = await prisma.notificationLog.count({ where: { branchId, template: tag } });
  if (existing > 0) {
    result.alreadyNotified = 1;
    return result;
  }

  const guardians = await branchGuardians(prisma, branchId);
  if (guardians.length === 0) {
    result.skippedNoGuardian = 1;
    return result;
  }
  const body = `Results published: the results of ${exam.name} are now available on the parent portal. Please log in to view your ward's report card.`;
  result.noticesQueued = await queueToGuardians(prisma, branchId, guardians, channel, tag, 'Results published', body);
  return result;
}
