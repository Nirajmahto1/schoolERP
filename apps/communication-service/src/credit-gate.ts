// ──────────────────────────────────────────────
// Credit gate (BUILD_PLAN 5.7)
//
// The dispatcher calls this once per cost-carrying send. The envelope lives
// in the control plane (one row per tenant — billing data is ours, not the
// tenant's), and the decrement is an atomic conditional update: two
// concurrent drainers racing for the last unit resolve cleanly, never
// below zero.
//
// The math is deliberately inlined rather than imported from
// provisioning-service: billing policy (pricing, invoices) stays there;
// this is only the runtime enforcement edge, 15 lines against the same
// table. A control-plane outage degrades to OPEN — billing visibility may
// lag, but parent communication must not stop; the nightly metering pass
// reconciles usage against invoices after the fact.
// ──────────────────────────────────────────────

import { PrismaClient as ControlPlaneClient } from '@school-erp/control-plane';

let cpSingleton: ControlPlaneClient | null = null;

function controlPlane(): ControlPlaneClient {
  if (!cpSingleton) {
    cpSingleton = new ControlPlaneClient({
      datasourceUrl: process.env.CONTROL_PLANE_DATABASE_URL,
    });
  }
  return cpSingleton;
}

export async function tryDecrementCredits(tenantId: string, units = 1): Promise<{ ok: boolean; balance: number }> {
  if (!Number.isInteger(units) || units <= 0) {
    return { ok: false, balance: -1 };
  }
  try {
    // Atomic compare-and-decrement: `balance >= units` or nothing.
    const updated = await controlPlane().creditEnvelope.updateMany({
      where: { tenantId, balance: { gte: units } },
      data: { balance: { decrement: units } },
    });
    if (updated.count === 0) {
      const envelope = await controlPlane().creditEnvelope.findUnique({ where: { tenantId } });
      return { ok: false, balance: envelope?.balance ?? 0 };
    }
    const envelope = await controlPlane().creditEnvelope.findUniqueOrThrow({ where: { tenantId } });
    // Low-balance flag trips once at ≤100 units; cleared by the next top-up.
    if (envelope.balance <= 100 && !envelope.lowBalanceAt) {
      await controlPlane().creditEnvelope.update({
        where: { tenantId },
        data: { lowBalanceAt: new Date() },
      });
    }
    return { ok: true, balance: envelope.balance };
  } catch (err) {
    // Fail-open: communication outranks billing visibility (see header).
    console.error('[credit-gate] control-plane unreachable, allowing send:', (err as Error).message);
    return { ok: true, balance: -1 };
  }
}
