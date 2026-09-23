// ──────────────────────────────────────────────
// Guardian notifications for late fees (fee-service peer enhancement)
//
// ADR-3 posture: notifications are ENHANCEMENTS, never correctness
// dependencies. A fine is fully recorded whether or not any push fires; the
// sweep and the manual apply both call this fire-and-forget, and every
// failure logs and resolves.
//
// Recipients: every guardian of a fined student who has portal access and
// receives comms (StudentGuardian.receivesComms/hasPortalAccess) and whose
// Guardian row backs a login (userId non-null). Each guardian gets their own
// FCM push (durable, deep-links to the app's Fees tab) and a live WebSocket
// frame if currently connected.
// ──────────────────────────────────────────────

import type { PrismaClient } from '@school-erp/database';
import { notifyStaffUsers, type NotifyIdentity, type NotifyOptions } from '@school-erp/notify';

export interface AppliedFineForNotify {
  studentId: string;
  invoiceNo: string;
  amount: number;
}

/**
 * Fire-and-forget guardian notifications for applied fines. Resolves always.
 * `identity` is the acting caller (console user) or a synthetic SYSTEM
 * identity for the nightly sweep — the peers only need a valid assertion.
 */
export async function notifyGuardiansOfFines(
  prisma: PrismaClient,
  identity: NotifyIdentity,
  fines: AppliedFineForNotify[],
  opts: NotifyOptions,
): Promise<void> {
  try {
    if (fines.length === 0) return;

    const studentIds = [...new Set(fines.map((f) => f.studentId))];
    const guardians = await prisma.studentGuardian.findMany({
      where: {
        studentId: { in: studentIds },
        receivesComms: true,
        hasPortalAccess: true,
        guardian: { userId: { not: null }, isActive: true, deletedAt: null },
      },
      select: { studentId: true, guardian: { select: { userId: true } } },
    });
    if (guardians.length === 0) return;

    const finesByStudent = new Map<string, AppliedFineForNotify[]>();
    for (const f of fines) {
      const list = finesByStudent.get(f.studentId) ?? [];
      list.push(f);
      finesByStudent.set(f.studentId, list);
    }

    // One notification per (guardian × their child's fines this pass),
    // grouped so a pass that fined 3 invoices sends 1 push, not 3.
    const jobs: Array<Promise<void>> = [];
    for (const link of guardians) {
      const targetUserId = link.guardian.userId;
      const studentFines = finesByStudent.get(link.studentId) ?? [];
      if (!targetUserId || studentFines.length === 0) continue;

      const total = studentFines.reduce((s, f) => s + f.amount, 0);
      const title = studentFines.length === 1 ? 'Late fee added' : `${studentFines.length} late fees added`;
      const body = studentFines.length === 1
        ? `A late fee of ₹${total.toLocaleString('en-IN')} was added for invoice ${studentFines[0].invoiceNo}. Pay from the Fees tab.`
        : `Late fees totalling ₹${total.toLocaleString('en-IN')} were added (${studentFines.map((f) => f.invoiceNo).join(', ')}). Pay from the Fees tab.`;

      jobs.push(
        notifyStaffUsers(
          identity,
          {
            title,
            body: body.slice(0, 500),
            deepLink: 'erp://fees',
            kind: 'FEE_LATE_FINE',
          },
          [targetUserId],
          opts,
        ),
      );
    }
    await Promise.allSettled(jobs);
  } catch (err) {
    // Never let notification failures surface into the apply flow.
    console.error('[late-fee-notify] failed:', (err as Error).message);
  }
}

/** Synthetic SYSTEM identity for the nightly sweep (no human actor). */
export function sweepIdentity(branchId: string): NotifyIdentity {
  return {
    userId: 'system:late-fee-sweep',
    email: 'system@fee-service.internal',
    tenantId: '',
    branchId,
  };
}
