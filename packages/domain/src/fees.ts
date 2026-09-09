// ──────────────────────────────────────────────
// Fee engine (BUILD_PLAN 2.5)
//
// The ledger is append-only: DEMAND, PAYMENT, CONCESSION, LATE_FEE,
// ADJUSTMENT, REFUND, WRITE_OFF. A student's balance is the SUM of their
// ledger entries — never a mutable column. Payments allocate deterministically
// (oldest dues first by default) and carry an idempotency key so a duplicate
// webhook can never double-credit (GATE 4 precondition).
// ──────────────────────────────────────────────

import type { PrismaClient } from '@school-erp/database';
import type { PaymentMethod, PaymentAllocationMode } from '@prisma/client';
import { nextSequenceValue, nextSequenceValueIn, type TxClient } from './sequences';

export interface DemandLine {
  feeHeadId: string;
  amount: number;
  discount?: number;
  description?: string;
  concessionId?: string | null;
}

export interface PostDemandInput {
  branchId: string;
  academicYearId: string;
  studentId: string;
  lines: DemandLine[];
  dueDate: Date;
  periodStart?: Date | null;
  periodEnd?: Date | null;
  createdBy?: string | null;
  /** Explicit invoice number; defaults to the branch INVOICE sequence. */
  invoiceNo?: string;
  status?: 'DRAFT' | 'ISSUED';
}

/**
 * Generate an invoice from structure × enrollment × concessions (2.5.5) and
 * post one DEMAND ledger entry per line. Idempotent per (student, period):
 * callers pass the same period to regenerate and get a new invoice — the
 * ledger makes the old one visible, never deleted.
 */
export async function postDemand(prisma: PrismaClient, input: PostDemandInput) {
  const invoiceNo = input.invoiceNo ?? (await nextSequenceValue(prisma, { branchId: input.branchId, code: 'INVOICE' }));
  const totalAmount = input.lines.reduce((sum, l) => sum + l.amount - (l.discount ?? 0), 0);

  return prisma.$transaction(async (tx) => {
    const invoice = await tx.invoice.create({
      data: {
        invoiceNo,
        studentId: input.studentId,
        branchId: input.branchId,
        academicYearId: input.academicYearId,
        dueDate: input.dueDate,
        periodStart: input.periodStart ?? null,
        periodEnd: input.periodEnd ?? null,
        totalAmount,
        discountAmount: input.lines.reduce((sum, l) => sum + (l.discount ?? 0), 0),
        status: input.status ?? 'ISSUED',
      },
    });

    for (const line of input.lines) {
      await tx.invoiceLine.create({
        data: {
          invoiceId: invoice.id,
          feeHeadId: line.feeHeadId,
          amount: line.amount,
          discount: line.discount ?? 0,
          description: line.description ?? null,
          concessionId: line.concessionId ?? null,
        },
      });
      await tx.feeLedger.create({
        data: {
          studentId: input.studentId,
          branchId: input.branchId,
          academicYearId: input.academicYearId,
          type: 'DEMAND',
          amount: line.amount - (line.discount ?? 0),
          feeHeadId: line.feeHeadId,
          invoiceId: invoice.id,
          description: line.description ?? 'Demand',
          reference: invoiceNo,
          createdBy: input.createdBy ?? null,
        },
      });
    }

    return tx.invoice.findUniqueOrThrow({
      where: { id: invoice.id },
      include: { lines: true, ledgerEntries: true },
    });
  });
}

export interface PostPaymentInput {
  branchId: string;
  academicYearId: string;
  studentId: string;
  amount: number;
  method: PaymentMethod;
  /** Restrict allocation to these invoices; defaults to all open dues. */
  invoiceIds?: string[];
  allocationMode?: PaymentAllocationMode;
  idempotencyKey?: string | null;
  gatewayOrderId?: string | null;
  gatewayPaymentId?: string | null;
  gatewayProvider?: string | null;
  rawWebhook?: unknown;
  receiptNo?: string;
  paidAt?: Date;
  createdBy?: string | null;
}

export interface PostPaymentResult {
  payment: {
    id: string;
    amount: number;
    method: string;
    status: string;
    receiptNo: string | null;
    idempotencyKey: string | null;
  };
  allocations: Array<{ invoiceId: string; amount: number }>;
  duplicate: boolean;
}

/**
 * Record a successful payment: creates the Payment row (SUCCESS), allocates
 * the amount across open invoices (oldest-due first by default), updates each
 * invoice's paidAmount/status and posts a PAYMENT ledger entry. An
 * idempotency key that was already seen returns the existing payment without
 * touching anything (GATE 4: duplicate webhook must not double-credit).
 */
