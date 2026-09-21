// ──────────────────────────────────────────────
// Fee due/overdue reminder trigger (BUILD_PLAN 5.6 #2)
//
// Two reminder kinds:
//   • DUE_SOON: invoice still outstanding as its due date approaches
//     (default window: 3 days before). A courtesy nudge, not a demand.
//   • OVERDUE: the due date has passed and money is still outstanding.
//     Worded firmly.
//
// Idempotency, same contract as the absence alert: the idempotency
// boundary is the NotificationLog itself — one row per (invoice, kind,
// student) marked with a `fee_reminder:<kind>:<invoiceNo>` template tag
// means skip. Re-running the sweep (cron + manual re-fire) never
// double-charges the school's messaging credits or spams the parent.
//
// One row per opted-in guardian per invoice. Outstanding = total − paid;
// fully-paid, waived, void, cancelled, and draft invoices never alert.
// ──────────────────────────────────────────────

import type { PrismaClient } from '@school-erp/database';
import { decryptField } from '@school-erp/auth';

export const FEE_REMINDER_DUE_SOON = 'fee_reminder:DUE_SOON';
export const FEE_REMINDER_OVERDUE = 'fee_reminder:OVERDUE';

export interface FeeReminderScanResult {
  date: string;
  dueSoonFound: number;
  overdueFound: number;
  remindersQueued: number;
  alreadyReminded: number;
  skippedNoGuardian: number;
}

/**
 * Scan a branch's invoices and queue fee reminders. Safe to run any number
 * of times for the same date: the log rows dedupe. Per-branch, like the
 * absence scan — multi-tenant isolation is the branchId.
 */
