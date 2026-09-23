// ──────────────────────────────────────────────
// Nightly late-fee sweep (fee-service scheduler)
//
// Once a day, per branch, applies the branch's active late-fee slabs to
// overdue invoices. Idempotency lives in the engine (ledger reference
// LATE:<ruleId>:<invoiceId>), so the sweep racing a manual "Apply" from the
// console — or running twice in one day — can never double-fine.
//
// Scheduling follows the communication-service sweep pattern: an hourly tick
// that fires inside the configured window. The window is a CATCH-UP band —
// if the service was down at the exact sweep hour, the first tick inside the
// band still runs the day's sweep instead of skipping it.
// ──────────────────────────────────────────────

import type { PrismaClient } from '@school-erp/database';
import type { ServiceEnv } from '@school-erp/config';
import { applyLateFees } from '@school-erp/domain';

/** Server-local date key — the "already ran today" marker. */
function dayKey(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export function startLateFeeSweeps(prisma: PrismaClient, env: ServiceEnv): void {
  if (!env.LATE_FEE_SWEEP_ENABLED) {
    console.log('[late-fee-sweep] disabled by LATE_FEE_SWEEP_ENABLED — fines are manual only');
    return;
  }

  let lastRunDay = '';
  const HOUR_MS = 60 * 60 * 1000;

  const sweepOnce = async (): Promise<void> => {
    const branches = await prisma.branch.findMany({ select: { id: true, name: true } });
    for (const branch of branches) {
      try {
        const current = await prisma.academicYear.findFirst({
          where: { branchId: branch.id, isCurrent: true },
          select: { id: true },
        });
        if (!current) continue; // branch not set up for fees yet

        const rules = await prisma.lateFeeRule.findMany({
          where: { branchId: branch.id, deletedAt: null, isActive: true },
          orderBy: { minDays: 'asc' },
        });
        if (rules.length === 0) continue; // nothing configured — nothing to do

        const result = await applyLateFees(prisma, {
          branchId: branch.id,
          academicYearId: current.id,
          rules: rules.map((rule) => ({
            id: rule.id, label: rule.label, minDays: rule.minDays, maxDays: rule.maxDays,
            amount: Number(rule.amount), isPercent: rule.isPercent, feeHeadId: rule.feeHeadId, isActive: rule.isActive,
          })),
          createdBy: null, // system sweep — no human actor
        });
        if (result.applied.length > 0) {
          console.log(
            `[late-fee-sweep] ${branch.name}: applied ${result.applied.length} fine(s), ` +
            `scanned ${result.scanned} overdue invoice(s), skipped ${result.skipped}`,
          );
        }
      } catch (err) {
        // One broken branch must never stop the others' sweep.
        console.error(`[late-fee-sweep] branch ${branch.name} failed:`, (err as Error).message);
      }
    }
  };

  const tick = async (): Promise<void> => {
    const now = new Date();
    const hour = now.getHours();
    const day = dayKey(now);
    if (lastRunDay === day) return; // already ran today

    const inWindow =
      hour === env.LATE_FEE_SWEEP_HOUR ||
      (hour > env.LATE_FEE_SWEEP_HOUR && hour <= env.LATE_FEE_SWEEP_HOUR + env.LATE_FEE_SWEEP_WINDOW_HOURS);
    if (!inWindow) return;

    lastRunDay = day;
    try {
      await sweepOnce();
    } catch (err) {
      // Allow a retry on the next tick if the whole pass blew up mid-flight.
      lastRunDay = '';
      console.error('[late-fee-sweep] sweep failed, will retry next tick:', (err as Error).message);
    }
  };

  const timer = setInterval(tick, HOUR_MS);
  timer.unref?.();
  console.log(
    `[late-fee-sweep] armed — daily at hour ${env.LATE_FEE_SWEEP_HOUR} ` +
    `(catch-up window ${env.LATE_FEE_SWEEP_WINDOW_HOURS}h)`,
  );
}
