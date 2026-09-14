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

  /**
   * One drain pass over QUEUED rows. Non-urgent rows inside quiet hours are
   * re-queued (deferred), everything else gets a definitive outcome.
   */
  async drain(opts: { urgent?: boolean; limit?: number } = {}): Promise<DrainResult> {
    const now = (this.config.now ?? (() => new Date()))();
    const batchSize = opts.limit ?? this.config.batchSize ?? 50;

    // Claim: flip QUEUED → SENDING. The conditional updateMany is the
    // idempotency boundary — a second drainer cannot claim claimed rows.
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
    await this.prisma.notificationLog.update({
      where: { id: row.id },
      data: { status: 'FAILED', error: lastError },
    });
    return { status: 'FAILED', attemptedChannel: row.channel, error: lastError };
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
