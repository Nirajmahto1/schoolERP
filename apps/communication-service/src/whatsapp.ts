// ──────────────────────────────────────────────
// WhatsApp provider — Meta Cloud API direct (BUILD_PLAN 5.1)
//
// Deliberately no SDK and no BSP middleman to start: the Cloud API is two
// endpoints and one HMAC, exactly like Razorpay. `fetch` is injected so
// tests stub the transport and a BSP swap later (Gupshup/Interakt/AiSensy)
// only touches this file.
//
// India-specifics honored here:
//   • Only PRE-APPROVED templates may be sent to a parent who hasn't written
//     to us in the 24h customer-service window — business-initiated freeform
//     text is rejected by Meta. So the dispatcher's template sends go
//     through `sendTemplate`, freeform replies through `sendText`.
//   • Opt-in: parents are messaged only when they (or the school) recorded
//     a WhatsApp-consent flag; enforcement lives in the dispatcher.
//   • Every send returns a provider wamid — stamped onto NotificationLog for
//     the delivery-dispute trail, with per-message cost where the provider
//     reports it.
// ──────────────────────────────────────────────

import { createHmac, timingSafeEqual } from 'crypto';

export interface WhatsAppConfig {
  /** System-user access token with whatsapp_business_messaging. */
  token: string;
  /** The business phone number id sends are attributed to. */
  phoneNumberId: string;
  /** Shared secret Meta uses to sign webhook payloads (X-Hub-Signature-256). */
  webhookSecret?: string;
  /** Full-URL override for tests. */
  apiBase?: string;
  graphVersion?: string;
}

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface SendTemplateResult {
  ok: boolean;
  /** Meta's WhatsApp message id (wamid…) — the delivery-receipt join key. */
  providerMessageId?: string;
  /** Provider-reported conversation cost, when present in the response. */
  cost?: number;
  error?: string;
}

export class WhatsAppClient {
  constructor(
    private readonly config: WhatsAppConfig,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
  ) {}

  /** Meta signs webhooks as HMAC-SHA256 over the raw body, prefixed `sha256=`. */
  static verifySignature(rawBody: Buffer, signatureHeader: string | undefined, secret: string): boolean {
    if (!signatureHeader?.startsWith('sha256=')) return false;
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    const given = signatureHeader.slice('sha256='.length);
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(given, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private async call<T>(path: string, body: unknown): Promise<T> {
    const base = this.config.apiBase ?? 'https://graph.facebook.com';
    const version = this.config.graphVersion ?? 'v21.0';
    const res = await this.fetchImpl(`${base}/${version}/${this.config.phoneNumberId}/${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const err = json['error'] as { message?: string } | undefined;
      throw new Error(err?.message ?? `WhatsApp API ${res.status}`);
    }
    return json as T;
  }

  /**
   * Send an approved template. `params` fills the {{1}}-style positional
   * placeholders in declaration order.
   */
  async sendTemplate(to: string, templateName: string, lang = 'en', params: string[] = []): Promise<SendTemplateResult> {
    try {
      const json = await this.call<{ messages?: Array<{ id?: string; message_status?: string }> }>('messages', {
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: {
          name: templateName,
          language: { code: lang },
          ...(params.length ? { components: [{ type: 'body', parameters: params.map((p) => ({ type: 'text', text: p })) }] } : {}),
        },
      });
      return { ok: true, providerMessageId: json.messages?.[0]?.id };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /** Freeform text — only within the 24h customer-service window. */
  async sendText(to: string, text: string): Promise<SendTemplateResult> {
    try {
      const json = await this.call<{ messages?: Array<{ id?: string }> }>('messages', {
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text },
      });
      return { ok: true, providerMessageId: json.messages?.[0]?.id };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
}



// ── Webhook payload parsing (delivery statuses) ──

export interface DeliveryStatusUpdate {
  /** Meta's wamid for the message whose status changed. */
  providerMessageId: string;
  status: 'QUEUED' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';
  /** Human-readable failure reason when status === FAILED. */
  error?: string;
  /** Meta-reported cost for the message's conversation, when present. */
  cost?: number;
  timestamp?: Date;
}

interface MetaWebhookBody {
  entry?: Array<{
    changes?: Array<{
      value?: {
        statuses?: Array<{
          id: string;
          status: string;
          timestamp?: string;
          errors?: Array<{ title?: string; message?: string }>;
          pricing?: { pricing_category?: string };
        }>;
      };
    }>;
  }>;
}

/** Map Meta's webhook statuses onto NotificationLog statuses. */
export function parseDeliveryStatuses(body: unknown): DeliveryStatusUpdate[] {
  const b = body as MetaWebhookBody;
  const out: DeliveryStatusUpdate[] = [];
  for (const entry of b?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const s of change.value?.statuses ?? []) {
        const statusMap: Record<string, DeliveryStatusUpdate['status']> = {
          deleted: 'FAILED',
          failed: 'FAILED',
          queued: 'QUEUED',
          sent: 'SENT',
          delivered: 'DELIVERED',
          read: 'READ',
        };
        out.push({
          providerMessageId: s.id,
          status: statusMap[s.status] ?? 'FAILED',
          error: s.status === 'failed' ? (s.errors?.[0]?.title ?? s.errors?.[0]?.message ?? 'delivery failed') : undefined,
          timestamp: s.timestamp ? new Date(Number(s.timestamp) * 1000) : undefined,
        });
      }
    }
  }
  return out;
}