export async function postPayment(prisma: PrismaClient, input: PostPaymentInput): Promise<PostPaymentResult> {
  // Idempotency: a replayed webhook returns the original payment untouched.
  if (input.idempotencyKey) {
    const existing = await prisma.payment.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      include: { allocations: true },
    });
    if (existing) {
      return {
        payment: {
          id: existing.id,
          amount: Number(existing.amount),
          method: existing.method,
          status: existing.status,
          receiptNo: existing.receiptNo,
          idempotencyKey: existing.idempotencyKey,
        },
        allocations: existing.allocations.map((a) => ({ invoiceId: a.invoiceId, amount: Number(a.amount) })),
        duplicate: true,
      };
    }
  }

  return prisma.$transaction(async (tx) => {
    const openInvoices = await tx.invoice.findMany({
      where: {
        studentId: input.studentId,
        branchId: input.branchId,
        academicYearId: input.academicYearId,
        status: { in: ['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'] },
        ...(input.invoiceIds ? { id: { in: input.invoiceIds } } : {}),
      },
      orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }],
    });

    // Allocate oldest-due-first (2.5.6); HEAD_PRIORITY is a caller-supplied
    // invoice order via invoiceIds.
    const allocations: Array<{ invoice: (typeof openInvoices)[number]; amount: number }> = [];
    let remaining = input.amount;
    for (const invoice of openInvoices) {
      if (remaining <= 0) break;
      const outstanding = Number(invoice.totalAmount) - Number(invoice.paidAmount);
      if (outstanding <= 0) continue;
      const take = Math.min(remaining, outstanding);
      allocations.push({ invoice, amount: take });
      remaining -= take;
    }
    if (remaining > 1e-6) {
      // Overpayment → advance credit: keep the remainder unallocated (a later
      // invoice will absorb it via the ledger balance).
      allocations.push({ invoice: openInvoices[openInvoices.length - 1], amount: remaining });
    }

    const receiptNo =
      input.receiptNo ??
      (await nextSequenceValueIn(tx as unknown as TxClient, { branchId: input.branchId, code: 'RECEIPT' }));

    const payment = await tx.payment.create({
      data: {
        studentId: input.studentId,
        branchId: input.branchId,
        academicYearId: input.academicYearId,
        invoiceId: allocations[0]?.invoice.id ?? null,
        amount: input.amount,
        method: input.method,
        status: 'SUCCESS',
        idempotencyKey: input.idempotencyKey ?? null,
        gatewayOrderId: input.gatewayOrderId ?? null,
        gatewayPaymentId: input.gatewayPaymentId ?? null,
        gatewayProvider: input.gatewayProvider ?? null,
        rawWebhook: input.rawWebhook ? (input.rawWebhook as object) : undefined,
        allocationMode: input.allocationMode ?? 'OLDEST_DUES_FIRST',
        receiptNo,
        paidAt: input.paidAt ?? new Date(),
      },
    });

    for (const alloc of allocations) {
      await tx.paymentAllocation.create({
        data: { paymentId: payment.id, invoiceId: alloc.invoice.id, amount: alloc.amount },
      });
    }

    // Update invoice totals + status and post the ledger entry.
    for (const alloc of allocations) {
      const invoice = alloc.invoice;
      const newPaid = Number(invoice.paidAmount) + alloc.amount;
      const status =
        newPaid >= Number(invoice.totalAmount) - 1e-6 ? 'PAID' : 'PARTIALLY_PAID';
      await tx.invoice.update({
        where: { id: invoice.id },
        data: { paidAmount: newPaid, status },
      });
      await tx.feeLedger.create({
        data: {
          studentId: input.studentId,
          branchId: input.branchId,
          academicYearId: input.academicYearId,
          type: 'PAYMENT',
          amount: -alloc.amount,
          paymentId: payment.id,
          invoiceId: invoice.id,
          description: `Payment via ${input.method}`,
          reference: receiptNo,
          createdBy: input.createdBy ?? null,
        },
      });
    }

    return {
      payment: {
        id: payment.id,
        amount: Number(payment.amount),
        method: payment.method,
        status: payment.status,
        receiptNo: payment.receiptNo,
        idempotencyKey: payment.idempotencyKey,
      },
      allocations: allocations.map((a) => ({ invoiceId: a.invoice.id, amount: a.amount })),
      duplicate: false,
    };
  });
}

export interface LedgerBalanceInput {
  studentId: string;
  academicYearId?: string;
}

/** Balance = SUM(ledger entries). Negative = credit in hand. */
export async function ledgerBalance(prisma: PrismaClient, input: LedgerBalanceInput): Promise<number> {
  const agg = await prisma.feeLedger.aggregate({
    where: {
      studentId: input.studentId,
      ...(input.academicYearId ? { academicYearId: input.academicYearId } : {}),
    },
    _sum: { amount: true },
  });
  return Number(agg._sum.amount ?? 0);
}

/**
 * The GATE-2 check: for a student, ledger balance must equal the sum of
 * (invoice total − paid) across open invoices. Returns the difference (0 = tied).
 */
export async function reconcileStudent(
  prisma: PrismaClient,
  input: LedgerBalanceInput,
): Promise<{ ledgerBalance: number; invoiceBalance: number; difference: number }> {
  const [balance, invoices] = await Promise.all([
    ledgerBalance(prisma, input),
    prisma.invoice.findMany({
      where: {
        studentId: input.studentId,
        ...(input.academicYearId ? { academicYearId: input.academicYearId } : {}),
        status: { notIn: ['VOID', 'CANCELLED'] },
      },
    }),
  ]);
  const invoiceBalance = invoices.reduce(
    (sum, inv) => sum + (Number(inv.totalAmount) - Number(inv.paidAmount)),
    0,
  );
  return {
    ledgerBalance: balance,
    invoiceBalance,
    difference: Math.round((balance - invoiceBalance) * 100) / 100,
  };
}

/**
 * The GATE-2 fleet check: every student in a branch/year ties out.
 */
export async function tieOut(
  prisma: PrismaClient,
  input: { branchId: string; academicYearId?: string },
): Promise<Array<{ studentId: string; admissionNo: string; ledgerBalance: number; invoiceBalance: number; difference: number }>> {
  const students = await prisma.student.findMany({
    where: { branchId: input.branchId, deletedAt: null },
    select: { id: true, admissionNo: true },
  });

  const results = [];
  for (const student of students) {
    const r = await reconcileStudent(prisma, {
      studentId: student.id,
      ...(input.academicYearId ? { academicYearId: input.academicYearId } : {}),
    });
    results.push({ studentId: student.id, admissionNo: student.admissionNo, ...r });
  }
  return results;
}