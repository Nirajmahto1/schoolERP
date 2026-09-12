// ──────────────────────────────────────────────
// Payment methods & collections (BUILD_PLAN 4.1.3 / 4.1.5 / 4.1.8)
//
// Cheques are a promise, not money: the ledger is credited when the parent
// hands over the instrument, but the school's risk window ends only when the
// bank credits the deposit. The lifecycle is therefore explicit —
// RECEIVED → DEPOSITED → CREDITED, with BOUNCED as the scandal path that
// reverses the credit and books a penalty. Every transition writes audit
// context on the cheque row; nothing is ever deleted.
//
// Virtual accounts (4.1.3): one NEFT sub-account per student; the bank's
// narration carries the account number, so inbound NEFTs auto-match.
//
// Dues carry-forward (4.1.5): at year roll, each student's ledger balance is
// re-demanded into the new year as a single DEMAND line, so the new year's
// invoice view agrees with the ledger (the GATE-2 tie-out).
// ──────────────────────────────────────────────

import type { PrismaClient } from '@school-erp/database';
import { nextSequenceValue } from './sequences';

export interface ReceiveChequeInput {
  branchId: string;
  studentId: string;
  academicYearId: string;
  amount: number;
  chequeNumber: string;
  bankName: string;
  branchName?: string;
  drawerName?: string;
  chequeDate: Date;
  invoiceIds?: string[];
  createdBy?: string | null;
}

export interface ReceiveChequeResult {
  paymentId: string;
  chequeId: string;
  receiptNo: string;
  chequeStatus: string;
}

/**
 * Record a cheque: the payment posts IMMEDIATELY (the parent has handed over
 * a signed instrument — the school shows the fee as covered), and the cheque
 * row tracks the risk window. Bounce reverses via `bounceCheque`.
 */
export async function receiveCheque(prisma: PrismaClient, input: ReceiveChequeInput): Promise<ReceiveChequeResult> {
  const receiptNo = await nextSequenceValue(prisma, { branchId: input.branchId, code: 'RECEIPT' });
  return prisma.$transaction(async (tx) => {
    // Reuse the domain payment engine for allocation + ledger; the cheque
    // metadata rides on the Payment row.
    const { postPayment } = await import('./fees');
    const result = await postPayment(prisma, {
      branchId: input.branchId,
      academicYearId: input.academicYearId,
      studentId: input.studentId,
      amount: input.amount,
      method: 'CHEQUE',
      invoiceIds: input.invoiceIds,
      receiptNo,
      createdBy: input.createdBy,
    });
    const paymentId = result.payment.id;

    const cheque = await tx.chequePayment.create({
      data: {
        paymentId,
        branchId: input.branchId,
        chequeNumber: input.chequeNumber,
        bankName: input.bankName,
        branchName: input.branchName,
        drawerName: input.drawerName,
        chequeDate: input.chequeDate,
        status: 'RECEIVED',
      },
    });

    // Mark the payment as cheque-backed (audit: method alone is too coarse).
    await tx.payment.update({
      where: { id: paymentId },
      data: { rawWebhook: { instrument: 'CHEQUE', chequeId: cheque.id } },
    });

    return { paymentId, chequeId: cheque.id, receiptNo: result.payment.receiptNo ?? receiptNo, chequeStatus: cheque.status };
  });
}

export async function markChequeDeposited(
  prisma: PrismaClient,
  chequeId: string,
  opts: { bankDepositId?: string | null; depositedAt?: Date } = {},
): Promise<{ chequeId: string; status: string }> {
  const cheque = await prisma.chequePayment.findUnique({ where: { id: chequeId } });
  if (!cheque) throw new Error('Cheque not found.');
  if (cheque.status !== 'RECEIVED') {
    throw new Error(`Only RECEIVED cheques can be deposited (this one is ${cheque.status}).`);
  }
  const updated = await prisma.chequePayment.update({
    where: { id: chequeId },
    data: { status: 'DEPOSITED', depositedAt: opts.depositedAt ?? new Date(), bankDepositId: opts.bankDepositId ?? null },
  });
  return { chequeId: updated.id, status: updated.status };
}

export interface BounceChequeResult {
  chequeId: string;
  status: string;
  reversalLedgerId: string;
  penaltyLedgerId: string;
  penaltyAmount: number;
}

/**
 * CHEQUE BOUNCE (4.1.8): the payment was never real money.
 *   1. REFUND reversal entries (positive) restore the dues on each invoice
 *      that the payment had covered, proportionally.
 *   2. A LATE_FEE penalty entry books the bounce charge — a new due.
 *   3. The payment is marked DISPUTED (never deleted) and the cheque BOUNCED.
 * The invoice statuses are recomputed so the GATE-2 tie-out holds.
 */
