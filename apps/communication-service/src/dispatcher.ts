// ──────────────────────────────────────────────
// Unified dispatcher (BUILD_PLAN 5.5 / 5.8)
//
// The QUEUED NotificationLog rows are the contract between the API (which
// resolves audiences and renders templates) and delivery (which talks to
// providers). The drainer:
//
//   1. claims a batch of QUEUED rows (status flip QUEUED → SENDING, so two
//      concurrent drainers can never double-send)
//   2. enforces quiet hours (§5.8): inside the window, non-urgent rows go
//      back to QUEUED (retried after the window); urgent rows send
//   3. attempts the row's channel with a fallback chain on failure:
//      WHATSAPP → SMS → EMAIL (and permutations)
//   4. stamps provider, provider message id, status, cost, error
//
// Every outcome — including every failure — is a NotificationLog update:
// the delivery-dispute trail (§5.5) requires that the row the school sees
// is the row the provider answered.
// ──────────────────────────────────────────────

import type { PrismaClient, NotificationLog } from '@school-erp/database';
import { WhatsAppClient } from './whatsapp';
import { SmsClient } from './sms';
import { FcmClient, type PushPayload } from './fcm';
import { EmailClient } from './email';

export interface DispatcherConfig {
  whatsapp: WhatsAppClient | null; // null = not configured → channel unavailable
  sms: SmsClient | null;
  fcm: FcmClient | null; // null = push unconfigured
  email: EmailClient | null; // null = email unconfigured
  /**
   * Credit gate (§5.7): called once per cost-carrying send. `false` = the
   * tenant's envelope is exhausted — the row fails closed with a clear
   * error instead of sending on the platform's dime. Optional: deployments
   * that don't bill per-message omit it and every send passes.
   */
  creditGate?: (units: number) => Promise<{ ok: boolean; balance: number }>;
  /**
   * §5.8 unsubscribe: returns false when the recipient opted out of
   * NON-TRANSACTIONAL messaging on this channel (absence alerts, fee
   * dues and emergency broadcasts are transactional and always deliver).
   * Optional: absent = everything delivers.
   */
  isRecipientOptedIn?: (recipientId: string, channel: string, transactional: boolean) => Promise<boolean>;
  /**
   * §5.8 throttling: max sends per branch per minute. The drainer defers
   * rows beyond the rate (back to QUEUED) so BSP limits and telco pipe
   * limits are respected. 0/undefined = unthrottled.
   */
  perBranchPerMinute?: number;
  /** Quiet hours in server-local hours; non-urgent sends wait them out. */
  quietHours: { start: number; end: number };
  /** Rows per drain pass. */
  batchSize?: number;
  now?: () => Date;
}

/** Channel fallback order on transport-level failure. */
const FALLBACK: Record<string, string[]> = {
  WHATSAPP: ['SMS', 'EMAIL'],
  SMS: ['WHATSAPP', 'EMAIL'],
  // Email is the last resort everywhere: it is the cheapest to hold and the
  // weakest for parent reach in India (§5.3) — but never a silent drop.
  EMAIL: [],
  // Push without a device goes to SMS — a parent without the app installed
  // still hears about the absence alert.
  PUSH: ['WHATSAPP', 'SMS', 'EMAIL'],
};

/**
 * Transactional messages (§5.8) are ones the parent NEEDS: absence alerts,
 * fee dues, emergency broadcasts. Everything else (newsletters, event
 * promos, holiday notices that aren't schedule changes) honours opt-out.
 * The template tag declares it: `txn:` prefix or known trigger templates
 * are transactional; all else is not.
 */
const ALWAYS_TRANSACTIONAL = ['absence_alert', 'emergency_broadcast'];

function isTransactional(row: NotificationLog): boolean {
  const t = row.template ?? '';
  if (t.startsWith('txn:')) return true;
  if (t.startsWith('fee_reminder:')) return true; // money owed = transactional
  return ALWAYS_TRANSACTIONAL.includes(t);
}

// ── Retry / dead-letter policy (§5.5) ──
// A failure whose error carries the transient marker is retried with a
// flat 10-minute backoff, up to MAX_ATTEMPTS total; then DEAD_LETTERED.
// Permanent failures (unsubscribed, credits exhausted, UNREGISTERED
// devices, provider 4xx policy rejections) never carry the marker.
export const TRANSIENT_MARKER = 'transient:';
export const MAX_ATTEMPTS = 3;
export const RETRY_BACKOFF_MS = 10 * 60 * 1000;

