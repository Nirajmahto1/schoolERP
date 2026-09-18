// ──────────────────────────────────────────────
// @school-erp/notify — one helper, every service.
//
// Any service can now notify a user on BOTH channels with one call:
//   • FCM push → communication-service POST /staff-notify (SYSTEM role gate).
//     Durable: NotificationLog row + device registry — works when the app
//     is closed.
//   • WebSocket → notification-engine POST /notifications/send (channel=user).
//     Ephemeral: only reaches a currently-connected app, tenant boundary
//     enforced engine-side.
//
// Contract (ADR-3 posture): notifications are ENHANCEMENTS, never correctness
// dependencies. A service without INTERNAL_ASSERTION_PRIVATE_KEY skips the
// peer calls; every failure logs and resolves. `Promise.allSettled` means one
// channel's timeout never cancels the other.
// ──────────────────────────────────────────────

import { mintAssertion } from '@school-erp/auth';

export interface NotifyIdentity {
  userId: string;
  email: string;
  tenantId: string;
  branchId: string | null;
}

export interface NotifyPayload {
  targetUserId: string;
  title: string;
  body: string;
  /** e.g. 'erp://leaves' — becomes the push deepLink and the WS frame's link. */
  deepLink?: string;
  /** Engine frame kind, e.g. LEAVE_DECISION | EXAM_RESULT | ANNOUNCEMENT. */
  kind?: string;
}

export interface NotifyOptions {
  internalAssertionPrivateKey?: string;
  communicationBaseUrl?: string;
  notificationEngineUrl?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  logger?: { warn: (msg: string) => void };
}

const defaultLogger = { warn: (m: string) => console.warn(`[notify] ${m}`) };

function mint(identity: NotifyIdentity, audience: string, privateKey: string): string {
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

/**
 * Fire both channels for one recipient. Resolves always; never throws.
 * The peer URLs are optional: an unset URL skips that channel (same posture
 * as a missing signing key — the caller's transaction never depends on us).
 */
export async function notifyStaffUser(
  identity: NotifyIdentity,
  payload: NotifyPayload,
  opts: NotifyOptions = {},
): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const log = opts.logger ?? defaultLogger;

  if (!opts.internalAssertionPrivateKey) return;
  const assertionFor = (audience: string) => mint(identity, audience, opts.internalAssertionPrivateKey!);

  const jobs: Array<Promise<void>> = [];

  // 1. FCM push (durable — device registry + NotificationLog row).
  if (opts.communicationBaseUrl) {
    jobs.push(
      fetchImpl(`${opts.communicationBaseUrl}/staff-notify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal-assertion': assertionFor('communication-service') },
        body: JSON.stringify({
          targetUserId: payload.targetUserId,
          title: payload.title,
          body: payload.body,
          ...(payload.deepLink ? { deepLink: payload.deepLink } : {}),
        }),
        signal: AbortSignal.timeout(5_000),
      })
        .then((r) => { if (!r.ok) log.warn(`push peer call ${r.status}`); })
        .catch((err: unknown) => log.warn(`push peer call failed: ${(err as Error).message}`)),
    );
  }

  // 2. Live WebSocket (ephemeral — only a currently-connected app receives it).
  if (opts.notificationEngineUrl) {
    jobs.push(
      fetchImpl(`${opts.notificationEngineUrl}/notifications/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal-assertion': assertionFor('notification-engine') },
        body: JSON.stringify({
          title: payload.title,
          body: payload.body,
          kind: payload.kind ?? 'NOTICE',
          channel: 'user',
          targetUser: payload.targetUserId,
          ...(payload.deepLink ? { deepLink: payload.deepLink } : {}),
        }),
        signal: AbortSignal.timeout(5_000),
      })
        .then((r) => { if (!r.ok) log.warn(`ws peer call ${r.status}`); })
        .catch((err: unknown) => log.warn(`ws peer call failed: ${(err as Error).message}`)),
    );
  }

  await Promise.allSettled(jobs);
}

/** Fire for MANY recipients — one assertion per call, all in parallel. */
export async function notifyStaffUsers(
  identity: NotifyIdentity,
  payload: Omit<NotifyPayload, 'targetUserId'>,
  targetUserIds: string[],
  opts: NotifyOptions = {},
): Promise<void> {
  const unique = [...new Set(targetUserIds.filter(Boolean))];
  if (unique.length === 0) return;
  await Promise.allSettled(
    unique.map((targetUserId) => notifyStaffUser(identity, { ...payload, targetUserId }, opts)),
  );
}
