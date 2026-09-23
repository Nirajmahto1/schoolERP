// ──────────────────────────────────────────────
// Late fees + advance collection
//
// LATE FEES — slab rules per branch: "15–29 days overdue → ₹50 flat",
// "30+ days → 2% of outstanding". Application is idempotent by construction:
// one DEMAND invoice per (invoice, rule) pairing, keyed by the ledger
// reference `LATE:<ruleId>:<invoiceId>` — re-running skips what already
// posted, so the accountant can run "apply" daily without double-fining.
//
// ADVANCE COLLECTION — the counter operator collects cash for the NEXT N
// months in one sitting. The engine generates the missing monthly invoices
// from the student's fee structure (idempotent invoice numbers), then posts
// ONE cash payment that allocates across them. Section 269ST (cash ≥ ₹2L)
// is enforced inside postPayment. Everything runs in caller-supplied
// transactions where possible; the month-generation step is idempotent by
// invoice number so a retried collect cannot double-bill.
// ──────────────────────────────────────────────

import type { PrismaClient } from '@school-erp/database';
import { postPayment } from './fees';
import { postDemand } from './fees';

export interface LateFeeRuleInput {
  label: string;
  minDays: number;
  maxDays?: number | null;
  amount: number;
  isPercent?: boolean;
  feeHeadId?: string | null;
  isActive?: boolean;
}

export interface ApplyLateFeesResult {
  applied: Array<{ studentId: string; invoiceId: string; invoiceNo: string; rule: string; amount: number; daysOverdue: number }>;
  skipped: number;
  scanned: number;
}

/** Days overdue, counting from the due date (a due date of yesterday = 1). */
function daysOverdue(dueDate: Date, now: Date): number {
  const ms = now.getTime() - dueDate.getTime();
  return Math.max(0, Math.floor(ms / 86_400_000));
}

/**
 * Apply the branch's late-fee slabs to every overdue invoice.
 *
 * One LATE_FEE demand per (overdue invoice × rule). Idempotency: the fee
 * invoice's ledger reference is `LATE:<ruleId>:<sourceInvoiceId>`; a rule
 * re-run finds the existing row and skips. Slab overlap (two rules both
 * matching 20 days) is an error in configuration — the caller sees both
 * applied, so keep slabs disjoint in the UI.
 */
export async function applyLateFees(prisma: PrismaClient, input: {
  branchId: string;
  academicYearId: string;
  rules: Array<LateFeeRuleInput & { id: string }>;
  createdBy?: string | null;
  /** If true, compute what WOULD be applied without writing. */
  dryRun?: boolean;
}): Promise<ApplyLateFeesResult> {
  const now = new Date();
  const result: ApplyLateFeesResult = { applied: [], skipped: 0, scanned: 0 };

  if (input.rules.length === 0) return result;

  // Every overdue invoice with an outstanding balance.
  const overdue = await prisma.invoice.findMany({
    where: {
      branchId: input.branchId,
      academicYearId: input.academicYearId,
      dueDate: { lt: now },
      status: { in: ['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'] },
      deletedAt: null,
    },
    include: { student: { select: { id: true, firstName: true, lastName: true } } },
    orderBy: { dueDate: 'asc' },
  });
  result.scanned = overdue.length;

  // Existing late-fee postings for idempotency — one query for the branch.
  const existingRefs = await prisma.feeLedger.findMany({
    where: { branchId: input.branchId, type: 'LATE_FEE' },
    select: { reference: true },
  });
  const seen = new Set(existingRefs.map((e) => e.reference));

  // Resolve (or lazily create) the branch's LATE_FEE fee head.
  const ensureLateFeeHead = async () => {
    const existing = await prisma.feeHead.findFirst({
      where: { branchId: input.branchId, type: 'LATE_FEE', deletedAt: null },
      select: { id: true },
    });
    if (existing) return existing.id;
    const created = await prisma.feeHead.create({
      data: { branchId: input.branchId, code: 'LATE-FEE', name: 'Late Fee', type: 'LATE_FEE', isRecurring: false },
      select: { id: true },
    });
    return created.id;
  };
  const fallbackHeadId = await ensureLateFeeHead();

  for (const invoice of overdue) {
    const outstanding = Number(invoice.totalAmount) - Number(invoice.paidAmount);
    if (outstanding <= 0.005) { result.skipped += 1; continue; }
    const days = daysOverdue(invoice.dueDate, now);

    for (const rule of input.rules) {
      if (!rule.isActive) continue;
      if (days < rule.minDays) continue;
      if (rule.maxDays != null && days > rule.maxDays) continue;

      const ref = `LATE:${rule.id}:${invoice.id}`;
      if (seen.has(ref)) { result.skipped += 1; continue; }

      const fine = rule.isPercent
        ? Math.round(outstanding * Number(rule.amount)) / 100
        : Number(rule.amount);
      if (fine <= 0) { result.skipped += 1; continue; }

      if (input.dryRun) {
        result.applied.push({
          studentId: invoice.studentId,
          invoiceId: invoice.id,
          invoiceNo: invoice.invoiceNo,
          rule: rule.label,
          amount: fine,
          daysOverdue: days,
        });
        continue;
      }

      // The fine is its own tiny invoice + DEMAND ledger entry (LATE_FEE
      // type), so it flows through allocation, receipts and reports like
      // any other due. Reference carries the idempotency key.
      const feeHeadId = rule.feeHeadId ?? fallbackHeadId;
      const feeInvoice = await postDemand(prisma, {
        branchId: input.branchId,
        academicYearId: input.academicYearId,
        studentId: invoice.studentId,
        lines: [{
          feeHeadId,
          amount: fine,
          description: `${rule.label} — ${invoice.invoiceNo} (${days} days overdue)`,
        }],
        dueDate: now,
        createdBy: input.createdBy ?? null,
      });
      // postDemand posts DEMAND entries; tag the fine entry as LATE_FEE with
      // the idempotent reference.
      await prisma.feeLedger.updateMany({
        where: { invoiceId: feeInvoice.id, type: 'DEMAND' },
        data: { type: 'LATE_FEE', reference: ref },
      });
      // Mark the demand invoice as the late-fee child of the source.
      await prisma.invoice.update({
        where: { id: feeInvoice.id },
        data: { periodStart: invoice.dueDate, periodEnd: null },
      });
      await prisma.invoice.update({
        where: { id: invoice.id },
        data: { status: 'OVERDUE' },
      });

      seen.add(ref);
      result.applied.push({
        studentId: invoice.studentId,
        invoiceId: invoice.id,
        invoiceNo: invoice.invoiceNo,
        rule: rule.label,
        amount: fine,
        daysOverdue: days,
      });
    }
  }

  return result;
}

