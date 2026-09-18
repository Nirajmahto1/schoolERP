// ──────────────────────────────────────────────
// Peer notification helpers — fire-and-forget enhancements, never correctness
// dependencies (a failed push must never fail the leave decision itself).
//
// Two channels, both identity-safe by construction:
//   • FCM push → communication-service POST /staff-notify (SYSTEM role gate).
//     The log row + FCM delivery is the durable record; works when the app
//     is closed, thanks to the device registry.
//   • WebSocket → notification-engine POST /notifications/send (channel=user).
//     The engine fans out to the teacher's LIVE socket; the tenant boundary is
//     engine-enforced, and the recipient comes from the DB row, never the body
//     of an untrusted request.
//
// Both calls mint their own short-lived, audience-bound assertion. A service
// without INTERNAL_ASSERTION_PRIVATE_KEY (per ADR-3) skips the calls — which
// is why the leave decision must not depend on either succeeding.
// ──────────────────────────────────────────────

import { mintAssertion } from '@school-erp/auth';

export interface NotifyIdentity {
  userId: string;
  email: string;
  tenantId: string;
  branchId: string | null;
}

export interface NotifyOptions {
  internalAssertionPrivateKey?: string;
  communicationBaseUrl?: string;
  notificationEngineUrl?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  logger?: { warn: (msg: string) => void };
}

/** Fire both channels for one recipient. Resolves always; never throws. */
export async function notifyStaffUser(
  identity: NotifyIdentity,
  payload: { targetUserId: string; title: string; body: string; deepLink: string },
  opts: NotifyOptions = {},
): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const log = opts.logger ?? { warn: (m: string) => console.warn(`[staff-notify] ${m}`) };

  // No signing key → peer calls are impossible; skip silently (the decision
  // route already committed — notifications are an enhancement).
  if (!opts.internalAssertionPrivateKey) return;

  const assertionFor = (audience: string) =>
    // mintAssertion is imported lazily-free: it is a pure JWT signer.
    mint(identity, audience, opts.internalAssertionPrivateKey!);

  const jobs: Array<Promise<void>> = [];

  // 1. FCM push (durable — device registry + NotificationLog row).
  if (opts.communicationBaseUrl) {
    jobs.push(
      fetchImpl(`${opts.communicationBaseUrl}/staff-notify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal-assertion': assertionFor('communication-service') },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5_000),
      })
        .then((r) => { if (!r.ok) log.warn(`push peer call ${r.status}`); })
        .catch((err: unknown) => log.warn(`push peer call failed: ${(err as Error).message}`)),
    );
  }

  // 2. Live WebSocket (ephemeral — only reaches a currently-connected app).
  if (opts.notificationEngineUrl) {
    jobs.push(
      fetchImpl(`${opts.notificationEngineUrl}/notifications/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal-assertion': assertionFor('notification-engine') },
        body: JSON.stringify({
          title: payload.title,
          body: payload.body,
          kind: 'LEAVE_DECISION',
          channel: 'user',
          targetUser: payload.targetUserId,
          deepLink: payload.deepLink,
        }),
        signal: AbortSignal.timeout(5_000),
      })
        .then((r) => { if (!r.ok) log.warn(`ws peer call ${r.status}`); })
        .catch((err: unknown) => log.warn(`ws peer call failed: ${(err as Error).message}`)),
    );
  }

  await Promise.allSettled(jobs);
}

function mint(
  identity: NotifyIdentity,
  audience: string,
  privateKey: string,
): string {
  return mintAssertion(
    {
      userId: identity.userId,
      email: identity.email,
      tenantId: identity.tenantId,
      branchId: identity.branchId,
      roles: ['SYSTEM'],
      audience,
    },
    { privateKey, ttlSeconds: 30 },
  );
}
