// ──────────────────────────────────────────────
// Razorpay REST client (BUILD_PLAN 4.1)
//
// Deliberately no SDK: the surface we need is two endpoints and one HMAC.
// `fetch` is injected so tests can stub the gateway without a network
// namespace, and so a transport change never touches route logic.
//
// Razorpay auth is HTTP Basic with the key id as username and the key secret
// as password. Amounts are in paise (smallest currency unit) everywhere in
// their API; this client converts at the boundary so the rest of the service
// thinks in rupees like the ledger.
// ──────────────────────────────────────────────

import { createHmac, timingSafeEqual } from 'crypto';

export interface RazorpayConfig {
  keyId: string;
  keySecret: string;
  /** Full-URL override for tests; defaults to the real API. */
  apiBase?: string;
}

export interface RazorpayOrder {
  id: string;
  amount: number; // paise
  currency: string;
  status: string;
  receipt?: string;
}

export interface RazorpayPayment {
  id: string;
  order_id: string;
  amount: number; // paise
  status: string;
  method?: string;
}

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export class RazorpayClient {
  constructor(
    private readonly config: RazorpayConfig,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
  ) {}

  private authHeader(): string {
    const token = Buffer.from(`${this.config.keyId}:${this.config.keySecret}`).toString('base64');
    return `Basic ${token}`;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const base = this.config.apiBase ?? 'https://api.razorpay.com/v1';
    const res = await this.fetchImpl(`${base}${path}`, {
      method,
      headers: {
        Authorization: this.authHeader(),
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail =
        typeof payload === 'object' && payload && 'error' in payload
          ? JSON.stringify((payload as { error: unknown }).error)
          : `HTTP ${res.status}`;
      throw new Error(`Razorpay ${method} ${path} failed: ${detail}`);
    }
    return payload as T;
  }

  /** Create an order for a fee intent. `receipt` echoes our payment id. */
  createOrder(input: { amountRupees: number; receipt: string; notes?: Record<string, string> }): Promise<RazorpayOrder> {
    return this.call<RazorpayOrder>('POST', '/orders', {
      amount: Math.round(input.amountRupees * 100),
      currency: 'INR',
      receipt: input.receipt,
      notes: input.notes ?? {},
    });
  }

  /** Fetch a payment — used by the reconciliation job, never the client. */
  fetchPayment(paymentId: string): Promise<RazorpayPayment> {
    return this.call<RazorpayPayment>('GET', `/payments/${paymentId}`);
  }

  /** Fetch a specific payment of an order (verify step). */
  fetchOrderPayments(orderId: string): Promise<{ items: RazorpayPayment[] }> {
    return this.call<{ items: RazorpayPayment[] }>('GET', `/orders/${orderId}/payments`);
  }
}

/**
 * Verify a checkout callback signature: HMAC-SHA256 of
 * `order_id|payment_id` with the key secret, hex — Razorpay's standard
 * `handler` signature. Timing-safe comparison.
 */
export function verifyCheckoutSignature(input: {
  orderId: string;
  paymentId: string;
  signature: string;
  keySecret: string;
}): boolean {
  const expected = createHmac('sha256', input.keySecret)
    .update(`${input.orderId}|${input.paymentId}`)
    .digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(input.signature, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Verify a webhook delivery: Razorpay signs the RAW request body with the
 * webhook secret — HMAC-SHA256, hex, header `x-razorpay-signature`.
 */
export function verifyWebhookSignature(rawBody: Buffer, signature: string, webhookSecret: string): boolean {
  const expected = createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Map Razorpay's payment method strings onto our PaymentMethod enum. */
export function mapMethod(razorpayMethod: string | undefined): 'UPI' | 'CARD' | 'ONLINE' | 'NEFT' | 'OTHER' {
  switch (razorpayMethod) {
    case 'upi': return 'UPI';
    case 'card': return 'CARD';
    case 'netbanking': return 'ONLINE';
    case 'bank_transfer': case 'nach': case 'emandate': return 'NEFT';
    default: return 'OTHER';
  }
}
