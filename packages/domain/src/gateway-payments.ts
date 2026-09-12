// ──────────────────────────────────────────────
// Gateway payment lifecycle (BUILD_PLAN 4.1)
//
// The DB row is the source of truth — never the webhook payload. An order
// creates an INITIATED Payment; capture flips it to SUCCESS *inside the same
// transaction* that allocates, updates invoices and posts ledger entries.
//
// Race safety: concurrent webhook + checkout-verify both try to claim the row
// with a conditional `updateMany({ where: { id, status: 'INITIATED' } })`.
// Exactly one caller's update reports count 1 — it wins and runs the money
// transaction. The loser re-reads the row and gets the already-captured
// payment (idempotent, no double allocation, no double ledger entry).
// ──────────────────────────────────────────────

import type { PrismaClient, Payment } from '@prisma/client';
import type { PaymentMethod } from '@prisma/client';

export interface CaptureGatewayInput {
  paymentId: string;
  gatewayPaymentId: string;
  /** Authoritative amount from the gateway in paise/rupee-units of the order. */
  amount: number;
  method?: PaymentMethod;
  rawEvent?: unknown;
  paidAt?: Date;
}

export interface CaptureResult {
  captured: boolean;
  /** Why capture was refused — empty when captured. */
  reason?: 'AMOUNT_MISMATCH' | 'ALREADY_CAPTURED' | 'NOT_INITIATED';
  payment?: {
    id: string;
    amount: number;
    method: string;
    status: string;
    receiptNo: string | null;
    idempotencyKey: string | null;
  };
}

/**
 * Mark a gateway payment captured and run the FULL money transaction:
 * allocation across open invoices, invoice status updates, PAYMENT ledger
 * entries. Uses the payment's own idempotencyKey (set at order creation) so
 * the domain engine's replay guard is the second line of defense.
 *
 * Returns `captured: false` with a reason when the DB row disagrees with the
 * gateway event — the caller turns that into a 4xx, and reconciliation
 * flags the row for a human.
 */
export async function captureGatewayPayment(
  prisma: PrismaClient,
  input: CaptureGatewayInput,
): Promise<CaptureResult> {
  const row = await prisma.payment.findUnique({ where: { id: input.paymentId } });
  if (!row) return { captured: false, reason: 'NOT_INITIATED' };

  // The row's amount is the contract. A gateway "success" for a different
  // amount is exactly the tampering / misconfiguration case GATE 4 guards.
  if (Number(row.amount) !== input.amount) {
    return { captured: false, reason: 'AMOUNT_MISMATCH' };
  }

  if (row.status === 'SUCCESS') {
    // Already captured (duplicate webhook or verify race) — idempotent ack.
    return { captured: false, reason: 'ALREADY_CAPTURED', payment: toPublic(row) };
  }
  if (row.status !== 'INITIATED') {
    return { captured: false, reason: 'NOT_INITIATED' };
  }

  // Claim: the conditional update wins for exactly one concurrent caller.
  const claim = await prisma.payment.updateMany({
    where: { id: row.id, status: 'INITIATED' },
    data: { status: 'PENDING' },
  });
  if (claim.count === 0) {
    const fresh = await prisma.payment.findUniqueOrThrow({ where: { id: row.id } });
    return { captured: false, reason: 'ALREADY_CAPTURED', payment: toPublic(fresh) };
  }

  try {
    const { postPayment } = await import('./fees');
    void postPayment;
    // The intent's placeholder key (`intent:<uuid>`) is REPLACED here: the
    // capture's idempotency key is derived from the gateway payment id, so a
    // replayed webhook hits `postPayment`'s replay guard even if the claim
    // race were ever lost. The claim (INITIATED→PENDING) already excludes
    // concurrent captures; this is the second, independent lock.
    const captureKey = `rzp:${input.gatewayPaymentId}`;
    const result = await postPayment(prisma, {
      branchId: row.branchId,
      academicYearId: row.academicYearId,
      studentId: row.studentId,
      amount: Number(row.amount),
      method: input.method ?? row.method,
      idempotencyKey: captureKey,
      existingPaymentId: row.id, // update the intent row IN PLACE
      gatewayOrderId: row.gatewayOrderId,
      gatewayPaymentId: input.gatewayPaymentId,
      gatewayProvider: 'RAZORPAY',
      rawWebhook: input.rawEvent,
      paidAt: input.paidAt ?? new Date(),
    });
    return { captured: true, payment: result.payment };
  } catch (err) {
    // Release the claim so a corrected webhook / reconcile can retry.
    await prisma.payment.updateMany({
      where: { id: row.id, status: 'PENDING' },
      data: { status: 'INITIATED' },
    });
    throw err;
  }
}