export async function scanFeeRemindersForDate(
  prisma: PrismaClient,
  branchId: string,
  date: Date,
  opts: {
    channel?: 'WHATSAPP' | 'SMS' | 'EMAIL' | 'PUSH';
    dueSoonDays?: number; // reminders start this many days before the due date
    overdueGraceDays?: number; // overdue alerts start this many days after
  } = {},
): Promise<FeeReminderScanResult> {
  const channel = opts.channel ?? 'WHATSAPP';
  const dueSoonDays = opts.dueSoonDays ?? 3;
  const overdueGraceDays = opts.overdueGraceDays ?? 0;

  const dayStart = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dueSoonFrom = new Date(dayStart);
  dueSoonFrom.setUTCDate(dueSoonFrom.getUTCDate() + dueSoonDays); // window closes at due date
  const overdueBefore = new Date(dayStart);
  overdueBefore.setUTCDate(overdueBefore.getUTCDate() - overdueGraceDays);

  const result: FeeReminderScanResult = {
    date: dayStart.toISOString().slice(0, 10),
    dueSoonFound: 0,
    overdueFound: 0,
    remindersQueued: 0,
    alreadyReminded: 0,
    skippedNoGuardian: 0,
  };

  const outstandingWhere = {
    branchId,
    deletedAt: null,
    status: { in: ['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'] as Array<'ISSUED' | 'PARTIALLY_PAID' | 'OVERDUE'> },
  };

  // ── DUE_SOON: due dates inside the next `dueSoonDays` days ──
  const dueSoon = await prisma.invoice.findMany({
    where: { ...outstandingWhere, dueDate: { gte: dayStart, lte: dueSoonFrom } },
    select: { id: true, invoiceNo: true, studentId: true, totalAmount: true, paidAmount: true, dueDate: true },
  });
  result.dueSoonFound = dueSoon.length;

  // ── OVERDUE: due date passed at least `overdueGraceDays` ago ──
  const overdue = await prisma.invoice.findMany({
    where: { ...outstandingWhere, dueDate: { lt: overdueBefore } },
    select: { id: true, invoiceNo: true, studentId: true, totalAmount: true, paidAmount: true, dueDate: true },
  });
  result.overdueFound = overdue.length;

  if (dueSoon.length + overdue.length === 0) return result;

  // Idempotency: which (template tag) rows already exist for this branch?
  // A tag embeds the invoice number, so re-runs skip exactly what fired.
  const existing = await prisma.notificationLog.findMany({
    where: {
      branchId,
      recipientType: 'GUARDIAN',
      OR: [
        { template: { startsWith: 'fee_reminder:DUE_SOON:' } },
        { template: { startsWith: 'fee_reminder:OVERDUE:' } },
      ],
    },
    select: { template: true },
    distinct: ['template'],
  });
  const already = new Set(existing.map((e) => e.template));

  // Guardians per student, opted in, with contact info.
  const studentIds = [...new Set([...dueSoon, ...overdue].map((i) => i.studentId))];
  const students = await prisma.student.findMany({
    where: { id: { in: studentIds }, isActive: true },
    select: {
      id: true, firstName: true, lastName: true, admissionNo: true,
      guardians: { where: { receivesComms: true }, select: { guardianId: true } },
    },
  });
  const studentById = new Map(students.map((s) => [s.id, s]));

  const guardianIds = [...new Set(students.flatMap((s) => s.guardians.map((g) => g.guardianId)))];
  // Guardian phones are encrypted at rest (Phase 12.5); delivery needs plaintext.
  const guardians = (await prisma.guardian.findMany({
    where: { id: { in: guardianIds } },
    select: { id: true, userId: true, fullName: true, phone: true, email: true },
  })).map((g) => ({ ...g, phone: decryptField(g.phone) }));
  const guardianById = new Map(guardians.map((g) => [g.id, g]));

  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const inr = (n: string) => `Rs. ${n}`;

  const queue = async (
    invoice: { id: string; studentId: string; invoiceNo: string; totalAmount: { toString(): string }; paidAmount: { toString(): string }; dueDate: Date },
    kind: 'DUE_SOON' | 'OVERDUE',
  ) => {
    const tag = `fee_reminder:${kind}:${invoice.invoiceNo}`;
    if (already.has(tag)) {
      result.alreadyReminded++;
      return;
    }
    const student = studentById.get(invoice.studentId);
    if (!student || student.guardians.length === 0) {
      result.skippedNoGuardian++;
      return;
    }
    const contactable = student.guardians
      .map((g) => guardianById.get(g.guardianId))
      .filter((g): g is NonNullable<typeof g> => !!g && !!(g.phone || g.email || g.userId));
    if (contactable.length === 0) {
      result.skippedNoGuardian++;
      return;
    }

    const outstanding = Number(invoice.totalAmount) - Number(invoice.paidAmount);
    const amount = inr(outstanding.toFixed(2));
    const due = fmt(invoice.dueDate);
    const body =
      kind === 'DUE_SOON'
        ? `Fee reminder: invoice ${invoice.invoiceNo} for ${student.firstName} ${student.lastName} (${student.admissionNo}) — ${amount} due by ${due}. Please pay before the due date.`
        : `Fee OVERDUE: invoice ${invoice.invoiceNo} for ${student.firstName} ${student.lastName} (${student.admissionNo}) — ${amount} was due on ${due} and is still unpaid. Kindly clear the dues at the earliest.`;

    await prisma.notificationLog.createMany({
      data: contactable.map((g) => ({
        branchId,
        channel,
        template: tag,
        recipientType: 'GUARDIAN',
        recipientId: channel === 'PUSH' && g.userId ? g.userId : g.id,
        recipient: channel === 'PUSH' ? undefined : g.phone ?? g.email,
        subject: kind === 'DUE_SOON' ? 'Fee due reminder' : 'Fee overdue notice',
        body,
        status: 'QUEUED' as const,
      })),
    });
    result.remindersQueued += contactable.length;
    already.add(tag); // re-fire safety within a single scan
  };

  for (const inv of dueSoon) await queue(inv, 'DUE_SOON');
  for (const inv of overdue) await queue(inv, 'OVERDUE');
  return result;
}
