// ──────────────────────────────────────────────
// Messaging credit envelope (BUILD_PLAN 5.7)
//
// "Credit metering + top-up so messaging costs pass through to the school
// rather than eating your margin."
//
// One envelope per tenant in the control plane. The dispatcher calls
// `tryDecrement` per cost-carrying send — an atomic conditional update, so
// two concurrent drainers can never drive the balance negative. Top-ups
// come with a Rule-46 tax invoice (SAC 997331, same as the subscription).
// The low-balance flag trips once at 10% and clears on top-up — the
// console card and a dunning-style event surface it to humans.
// ──────────────────────────────────────────────

import type { PrismaClient as ControlPlaneClient } from '@school-erp/control-plane';

export const LOW_BALANCE_FRACTION = 0.1;

export interface CreditTopUpResult {
  envelopeId: string;
  balance: number;
  purchasedTotal: number;
}

/**
 * Add message units to a tenant's envelope (creating it on first purchase).
 * The SaasInvoice for the top-up is issued by the caller (billing.convert/
 * issueRenewal pattern) — this function only owns the envelope math.
 */
export async function topUpCredits(
  cp: ControlPlaneClient,
  tenantId: string,
  units: number,
): Promise<CreditTopUpResult> {
  if (!Number.isInteger(units) || units <= 0) {
    throw new Error('Credit top-up must be a positive whole number of units.');
  }
  const envelope = await cp.creditEnvelope.upsert({
    where: { tenantId },
    create: { tenantId, balance: units, purchased: units, lowBalanceAt: null },
    update: {
      balance: { increment: units },
      purchased: { increment: units },
      lowBalanceAt: null, // money arrived; the flag clears
    },
  });
  return { envelopeId: envelope.id, balance: envelope.balance, purchasedTotal: envelope.purchased };
}

/**
 * Atomic per-send decrement. Returns false when the balance is exhausted —
 * the caller (dispatcher) then fails the send closed with a clear error
 * instead of sending on our dime.
 */
export async function tryDecrementCredits(
  cp: ControlPlaneClient,
  tenantId: string,
  units = 1,
): Promise<{ ok: boolean; balance: number }> {
  if (!Number.isInteger(units) || units <= 0) {
    return { ok: false, balance: -1 };
  }
  // Conditional updateMany = the atomic compare-and-decrement. A concurrent
  // drainer racing to the last unit loses cleanly here, not below zero.
  const updated = await cp.creditEnvelope.updateMany({
    where: { tenantId, balance: { gte: units } },
    data: { balance: { decrement: units } },
  });
  if (updated.count === 0) {
    const envelope = await cp.creditEnvelope.findUnique({ where: { tenantId } });
    return { ok: false, balance: envelope?.balance ?? 0 };
  }
  const envelope = await cp.creditEnvelope.findUniqueOrThrow({ where: { tenantId } });

  // Low-balance flag: trips once at ≤10% of a 1000-unit reference, cleared
  // by the next top-up. Humans see it in the console; automation never
  // suspends anything over it.
  if (envelope.balance <= Math.max(10, Math.ceil(1000 * LOW_BALANCE_FRACTION)) && !envelope.lowBalanceAt) {
    await cp.creditEnvelope.update({
      where: { tenantId },
      data: { lowBalanceAt: new Date() },
    });
  }
  return { ok: true, balance: envelope.balance };
}

export async function getCreditBalance(cp: ControlPlaneClient, tenantId: string): Promise<{ balance: number; purchased: number; lowBalanceAt: Date | null }> {
  const envelope = await cp.creditEnvelope.upsert({
    where: { tenantId },
    create: { tenantId },
    update: {},
  });
  return { balance: envelope.balance, purchased: envelope.purchased, lowBalanceAt: envelope.lowBalanceAt };
}