export async function bounceCheque(
  prisma: PrismaClient,
  chequeId: string,
  input: { reason: string; penaltyAmount?: number; bouncedAt?: Date; createdBy?: string | null },
): Promise<BounceChequeResult> {
  const cheque = await prisma.chequePayment.findUnique({ where: { id: chequeId }, include: { payment: true } });
  if (!cheque) throw new Error('Cheque not found.');
  if (cheque.status === 'BOUNCED') throw new Error('Cheque was already bounced.');
  if (cheque.status === 'RETURNED_TO_PARENT') throw new Error('A returned cheque was never credited.');

  const penalty = input.penaltyAmount ?? 500; // §4.1.8 penalty entry; configurable per school policy
  const payment = cheque.payment;
  if (payment.status !== 'SUCCESS') throw new Error(`Underlying payment is ${payment.status}; only SUCCESS can bounce.`);

  return prisma.$transaction(async (tx) => {
    const allocations = await tx.paymentAllocation.findMany({
      where: { paymentId: payment.id },
      include: { invoice: true },
      orderBy: { allocatedAt: 'desc' },
    });

    const reversals: Array<{ invoiceId: string }> = [];
    for (const alloc of allocations) {
      const invoice = alloc.invoice;
      const newPaid = Number(invoice.paidAmount) - Number(alloc.amount);
      const newStatus = newPaid <= 1e-6 ? (new Date(invoice.dueDate) < new Date() ? 'OVERDUE' : 'ISSUED') : 'PARTIALLY_PAID';
      await tx.invoice.update({
        where: { id: invoice.id },
        data: { paidAmount: newPaid, status: newStatus },
      });
      // REFUND reversal: the "money" leaves the books; the fee is owed again.
      await tx.feeLedger.create({
        data: {
          studentId: payment.studentId,
          branchId: payment.branchId,
          academicYearId: payment.academicYearId,
          type: 'REFUND',
          amount: Number(alloc.amount),
          paymentId: payment.id,
          invoiceId: invoice.id,
          description: `Cheque ${cheque.chequeNumber} bounced: ${input.reason}`,
          reference: cheque.chequeNumber,
          createdBy: input.createdBy ?? null,
        },
      });
      reversals.push({ invoiceId: invoice.id });
    }

    // Penalty: LATE_FEE is a positive (due) entry per the ledger sign chart.
    const penaltyEntry = await tx.feeLedger.create({
      data: {
        studentId: payment.studentId,
        branchId: payment.branchId,
        academicYearId: payment.academicYearId,
        type: 'LATE_FEE',
        amount: penalty,
        description: `Bounce penalty for cheque ${cheque.chequeNumber}: ${input.reason}`,
        reference: cheque.chequeNumber,
        createdBy: input.createdBy ?? null,
      },
    });

    await tx.chequePayment.update({
      where: { id: cheque.id },
      data: {
        status: 'BOUNCED',
        bounceReason: input.reason,
        bouncedAt: input.bouncedAt ?? new Date(),
        penaltyLedgerId: penaltyEntry.id,
      },
    });
    await tx.payment.update({ where: { id: payment.id }, data: { status: 'DISPUTED' } });

    return {
      chequeId: cheque.id,
      status: 'BOUNCED',
      reversalLedgerId: reversals[0]?.invoiceId ?? '',
      penaltyLedgerId: penaltyEntry.id,
      penaltyAmount: penalty,
    };
  });
}

export async function markChequeCredited(prisma: PrismaClient, chequeId: string): Promise<{ chequeId: string; status: string }> {
  const cheque = await prisma.chequePayment.findUnique({ where: { id: chequeId } });
  if (!cheque) throw new Error('Cheque not found.');
  if (cheque.status !== 'DEPOSITED') throw new Error(`Only DEPOSITED cheques can be credited (this one is ${cheque.status}).`);
  const updated = await prisma.chequePayment.update({ where: { id: chequeId }, data: { status: 'CREDITED' } });
  return { chequeId: updated.id, status: updated.status };
}

export interface CreateBankDepositInput {
  branchId: string;
  depositedAt: Date;
  bankName?: string;
  chequeIds?: string[];
  notes?: string;
  createdBy?: string | null;
}

/**
 * Prepare a bank deposit slip: bundles cash + cheques for one branch visit to
 * the bank. Cheque totals are computed from the bundled instruments, and each
 * cheque moves to DEPOSITED. Slip number comes from the branch DEPOSIT sequence.
 */
export async function createBankDeposit(prisma: PrismaClient, input: CreateBankDepositInput) {
  const slipNo = await nextSequenceValue(prisma, { branchId: input.branchId, code: 'DEPOSIT' });
  return prisma.$transaction(async (tx) => {
    const cheques = input.chequeIds?.length
      ? await tx.chequePayment.findMany({ where: { id: { in: input.chequeIds }, branchId: input.branchId, status: 'RECEIVED' } })
      : [];
    const totalCheques = await cheques.reduce(async (sumPromise, c) => {
      const sum = await sumPromise;
      const p = await tx.payment.findUnique({ where: { id: c.paymentId }, select: { amount: true } });
      return sum + Number(p?.amount ?? 0);
    }, Promise.resolve(0));

    const deposit = await tx.bankDeposit.create({
      data: {
        branchId: input.branchId,
        depositSlipNo: slipNo,
        depositedAt: input.depositedAt,
        totalCheques,
        bankName: input.bankName,
        notes: input.notes,
        createdBy: input.createdBy ?? null,
        cheques: { connect: cheques.map((c) => ({ id: c.id })) },
      },
    });

    for (const c of cheques) {
      await tx.chequePayment.update({
        where: { id: c.id },
        data: { status: 'DEPOSITED', depositedAt: input.depositedAt, bankDepositId: deposit.id },
      });
    }
    return deposit;
  });
}