// ── Advance collection ──

export interface AdvancePreviewResult {
  studentId: string;
  months: number;
  perMonth: number;
  total: number;
  existingPaid: number;
  generatedMonths: Array<{ periodStart: string; periodEnd: string; invoiceNo: string | null; alreadyInvoiced: boolean; amount: number }>;
}

export interface CollectAdvanceResult {
  payment: { id: string; receiptNo: string | null; amount: number; method: string };
  generatedInvoices: number;
  allocations: Array<{ invoiceId: string; amount: number }>;
  advanceCredit: number;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function monthWindow(anchor: Date, offset: number): { periodStart: Date; periodEnd: Date; key: string } {
  // Indian school sessions run Apr–Mar, but advances anchor on calendar
  // months from "next month" — simple and predictable at the counter.
  const start = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + offset, 1));
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0, 23, 59, 59, 999));
  const key = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}`;
  return { periodStart: start, periodEnd: end, key };
}

/**
 * What WOULD be collected: the next `months` months of the student's monthly
 * fee lines, minus months that already have an open invoice. Read-only.
 */
export async function previewAdvance(prisma: PrismaClient, input: {
  branchId: string;
  studentId: string;
  academicYearId: string;
  months: number;
}): Promise<AdvancePreviewResult> {
  const now = new Date();
  const structure = await activeMonthlyStructure(prisma, input.branchId, input.academicYearId, input.studentId);
  const perMonth = structure.lines.reduce((s, l) => s + l.amount - l.discount, 0);

  const generated: AdvancePreviewResult['generatedMonths'] = [];
  let total = 0;
  for (let i = 1; i <= input.months; i += 1) {
    const w = monthWindow(now, i);
    const invoiceNo = advanceInvoiceNo(input.branchId, input.studentId, w.key);
    const existing = await prisma.invoice.findUnique({
      where: { branchId_invoiceNo: { branchId: input.branchId, invoiceNo } },
      select: { invoiceNo: true, totalAmount: true, paidAmount: true, status: true },
    });
    const alreadyInvoiced = !!existing;
    // If the month is already invoiced, its outstanding still counts toward
    // what the counter can collect today.
    const outstanding = existing ? Math.max(0, Number(existing.totalAmount) - Number(existing.paidAmount)) : perMonth;
    generated.push({ periodStart: w.key, periodEnd: '', invoiceNo: existing?.invoiceNo ?? invoiceNo, alreadyInvoiced, amount: outstanding });
    total += outstanding;
  }

  return {
    studentId: input.studentId,
    months: input.months,
    perMonth,
    total,
    existingPaid: 0,
    generatedMonths: generated,
  };
}

/** Deterministic invoice number for an advance month — the idempotency key. */
function advanceInvoiceNo(branchId: string, studentId: string, monthKey: string): string {
  return `ADV-${branchId.slice(-6)}-${studentId.slice(-6)}-${monthKey}`.replace(/[^A-Za-z0-9-]/g, '');
}

async function activeMonthlyStructure(prisma: PrismaClient, branchId: string, academicYearId: string, studentId: string) {
  // The student's active enrollment picks the class; the structure must cover
  // that class (FeeStructureClass) and be active for the year.
  const enrollment = await prisma.studentEnrollment.findFirst({
    where: { studentId, branchId, academicYearId },
    orderBy: { createdAt: 'desc' },
    select: { classId: true },
  });
  const structures = await prisma.feeStructure.findMany({
    where: { branchId, academicYearId, isActive: true, deletedAt: null },
    include: {
      lines: { include: { feeHead: { select: { name: true } } } },
      classes: { select: { classId: true } },
    },
  });
  const candidates = structures.filter(
    (s) => s.classes.length === 0 || s.classes.some((c) => c.classId === enrollment?.classId),
  );
  if (candidates.length === 0) {
    throw new Error('No active fee structure covers this student — cannot compute monthly fees.');
  }
  // Prefer a structure scoped to the class over a branch-wide one.
  const chosen = candidates.find((s) => s.classes.length > 0) ?? candidates[0];
  const monthly = chosen.lines.filter((l) => l.frequency === 'MONTHLY');
  if (monthly.length === 0) {
    throw new Error('The fee structure has no monthly lines — advance collection needs monthly fee heads.');
  }
  return {
    lines: monthly.map((l) => ({
      feeHeadId: l.feeHeadId,
      amount: Number(l.amount),
      discount: 0,
      description: `${l.feeHead.name} (advance)`,
    })),
  };
}

/**
 * Collect `months` months of fees in advance, in cash, at the counter.
 * 1. Generate the missing monthly invoices (idempotent numbers).
 * 2. Post ONE CASH payment for the total; postPayment allocates
 *    oldest-due-first across the student's open dues and enforces §269ST.
 */
export async function collectAdvance(prisma: PrismaClient, input: {
  branchId: string;
  studentId: string;
  academicYearId: string;
  months: number;
  /** Optional explicit month keys (YYYY-MM); defaults to the next N months. */
  monthKeys?: string[];
  createdBy?: string | null;
}): Promise<CollectAdvanceResult> {
  const now = new Date();
  const structure = await activeMonthlyStructure(prisma, input.branchId, input.academicYearId, input.studentId);

  const windows: Array<{ periodStart: Date; periodEnd: Date; key: string }> = [];
  if (input.monthKeys?.length) {
    for (const key of input.monthKeys) {
      const [y, m] = key.split('-').map(Number);
      if (!y || !m || m < 1 || m > 12) throw new Error(`Invalid month key: ${key}`);
      windows.push(monthWindow(new Date(Date.UTC(y, m - 1, 15)), 0));
    }
  } else {
    for (let i = 1; i <= input.months; i += 1) windows.push(monthWindow(now, i));
  }

  // 1. Generate missing invoices (idempotent by number — an existing ADV-…
  //    invoice for the same month is reused, never duplicated).
  const invoiceIds: string[] = [];
  let generated = 0;
  for (const w of windows) {
    const invoiceNo = advanceInvoiceNo(input.branchId, input.studentId, w.key);
    const existing = await prisma.invoice.findUnique({
      where: { branchId_invoiceNo: { branchId: input.branchId, invoiceNo } },
      select: { id: true },
    });
    if (existing) { invoiceIds.push(existing.id); continue; }
    const invoice = await postDemand(prisma, {
      branchId: input.branchId,
      academicYearId: input.academicYearId,
      studentId: input.studentId,
      lines: structure.lines,
      dueDate: w.periodEnd,
      periodStart: w.periodStart,
      periodEnd: w.periodEnd,
      invoiceNo,
      status: 'ISSUED',
      createdBy: input.createdBy ?? null,
    });
    invoiceIds.push(invoice.id);
    generated += 1;
  }

  // 2. What the counter must take: outstanding on all advance invoices.
  const targets = await prisma.invoice.findMany({
    where: { id: { in: invoiceIds }, deletedAt: null },
    orderBy: { dueDate: 'asc' },
  });
  const total = targets.reduce((s, inv) => s + Math.max(0, Number(inv.totalAmount) - Number(inv.paidAmount)), 0);
  if (total <= 0) {
    return { payment: { id: '', receiptNo: null, amount: 0, method: 'CASH' }, generatedInvoices: generated, allocations: [], advanceCredit: 0 };
  }

  // 3. One cash payment — §269ST and allocation handled inside postPayment.
  const result = await postPayment(prisma, {
    branchId: input.branchId,
    academicYearId: input.academicYearId,
    studentId: input.studentId,
    amount: total,
    method: 'CASH',
    invoiceIds,
    idempotencyKey: `ADV-${input.studentId}-${windows.map((w) => w.key).join('_')}-${Date.now()}`,
    createdBy: input.createdBy ?? null,
  });

  return {
    payment: result.payment,
    generatedInvoices: generated,
    allocations: result.allocations,
    advanceCredit: 0,
  };
}