/** Fail an intent (checkout abandoned, gateway reported failure). */
export async function failGatewayPayment(
  prisma: PrismaClient,
  paymentId: string,
  reason: string,
): Promise<boolean> {
  const claim = await prisma.payment.updateMany({
    where: { id: paymentId, status: 'INITIATED' },
    data: { status: 'FAILED' },
  });
  if (claim.count === 0) return false;
  await prisma.payment.update({
    where: { id: paymentId },
    data: { rawWebhook: { failure: reason, at: new Date().toISOString() } },
  });
  return true;
}

export interface RefundGatewayInput {
  paymentId: string;
  amount: number;
  reason: string;
  /** Gateway refund id, when the refund was initiated via API. */
  gatewayRefundId?: string;
  createdBy?: string | null;
}

export interface RefundResult {
  refundId: string;
  amount: number;
  /** Ledger entries posted for the reversal, newest first. */
  reversals: Array<{ invoiceId: string | null; amount: number }>;
}

/**
 * Refund a captured payment: reversal ledger entries (REFUND, positive = the
 * money becomes a due again) and proportional un-allocation so the invoices'
 * paidAmount goes back down and the GATE-2 tie-out (ledger balance == sum of
 * invoice balances) still holds. Partial refunds un-allocate in reverse
 * allocation order (newest dues refunded first).
 */
export async function refundGatewayPayment(
  prisma: PrismaClient,
  input: RefundGatewayInput,
): Promise<RefundResult> {
  return prisma.$transaction(async (tx) => {
    const payment = await tx.payment.findUnique({
      where: { id: input.paymentId },
      include: { allocations: { include: { invoice: true }, orderBy: { allocatedAt: 'desc' } } },
    });
    if (!payment) throw new Error('Payment not found.');
    if (payment.status !== 'SUCCESS') {
      throw new Error(`Only SUCCESS payments can be refunded (this one is ${payment.status}).`);
    }

    const raw = (payment.rawWebhook ?? {}) as Record<string, unknown>;
    const alreadyRefunded = Number(raw['refunded'] ?? 0);
    const refundable = Number(payment.amount) - alreadyRefunded;
    if (input.amount <= 0 || input.amount > refundable + 1e-6) {
      throw new Error(`Refund amount must be between 0 and ₹${refundable}.`);
    }

    // Un-allocate proportionally, newest allocation first.
    let remaining = input.amount;
    const reversals: Array<{ invoiceId: string | null; amount: number }> = [];
    for (const alloc of payment.allocations) {
      if (remaining <= 1e-6) break;
      const take = Math.min(remaining, Number(alloc.amount));
      if (take <= 0) continue;
      await tx.paymentAllocation.update({
        where: { id: alloc.id },
        data: { amount: Number(alloc.amount) - take },
      });
      const invoice = alloc.invoice;
      const newPaid = Number(invoice.paidAmount) - take;
      const newStatus =
        newPaid <= 1e-6
          ? invoice.status === 'PAID'
            ? 'ISSUED'
            : invoice.status
          : newPaid < Number(invoice.totalAmount) - 1e-6
            ? 'PARTIALLY_PAID'
            : invoice.status;
      await tx.invoice.update({
        where: { id: invoice.id },
        data: { paidAmount: newPaid, status: newStatus },
      });
      await tx.feeLedger.create({
        data: {
          studentId: payment.studentId,
          branchId: payment.branchId,
          academicYearId: payment.academicYearId,
          type: 'REFUND',
          amount: take, // positive: the money leaves the school's books as paid
          paymentId: payment.id,
          invoiceId: invoice.id,
          description: `Refund: ${input.reason}`,
          reference: input.gatewayRefundId ?? payment.receiptNo,
          createdBy: input.createdBy ?? null,
        },
      });
      reversals.push({ invoiceId: invoice.id, amount: take });
      remaining -= take;
    }

    await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: input.amount >= Number(payment.amount) - 1e-6 ? 'REFUNDED' : 'SUCCESS',
        rawWebhook: { ...(payment.rawWebhook as object), refunded: alreadyRefunded + input.amount },
      },
    });

    return { refundId: input.gatewayRefundId ?? `RFND-${payment.receiptNo ?? payment.id}`, amount: input.amount, reversals };
  });
}

function toPublic(p: Payment) {
  return {
    id: p.id,
    amount: Number(p.amount),
    method: p.method,
    status: p.status,
    receiptNo: p.receiptNo,
    idempotencyKey: p.idempotencyKey,
  };
}