export interface MarkDepositCreditedInput {
  depositId: string;
  creditedAt?: Date;
}

/** The bank confirmed the deposit: cheques close as CREDITED (risk window over). */
export async function markDepositCredited(prisma: PrismaClient, input: MarkDepositCreditedInput) {
  const deposit = await prisma.bankDeposit.findUnique({ where: { id: input.depositId }, include: { cheques: true } });
  if (!deposit) throw new Error('Deposit not found.');
  if (deposit.status === 'CREDITED') throw new Error('Deposit was already credited.');
  const at = input.creditedAt ?? new Date();
  return prisma.$transaction(async (tx) => {
    await tx.bankDeposit.update({ where: { id: deposit.id }, data: { status: 'CREDITED', creditedAt: at } });
    for (const c of deposit.cheques) {
      if (c.status === 'DEPOSITED') {
        await tx.chequePayment.update({ where: { id: c.id }, data: { status: 'CREDITED' } });
      }
    }
    return { depositId: deposit.id, creditedCheques: deposit.cheques.filter((c) => c.status === 'DEPOSITED').length };
  });
}

export interface EnsureVirtualAccountInput {
  branchId: string;
  studentId: string;
  accountNumber: string;
  ifsc: string;
  beneficiaryName: string;
  provider?: string;
}

/** Idempotent per student: a second call returns the existing VA. */
export async function ensureVirtualAccount(prisma: PrismaClient, input: EnsureVirtualAccountInput) {
  const existing = await prisma.virtualAccount.findUnique({ where: { studentId: input.studentId } });
  if (existing) return { virtualAccount: existing, created: false };
  const va = await prisma.virtualAccount.create({
    data: {
      branchId: input.branchId,
      studentId: input.studentId,
      accountNumber: input.accountNumber,
      ifsc: input.ifsc,
      beneficiaryName: input.beneficiaryName,
      provider: input.provider ?? 'RAZORPAY',
    },
  });
  return { virtualAccount: va, created: true };
}

export interface CarryForwardResult {
  studentId: string;
  balance: number;
  invoiceNo: string | null;
  skipped: boolean;
  reason?: string;
}

/**
 * Dues carry-forward (4.1.5): a student's closing balance for the old year is
 * re-demanded into the new year as a single DEMAND line (fee head = the
 * branch's MISCELLANEOUS head, description "Carried forward from {year}").
 * Zero and credit balances are skipped — credits stay visible in the old year
 * and can be refunded there.
 */
export async function carryForwardDues(
  prisma: PrismaClient,
  input: { branchId: string; fromAcademicYearId: string; toAcademicYearId: string; dryRun?: boolean; createdBy?: string | null },
): Promise<CarryForwardResult[]> {
  const { ledgerBalance } = await import('./fees');
  const students = await prisma.student.findMany({
    where: { branchId: input.branchId, deletedAt: null },
    select: { id: true },
  });

  const results: CarryForwardResult[] = [];
  for (const { id: studentId } of students) {
    const balance = await ledgerBalance(prisma, { studentId, academicYearId: input.fromAcademicYearId });
    if (balance <= 1e-6) {
      results.push({ studentId, balance, invoiceNo: null, skipped: true, reason: balance < -1e-6 ? 'credit balance' : 'no dues' });
      continue;
    }

    if (input.dryRun) {
      results.push({ studentId, balance, invoiceNo: null, skipped: false });
      continue;
    }

    // The carrying head: branch MISCELLANEOUS fee head (created on demand).
    const head = await prisma.feeHead.upsert({
      where: { branchId_code: { branchId: input.branchId, code: 'CARRYFWD' } },
      update: {},
      create: { branchId: input.branchId, code: 'CARRYFWD', name: 'Carried Forward Dues', type: 'MISCELLANEOUS', isRecurring: false },
    });

    const { postDemand } = await import('./fees');
    const invoice = await postDemand(prisma, {
      branchId: input.branchId,
      studentId,
      academicYearId: input.toAcademicYearId,
      lines: [{ feeHeadId: head.id, amount: balance, description: 'Dues carried forward' }],
      dueDate: new Date(new Date().getFullYear(), 3, 30), // April 30 of the new year
      createdBy: input.createdBy ?? null,
    });

    results.push({ studentId, balance, invoiceNo: invoice.invoiceNo, skipped: false });
  }
  return results;
}
