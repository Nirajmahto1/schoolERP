// ──────────────────────────────────────────────
// Push provider — Firebase Cloud Messaging, HTTP v1 API (BUILD_PLAN 5.4)
//
// Deliberately no firebase-admin SDK: it drags the entire Google API surface
// into the service for what is one endpoint and one OAuth flow. The HTTP v1
// API is exactly that:
//
//   1. POST https://oauth2.googleapis.com/token  — service-account JWT
//      assertion → access token, valid 1h (cached here until 5min before
//      expiry, refreshed on demand, never persisted).
//   2. POST https://fcm.googleapis.com/v1/{project}/messages — the send.
//
// `fetch` and `signJwt` are injected so tests stub both without a network or
// a real key — same shape as the WhatsApp/SMS adapters. Unregistered or
// invalid tokens are reported back so the dispatcher can DELETE them: stale
// tokens are the #1 reason push "silently stops working" for a user.
// ──────────────────────────────────────────────

import jwt, { SignOptions } from 'jsonwebtoken';

/** Google's OAuth scope for FCM HTTP v1 sends. */
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

export interface FcmConfig {
  projectId: string;
  clientEmail: string;
  /** PEM private key with real newlines (config normalizes `\\n`). */
  privateKey: string;
  /** Full-URL overrides for tests. */
  oauthUrl?: string;
  sendUrl?: string;
}

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** Minimal signing surface — jsonwebtoken in prod, test double in tests. */
export type JwtSigner = (payload: object, secretOrPrivateKey: string, options: SignOptions) => string;

export interface SendPushResult {
  ok: boolean;
  /** FCM's message name (`projects/{p}/messages/{id}`) — the receipt join key. */
  providerMessageId?: string;
  error?: string;
  /** True when FCM says the token is unregistered/invalid — delete it. */
  tokenInvalid?: boolean;
}

/** Android note: FCM collapses notifications while the app is backgrounded. */
export interface PushPayload {
  title: string;
  body: string;
  /** Deep-link route for the app, e.g. `app://fees/invoice/123`. */
  deepLink?: string;
  /** `high` wakes the device (absence alerts, emergencies); default `normal`. */
  priority?: 'normal' | 'high';
}

export class FcmClient {
  private cachedToken?: { value: string; expiresAtMs: number };

  constructor(
    private readonly config: FcmConfig,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
    private readonly signJwt: JwtSigner = defaultSigner,
  ) {}

  /**
   * Service-account flow: mint a JWT (RS256, 1h) asserting the FCM scope,
   * exchange it at Google's OAuth endpoint. Cached until 5 minutes before
   * expiry so a drain pass of 500 rows makes one token call.
   */
  private async accessToken(): Promise<string> {
    const nowMs = Date.now();
    if (this.cachedToken && this.cachedToken.expiresAtMs - 5 * 60_000 > nowMs) {
      return this.cachedToken.value;
    }

    const iat = Math.floor(nowMs / 1000);
    const assertion = this.signJwt(
      { iss: this.config.clientEmail, scope: FCM_SCOPE, aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600 },
      this.config.privateKey,
      { algorithm: 'RS256' },
    );

    const oauthUrl = this.config.oauthUrl ?? 'https://oauth2.googleapis.com/token';
    const res = await this.fetchImpl(oauthUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
    });
    const json = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string; error_description?: string };
    if (!res.ok || !json.access_token) {
      throw new Error(json.error_description ?? json.error ?? `Google OAuth ${res.status}`);
    }
    this.cachedToken = { value: json.access_token, expiresAtMs: nowMs + ((json as { expires_in?: number }).expires_in ?? 3600) * 1000 };
    return this.cachedToken.value;
  }

  /** Send one message. Never throws — every outcome is a typed result. */
  async send(token: string, payload: PushPayload): Promise<SendPushResult> {
    try {
      const access = await this.accessToken();
      const sendUrl =
        this.config.sendUrl ?? `https://fcm.googleapis.com/v1/projects/${this.config.projectId}/messages:send`;

      const res = await this.fetchImpl(sendUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: {
            token,
            notification: { title: payload.title, body: payload.body },
            data: payload.deepLink ? { deepLink: payload.deepLink } : undefined,
            android: { priority: payload.priority ?? 'normal' },
            apns: {
              // APNs needs an explicit urgency map; `high` → alert + sound.
              headers: { 'apns-priority': payload.priority === 'high' ? '10' : '5' },
              payload: { aps: { sound: 'default' } },
            },
          },
        }),
      });

      const json = (await res.json().catch(() => ({}))) as {
        name?: string;
        error?: { message?: string; details?: Array<{ errorCode?: string }> };
      };
      if (!res.ok) {
        const msg = json.error?.message ?? `FCM ${res.status}`;
        const code = json.error?.details?.[0]?.errorCode ?? '';
        const invalid = res.status === 404 || res.status === 410 || code === 'UNREGISTERED' || code === 'INVALID_ARGUMENT';
        return { ok: false, error: msg, tokenInvalid: invalid };
      }
      return { ok: true, providerMessageId: json.name };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
}

function defaultSigner(payload: object, privateKey: string, options: SignOptions): string {
  return jwt.sign(payload, privateKey, options);
}
