// ──────────────────────────────────────────────
// Email provider — AWS SES or Postmark (BUILD_PLAN 5.3)
//
// Exactly one provider is configured at a time (the factory refuses both).
// No SDKs:
//   • Postmark is one POST with a bearer token — `/email` with From/To/
//     Subject/HtmlBody/TextBody, `MessageID` back on success.
//   • SES is the HTTPS JSON 1.0 protocol (`/v2/email/outbound-emails` with
//     X-Amz-Target) signed with SigV4. We implement SigV4's core (creda-
//     ntial scope, canonical request, derived signing key) in ~40 lines —
//     the alternative is dragging aws-sdk-js v3's 40-package dependency
//     tree into a service that sends one email shape.
//
// `fetch` and `now` are injected so tests stub the transport and pin the
// signing clock. `providerMessageId` (Postmark MessageID / SES MessageId)
// becomes the NotificationLog receipt join key; a 4xx from either provider
// (bad address, suppressed recipient) fails the attempt without retrying —
// the dispatcher's fallback chain takes over.
// ──────────────────────────────────────────────

import { createHash, createHmac } from 'crypto';

export type EmailProviderKind = 'ses' | 'postmark';

export interface EmailConfig {
  provider: EmailProviderKind;
  fromAddress: string;
  fromName?: string;
  // SES
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  // Postmark
  serverToken?: string;
  /** Full-URL overrides for tests. */
  sesEndpoint?: string;
  postmarkEndpoint?: string;
}

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface SendEmailResult {
  ok: boolean;
  /** Provider message id — the delivery-receipt join key. */
  providerMessageId?: string;
  error?: string;
}

export class EmailClient {
  constructor(
    private readonly config: EmailConfig,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Refuse misconfiguration loudly: both providers set is ambiguous. */
  static validate(config: Partial<EmailConfig>): void {
    const hasSes = !!(config.region && config.accessKeyId && config.secretAccessKey);
    const hasPostmark = !!config.serverToken;
    if (hasSes && hasPostmark) {
      throw new Error('Both AWS SES and Postmark are configured — set only one email provider.');
    }
  }

  async send(to: string, subject: string, html: string, text?: string): Promise<SendEmailResult> {
    try {
      if (this.config.provider === 'postmark') return await this.sendPostmark(to, subject, html, text);
      return await this.sendSes(to, subject, html, text);
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  // ── Postmark ──

  private async sendPostmark(to: string, subject: string, html: string, text?: string): Promise<SendEmailResult> {
    const from = this.config.fromName ? `${this.config.fromName} <${this.config.fromAddress}>` : this.config.fromAddress;
    const res = await this.fetchImpl(this.config.postmarkEndpoint ?? 'https://api.postmarkapp.com/email', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Postmark-Server-Token': this.config.serverToken ?? '',
      },
      body: JSON.stringify({
        From: from,
        To: to,
        Subject: subject,
        HtmlBody: html,
        TextBody: text ?? html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
        MessageStream: 'outbound',
      }),
    });
    const json = (await res.json().catch(() => ({}))) as { MessageID?: string; Message?: string; ErrorCode?: number };
    if (!res.ok || (json.ErrorCode !== undefined && json.ErrorCode !== 0)) {
      return { ok: false, error: json.Message ?? `Postmark ${res.status}` };
    }
    return { ok: true, providerMessageId: json.MessageID };
  }

  // ── AWS SES (HTTPS JSON 1.0 + SigV4) ──

  private async sendSes(to: string, subject: string, html: string, text?: string): Promise<SendEmailResult> {
    const region = this.config.region ?? 'ap-south-1';
    const body = JSON.stringify({
      FromEmailAddress: this.config.fromName
        ? `${this.config.fromName} <${this.config.fromAddress}>`
        : this.config.fromAddress,
      Destination: { ToAddresses: [to] },
      Content: {
        Simple: {
          Subject: { Data: subject, Charset: 'UTF-8' },
          Body: {
            Html: { Data: html, Charset: 'UTF-8' },
            ...(text ? { Text: { Data: text, Charset: 'UTF-8' } } : {}),
          },
        },
      },
    });

    const host = `email.${region}.amazonaws.com`;
    const endpoint = this.config.sesEndpoint ?? `https://${host}/v2/email/outbound-emails`;
    const target = 'SESv2.SendEmail';
    const amzDate = toAmzDate(this.now());
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = createHash('sha256').update(body).digest('hex');

    // Canonical request per the SigV4 spec (content-type + host + x-amz-*).
    const canonicalHeaders =
      `content-type:application/x-amz-json-1.0\n` +
      `host:${host}\n` +
      `x-amz-date:${amzDate}\n` +
      `x-amz-target:${target}\n`;
    const signedHeaders = 'content-type;host;x-amz-date;x-amz-target';
    const canonicalRequest = `POST\n/v2/email/outbound-emails\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
    const credentialScope = `${dateStamp}/${region}/ses/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      createHash('sha256').update(canonicalRequest).digest('hex'),
    ].join('\n');

    // Derived signing key: kDate → kRegion → kService → kSigning.
    const kDate = createHmac('sha256', `AWS4${this.config.secretAccessKey ?? ''}`).update(dateStamp).digest();
    const kRegion = createHmac('sha256', kDate).update(region).digest();
    const kService = createHmac('sha256', kRegion).update('ses').digest();
    const kSigning = createHmac('sha256', kService).update('aws4_request').digest();
    const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

    const authorization =
      `AWS4-HMAC-SHA256 Credential=${this.config.accessKeyId ?? ''}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const res = await this.fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-amz-json-1.0',
        'X-Amz-Date': amzDate,
        'X-Amz-Target': target,
        Authorization: authorization,
      },
      body,
    });
    const json = (await res.json().catch(() => ({}))) as { MessageId?: string; message?: string; __type?: string };
    if (!res.ok) {
      // SES error shapes: {"__type": "...", "message": "..."}
      return { ok: false, error: json.message ?? json.__type ?? `SES ${res.status}` };
    }
    return { ok: true, providerMessageId: json.MessageId };
  }
}

/** `YYYYMMDD'T'HHMMSS'Z'` in UTC — SigV4's timestamp format. */
function toAmzDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}
