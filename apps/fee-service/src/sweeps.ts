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
import { runLateFeeApply } from './late-fees.routes';

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
        // runLateFeeApply records the LateFeeSweepRun audit row (SUCCESS with
        // the per-fine report, or FAILED with the error) — the nightly pass
        // is auditable exactly like a manual console apply.
        const result = await runLateFeeApply(prisma, { id: branch.id, name: branch.name }, 'NIGHTLY', null);
        if (result.applied.length > 0) {
          console.log(
            `[late-fee-sweep] ${branch.name}: applied ${result.applied.length} fine(s), ` +
            `scanned ${result.scanned} overdue invoice(s), skipped ${result.skipped} (run ${result.runId})`,
          );
        }
      } catch (err) {
        // One broken branch must never stop the others' sweep. The FAILED
        // run row is already written by the runner.
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
