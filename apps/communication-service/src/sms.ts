// ──────────────────────────────────────────────
// SMS provider — DLT-registered gateway (BUILD_PLAN 5.2)
//
// TRAI's DLT regime: a send is only legal with a registered Sender ID
// (header, 6 alphabetic chars) AND a registered content template. Unregistered
// traffic is blocked by the telcos, not by us — so `dltTemplateId` is a
// required parameter, and the adapter refuses sends without one rather than
// letting the aggregator silently drop it.
//
// The REST shape here is the common denominator across Indian aggregators
// (MSG91, Kaleyra, Textlocal, Sinch): POST { sender, route, numbers[],
// template_id, message }. The aggregator-agnostic base URL + key come from
// env; a specific provider that differs more than this adapter tolerates is
// a new subclass — route logic never changes.
// ──────────────────────────────────────────────

export interface SmsConfig {
  /** Aggregator base URL, e.g. https://api.msg91.com/api/v2. */
  apiBase: string;
  /** Aggregator authkey / API key. */
  apiKey: string;
  /** TRAI-registered 6-char sender header, e.g. `DPSNOT`. */
  senderHeader: string;
  /** Route code most aggregators use for transactional DLT traffic. */
  route?: string;
  /** Full-URL override for tests. */
  urlOverride?: string;
}

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface SendSmsResult {
  ok: boolean;
  /** Aggregator's message id — the delivery-receipt join key. */
  providerMessageId?: string;
  /** Per-message cost when the aggregator reports one. */
  cost?: number;
  error?: string;
}

export class SmsClient {
  constructor(
    private readonly config: SmsConfig,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
  ) {}

  async send(to: string, message: string, dltTemplateId: string): Promise<SendSmsResult> {
    if (!dltTemplateId) {
      // Fail closed: without a DLT template id the telcos will eat the
      // message and the school gets a silent no-delivery. Better the error.
      return { ok: false, error: 'DLT template id is required for SMS sends (TRAI registration).' };
    }
    try {
      const url = this.config.urlOverride ?? `${this.config.apiBase}/sms`;
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { authkey: this.config.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sender: this.config.senderHeader,
          route: this.config.route ?? 'dlt',
          numbers: [to],
          dlt_template_id: dltTemplateId,
          message: message,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        type?: string;
        message?: string;
        request_id?: string;
        message_id?: string;
        cost?: number;
      };
      if (!res.ok || json.type === 'error') {
        return { ok: false, error: json.message ?? `SMS gateway ${res.status}` };
      }
      return { ok: true, providerMessageId: json.request_id ?? json.message_id, cost: json.cost };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
}