/** A provider attempt's outcome — transport level, pre-DB-stamp. */
interface Attempt {
  ok: boolean;
  providerMessageId?: string;
  cost?: number;
  error?: string;
}

export interface DrainResult {
  claimed: number;
  sent: number;
  failed: number;
  deferredQuietHours: number;
  fallbacks: number;
  results: Array<{
    logId: string;
    channel: string;
    status: string;
    providerMessageId?: string;
    error?: string;
    fellBackTo?: string;
  }>;
}

export class Dispatcher {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly config: DispatcherConfig,
  ) {}

  private inQuietHours(now: Date): boolean {
    const { start, end } = this.config.quietHours;
    const h = now.getHours();
    if (start === end) return false; // degenerate window = no quiet hours
    if (start < end) return h >= start && h < end;
    return h >= start || h < end; // wraps midnight (e.g. 21 → 8)
  }

  /** §5.8 per-branch sliding window: sends in the trailing minute. */
  private branchWindows = new Map<string, number[]>();

  private perBranchCount(branchId: string): number {
    const windowStart = Date.now() - 60_000;
    const arr = (this.branchWindows.get(branchId) ?? []).filter((t) => t > windowStart);
    this.branchWindows.set(branchId, arr);
    return arr.length;
  }

  private recordBranchSend(branchId: string): void {
    const arr = this.branchWindows.get(branchId) ?? [];
    arr.push(Date.now());
    this.branchWindows.set(branchId, arr);
  }

  /**
   * One drain pass over QUEUED rows. Non-urgent rows inside quiet hours are
   * re-queued (deferred), everything else gets a definitive outcome.
   */
  async drain(opts: { urgent?: boolean; limit?: number } = {}): Promise<DrainResult> {
    const now = (this.config.now ?? (() => new Date()))();
    const batchSize = opts.limit ?? this.config.batchSize ?? 50;

    // Claim: flip QUEUED → SENDING. The conditional updateMany is the
    // idempotency boundary — a second drainer cannot claim claimed rows.
    // Retry-with-backoff (§5.5): a FAILED row whose error was transient
    // (network/5xx, not unsubscribe/exhaustion) re-enters QUEUED after its
    // backoff delay, up to MAX_ATTEMPTS; past that it is dead-lettered
    // (DEAD_LETTERED) for a human — never silently deleted.
    const retryables = await this.prisma.notificationLog.findMany({
      where: {
        status: 'FAILED',
        attempts: { lt: MAX_ATTEMPTS },
        error: { contains: TRANSIENT_MARKER },
        lastAttemptAt: { lte: new Date(Date.now() - RETRY_BACKOFF_MS) },
      },
      select: { id: true },
      take: batchSize,
    });
    if (retryables.length > 0) {
      await this.prisma.notificationLog.updateMany({
        where: { id: { in: retryables.map((r) => r.id) } },
        data: { status: 'QUEUED' },
      });
    }

    const claimable = await this.prisma.notificationLog.findMany({
      where: { status: 'QUEUED', channel: { notIn: ['IN_APP'] } },
      take: batchSize,
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    if (claimable.length === 0) {
      return { claimed: 0, sent: 0, failed: 0, deferredQuietHours: 0, fallbacks: 0, results: [] };
    }
    const claim = await this.prisma.notificationLog.updateMany({
      where: { id: { in: claimable.map((r) => r.id) }, status: 'QUEUED' },
      data: { status: 'SENDING' },
    });

    const rows = await this.prisma.notificationLog.findMany({
      where: { id: { in: claimable.map((r) => r.id) }, status: 'SENDING' },
      orderBy: { createdAt: 'asc' },
    });

    const result: DrainResult = {
      claimed: rows.length,
      sent: 0,
      failed: 0,
      deferredQuietHours: claim.count - rows.length,
      fallbacks: 0,
      results: [],
    };

    for (const row of rows) {
      // Quiet hours: put non-urgent rows back for the next pass.
      if (!opts.urgent && this.inQuietHours(now)) {
        await this.prisma.notificationLog.update({
          where: { id: row.id },
          data: { status: 'QUEUED', error: 'deferred: quiet hours' },
        });
        result.deferredQuietHours++;
        continue;
      }

      // §5.8 unsubscribe: non-transactional rows to opted-out recipients
      // are closed as UNSUBSCRIBED (not retried, not failed-with-retry) —
      // the parent said no, and the log must show we honoured it.
      if (this.config.isRecipientOptedIn && !isTransactional(row)) {
        const optedIn = await this.config.isRecipientOptedIn(row.recipientId, row.channel, false);
        if (!optedIn) {
          await this.prisma.notificationLog.update({
            where: { id: row.id },
            data: { status: 'FAILED', error: 'recipient unsubscribed from non-transactional messages (§5.8)' },
          });
          result.failed++;
          result.results.push({ logId: row.id, channel: row.channel, status: 'FAILED', error: 'unsubscribed' });
          continue;
        }
      }

      // §5.8 throttling: defer rows beyond the per-branch rate. They come
      // back on the next pass — throttle is pacing, not refusal.
      if (this.config.perBranchPerMinute && this.perBranchCount(row.branchId) >= this.config.perBranchPerMinute) {
        await this.prisma.notificationLog.update({
          where: { id: row.id },
          data: { status: 'QUEUED', error: 'deferred: rate limit' },
        });
        result.deferredQuietHours++;
        continue;
      }
      this.recordBranchSend(row.branchId);

      // Credit gate (§5.7): cost-carrying channels decrement the tenant's
      // envelope BEFORE the wire call. Exhausted = fail closed, row keeps
      // its place in the dispute trail. IN_APP is free and never gated.
      if (this.config.creditGate && row.channel !== 'IN_APP') {
        const gate = await this.config.creditGate(1);
        if (!gate.ok) {
          await this.prisma.notificationLog.update({
            where: { id: row.id },
            data: { status: 'FAILED', error: `messaging credits exhausted (balance ${gate.balance}) — top up in billing` },
          });
          result.failed++;
          result.results.push({ logId: row.id, channel: row.channel, status: 'FAILED', error: 'credits exhausted' });
          continue;
        }
      }

      const outcome = await this.deliver(row);
      if (outcome.fellBackTo) result.fallbacks++;
      if (outcome.status === 'SENT') result.sent++;
      else result.failed++;
      result.results.push({
        logId: row.id,
        channel: outcome.attemptedChannel,
        status: outcome.status,
        providerMessageId: outcome.providerMessageId,
        error: outcome.error,
        fellBackTo: outcome.fellBackTo,
      });
    }

    return result;
  }

  /** Attempt delivery on the row's channel, walking the fallback chain. */
  private async deliver(row: NotificationLog): Promise<{
    status: 'SENT' | 'FAILED';
    attemptedChannel: string;
    providerMessageId?: string;
    cost?: number;
    error?: string;
    fellBackTo?: string;
  }> {
    const chain = [row.channel, ...(FALLBACK[row.channel] ?? [])];
    // Every attempt's reason lands in the row's error — the delivery-dispute
    // trail (§5.5) needs the full chain, not just the last channel's excuse.
    const errors: string[] = [];
    let fellBackTo: string | undefined;

    for (let i = 0; i < chain.length; i++) {
      const channel = chain[i];
      const attempt = await this.sendOn(channel, row);
      if (attempt === null) {
        errors.push(`${channel.toLowerCase()}: not configured`);
        continue;
      }
      if (attempt.ok) {
        await this.prisma.notificationLog.update({
          where: { id: row.id },
          data: {
            status: 'SENT',
            provider: channel,
            providerMessageId: attempt.providerMessageId ?? null,
            ...(attempt.cost !== undefined ? { cost: attempt.cost } : {}),
            error: null,
            sentAt: new Date(),
          },
        });
        return {
          status: 'SENT',
          attemptedChannel: row.channel,
          providerMessageId: attempt.providerMessageId,
          cost: attempt.cost,
          fellBackTo: i > 0 ? channel : undefined,
        };
      }
      errors.push(`${channel.toLowerCase()}: ${attempt.error ?? 'send failed'}`);
    }

    const lastError = errors.join('; ') || 'no provider configured';
    const attempts = row.attempts + 1;
    // Everything that reaches the end of the chain is retriable (provider
    // outages, not-yet-configured channels, network) — permanent refusals
    // (unsubscribed, credits exhausted) are closed BEFORE deliver. So:
    // transient until MAX_ATTEMPTS, then DEAD_LETTERED for a human.
    const transient = attempts < MAX_ATTEMPTS;
    const failureText = transient ? `${TRANSIENT_MARKER}attempt ${attempts}/${MAX_ATTEMPTS}: ${lastError}` : `${lastError} (dead-lettered after ${attempts} attempts)`;
    await this.prisma.notificationLog.update({
      where: { id: row.id },
      data: {
        status: transient ? 'FAILED' : 'DEAD_LETTERED',
        attempts,
        lastAttemptAt: new Date(),
        error: failureText,
      },
    });
    return { status: 'FAILED', attemptedChannel: row.channel, error: failureText };
  }

  /** Build a sender for one channel, or null when unavailable. */
  private async sendOn(channel: string, row: NotificationLog): Promise<Attempt | null> {
    // Address-based channels need an address on the row. PUSH does not — its
    // recipients resolve through the device registry (§5.4), keyed by userId.
    if (channel !== 'PUSH' && !row.recipient) return null;
    // The guard above guarantees an address for every non-PUSH channel; PUSH
    // never reads this local (it fans out through the registry instead).
    const address = row.recipient as string;

    if (channel === 'EMAIL') {
      const email = this.config.email;
      if (!email) return null;
      // Plain-text bodies render acceptably in every client; subject comes
      // from the row when the trigger set one.
      return email.send(address, row.subject ?? 'School update', `<p>${(row.body ?? '').replace(/\n/g, '<br>')}</p>`, row.body ?? '');
    }

    if (channel === 'WHATSAPP') {
      const wa = this.config.whatsapp;
      if (!wa) return null;
      // Freeform text: the API side only queues template content, and Meta
      // rejects business-initiated freeform outside the 24h window — that
      // shows up as a failed attempt with Meta's reason.
      return wa.sendText(address, row.body ?? '');
    }

    if (channel === 'SMS') {
      const sms = this.config.sms;
      if (!sms) return null;
      // DLT template id rides the row's template reference when present;
      // without one the client fails closed (telcos would eat the message).
      const dltId = (row.template ?? '').replace(/^dlt:/, '') || '';
      return sms.send(address, row.body ?? '', dltId);
    }

    if (channel === 'PUSH') {
      const fcm = this.config.fcm;
      if (!fcm) return null;
      // The recipientId of a PUSH row is a userId (§5.4): resolve it to the
      // user's registered devices. No devices = nothing to send to.
      const devices = await this.prisma.deviceToken.findMany({
        where: { userId: row.recipientId, isActive: true },
        select: { id: true, token: true },
      });
      if (devices.length === 0) {
        return { ok: false, error: 'push: no registered devices for user' };
      }
      const payload: PushPayload = {
        title: row.subject ?? 'School update',
        body: row.body ?? '',
        ...(row.template?.startsWith('link:') ? { deepLink: row.template.slice(5) } : {}),
      };
      let delivered = 0;
      let lastError = '';
      const staleDeviceIds: string[] = [];
      for (const d of devices) {
        const attempt = await fcm.send(d.token, payload);
        if (attempt.ok) {
          delivered++;
        } else {
          lastError = attempt.error ?? 'send failed';
          if (attempt.tokenInvalid) staleDeviceIds.push(d.id); // FCM says: gone forever
        }
      }
      // One dead token shouldn't fail the user's row — fan-out succeeded if
      // any device accepted. Dead tokens are deleted on sight so the next
      // dispatch doesn't retry them.
      if (staleDeviceIds.length) {
        await this.prisma.deviceToken.deleteMany({ where: { id: { in: staleDeviceIds } } });
      }
      if (delivered > 0) {
        return { ok: true };
      }
      return { ok: false, error: `push: ${lastError || 'all devices rejected'}` };
    }

    // §5.3 email (SES/Postmark) lands later in the phase; until wired, that
    // channel fails closed with a clear error.
    return null;
  }
}
