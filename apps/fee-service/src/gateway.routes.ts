// ──────────────────────────────────────────────
// Gateway collection routes (BUILD_PLAN 4.1)
//
// The DB row is the source of truth — never the webhook payload:
//   1. POST /checkout/orders     → Razorpay order + INITIATED Payment row
//   2. POST /checkout/verify     → checkout callback HMAC + capture
//   3. POST /webhooks/razorpay   → server-to-server webhook (public; HMAC)
//   4. POST /reconcile/run       → polls the gateway; recovers dropped
//                                  webhooks (GATE 4), flags mismatches
//   5. GET  /settlements         → accountant report
//
// Every capture path funnels into `captureGatewayPayment`, which is
// race-safe (conditional claim) and idempotent (domain replay guard), so
// webhook + verify + reconcile racing on the same intent credits the ledger
// exactly once.
// ──────────────────────────────────────────────

import { Router } from 'express';
import type { PrismaClient } from '@school-erp/database';
import { captureGatewayPayment, failGatewayPayment, refundGatewayPayment } from '@school-erp/domain';
import { ctx } from '@school-erp/auth';
import type { RawBodyRequest } from '@school-erp/auth';
import {
  RazorpayClient,
  verifyCheckoutSignature,
  verifyWebhookSignature,
  mapMethod,
} from './razorpay';

export interface GatewayRoutesOptions {
  prisma: PrismaClient;
  /** Present when the deployment has Razorpay keys; checkout answers 503 without. */
  razorpay?: RazorpayClient;
  /** Public key id, echoed to the browser for checkout.js. */
  keyId?: string;
  keySecret?: string;
  webhookSecret?: string;
}

/**
 * GATE 4: every capture surface funnels through one claim-safe function.
 * Returns the CaptureResult either way — AMOUNT_MISMATCH included — so each
 * surface can decide its own response shape (verify 409s, webhook acks so
 * Razorpay does not retry a permanent condition, reconcile flags it).
 */
function handleCapture(prisma: PrismaClient) {
  return async (paymentId: string, gatewayPaymentId: string, amount: number, method: string | undefined, rawEvent: unknown) => {
    return captureGatewayPayment(prisma, {
      paymentId,
      gatewayPaymentId,
      amount,
      method: mapMethod(method),
      rawEvent,
    });
  };
}

export function createGatewayRoutes(options: GatewayRoutesOptions): Router {
  const { prisma } = options;
  const r = Router();
  const capture = handleCapture(prisma);

  // ── 1. Create a checkout order ──
  // Parent/admin picks invoices (or leaves them empty for oldest-due-first);
  // we compute the payable amount from OUR open invoices, not from the client.
  r.post('/orders', async (req, res) => {
    try {
      if (!options.razorpay) {
        res.status(503).json({ type: 'unavailable', title: 'Not Configured', status: 503, detail: 'Razorpay is not configured on this deployment.' });
        return;
      }
      const { branchId } = ctx(req);
      if (!branchId) { res.status(403).json({ detail: 'Account has no branch.' }); return; }
      const { studentId, academicYearId, invoiceIds } = req.body ?? {};
      if (!studentId || !academicYearId) {
        res.status(400).json({ type: 'validation-error', title: 'Invalid Input', status: 400, detail: 'studentId and academicYearId are required.' });
        return;
      }

      // Amount comes from the DB: sum of the chosen invoices' outstanding, or
      // all open dues. The client never states an amount.
      const invoices = await prisma.invoice.findMany({
        where: {
          branchId,
          studentId,
          academicYearId,
          status: { in: ['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'] },
          deletedAt: null,
          ...(invoiceIds?.length ? { id: { in: invoiceIds } } : {}),
        },
        orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }],
      });
      const outstanding = invoices.reduce((sum, inv) => sum + Math.max(0, Number(inv.totalAmount) - Number(inv.paidAmount)), 0);
      if (outstanding <= 0) {
        res.status(409).json({ type: 'conflict', title: 'Nothing To Pay', status: 409, detail: 'The selected student has no outstanding dues.' });
        return;
      }

      const intent = await prisma.payment.create({
        data: {
          branchId,
          studentId,
          academicYearId,
          invoiceId: invoiceIds?.length === 1 ? invoiceIds[0] : null,
          amount: outstanding,
          method: 'ONLINE',
          status: 'INITIATED',
          // Idempotency for the capture: unique per gateway payment later,
          // but the intent needs a placeholder the capture path can reuse.
          idempotencyKey: `intent:${crypto.randomUUID()}`,
          gatewayProvider: 'RAZORPAY',
        },
      });
      const order = await options.razorpay.createOrder({
        amountRupees: outstanding,
        receipt: intent.id,
        notes: { paymentId: intent.id, branchId },
      });
      await prisma.payment.update({
        where: { id: intent.id },
        data: { gatewayOrderId: order.id },
      });
      res.status(201).json({
        paymentId: intent.id,
        orderId: order.id,
        amount: outstanding,
        currency: 'INR',
        keyId: options.keyId ?? null, // public key for checkout.js on the client
        invoices: invoices.map((i) => ({ id: i.id, invoiceNo: i.invoiceNo, dueDate: i.dueDate, outstanding: Number(i.totalAmount) - Number(i.paidAmount) })),
      });
    } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
  });

  // ── 2. Verify the checkout callback (browser hands back the signature) ──
  r.post('/verify', async (req, res) => {
    try {
      if (!options.keySecret) {
        res.status(503).json({ type: 'unavailable', title: 'Not Configured', status: 503, detail: 'Razorpay is not configured on this deployment.' });
        return;
      }
      const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body ?? {};
      if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
        res.status(400).json({ type: 'validation-error', title: 'Invalid Input', status: 400, detail: 'razorpay_order_id, razorpay_payment_id and razorpay_signature are required.' });
        return;
      }
      const valid = verifyCheckoutSignature({
        orderId: razorpay_order_id,
        paymentId: razorpay_payment_id,
        signature: razorpay_signature,
        keySecret: options.keySecret,
      });
      if (!valid) {
        res.status(400).json({ type: 'validation-error', title: 'Bad Signature', status: 400, detail: 'Checkout signature verification failed.' });
        return;
      }
      const intent = await prisma.payment.findFirst({ where: { gatewayOrderId: razorpay_order_id, status: 'INITIATED' } });
      if (!intent) {
        // Unknown or already-captured order: not an error for an idempotent retry.
        res.json({ captured: false, reason: 'ALREADY_CAPTURED' });
        return;
      }
      // Amount authority = the gateway itself (fetch the payment), never the
      // browser's claim.
      const gw = options.razorpay
        ? await options.razorpay.fetchPayment(razorpay_payment_id)
        : { amount: Math.round(Number(intent.amount) * 100) }; // test mode w/o keys: trust the row
      const result = await capture(intent.id, razorpay_payment_id, gw.amount / 100, 'checkout', { razorpay_order_id, razorpay_payment_id, razorpay_signature });
      if (!result.captured && result.reason !== 'ALREADY_CAPTURED') {
        // Amount mismatch / non-capturable intent on a verified callback is a
        // hard 409 — the browser must show failure, ops must look.
        res.status(409).json({ type: 'conflict', title: 'Capture Refused', status: 409, detail: `Capture refused: ${result.reason}.` });
        return;
      }
      res.json(result);
    } catch (e) {
      const status = (e as Error & { status?: number }).status ?? 500;
      res.status(status).json({ detail: (e as Error).message });
    }
  });

  // ── 3. Razorpay webhook (public; signed with the webhook secret) ──
  // NOTE: mounted by the app factory via `mountPublicWebhook`, NOT here —
  // the gated mount below requires an assertion on everything.
  return r;
}

/**
 * Public webhook router — mounted at /webhooks BEFORE the gated routes.
 * Authenticity comes from the HMAC over the raw body, verified here.
 */
export function createWebhookRoute(options: GatewayRoutesOptions): Router {
  const { prisma } = options;
  const r = Router();
  const capture = handleCapture(prisma);

  r.post('/razorpay', async (req, res) => {
    const raw = (req as RawBodyRequest).rawBody;
    if (raw === undefined) {
      res.status(500).json({ detail: 'Raw body was not captured — webhook misconfigured.' });
      return;
    }
    const signature = req.header('x-razorpay-signature') ?? '';
    if (!options.webhookSecret || !verifyWebhookSignature(raw, signature, options.webhookSecret)) {
      res.status(401).json({ type: 'authentication-error', title: 'Unauthorized', status: 401, detail: 'Webhook signature verification failed.' });
      return;
    }
    try {
      const event = req.body as {
        event: string;
        payload: {
          payment?: { entity: { id: string; order_id: string; amount: number; method?: string; status: string } };
        };
      };
      const payment = event.payload?.payment?.entity;
      if (!payment) { res.json({ received: true }); return; }

      const intent = await prisma.payment.findFirst({ where: { gatewayOrderId: payment.order_id } });
      if (!intent) { res.json({ received: true, matched: false }); return; }

      switch (event.event) {
        case 'payment.captured':
        case 'payment.authorized': {
          const result = await capture(intent.id, payment.id, payment.amount / 100, payment.method, event);
          res.json({ received: true, captured: result.captured, reason: result.reason ?? null });
          return;
        }
        case 'payment.failed': {
          const failed = await failGatewayPayment(prisma, intent.id, `gateway event: ${event.event}`);
          res.json({ received: true, failed });
          return;
        }
        default:
          res.json({ received: true, ignored: event.event });
      }
    } catch (e) {
      // 500 makes Razorpay retry with backoff — desirable for transient DB
      // issues. Capture *decisions* (mismatch, non-capturable) return 200 with
      // captured:false — retrying a permanent condition is webhook spam.
      res.status(500).json({ detail: (e as Error).message });
    }
  });

  return r;
}

/**
 * Reconciliation (GATE 4): polls Razorpay for payments attached to our
 * still-INITIATED orders. A captured-at-the-gateway but never-webhooked
 * payment gets credited here. Amount mismatches are flagged, never
 * auto-credited.
 */
export function createReconcileRoute(options: GatewayRoutesOptions): Router {
  const { prisma } = options;
  const r = Router();
  const capture = handleCapture(prisma);

  r.post('/run', async (req, res) => {
    try {
      if (!options.razorpay) {
        res.status(503).json({ type: 'unavailable', title: 'Not Configured', status: 503, detail: 'Razorpay is not configured on this deployment.' });
        return;
      }
      const { branchId } = ctx(req);
      if (!branchId) { res.status(403).json({ detail: 'Account has no branch.' }); return; }
      const stale = await prisma.payment.findMany({
        where: { branchId, status: 'INITIATED', gatewayOrderId: { not: null } },
        take: 100,
        orderBy: { createdAt: 'asc' },
      });
      const captured: Array<{ paymentId: string; gatewayPaymentId: string }> = [];
      const mismatches: Array<{ paymentId: string; gatewayPaymentId: string; expected: number; actual: number }> = [];
      const stillOpen = stale.length;
      for (const intent of stale) {
        const { items } = await options.razorpay.fetchOrderPayments(intent.gatewayOrderId!);
        const paid = items.find((p) => p.status === 'captured' || p.status === 'authorized');
        if (!paid) continue;
        const result = await capture(intent.id, paid.id, paid.amount / 100, paid.method, { source: 'reconcile', gatewayPayment: paid });
        if (result.captured) captured.push({ paymentId: intent.id, gatewayPaymentId: paid.id });
        else if (result.reason === 'AMOUNT_MISMATCH') {
          mismatches.push({ paymentId: intent.id, gatewayPaymentId: paid.id, expected: Number(intent.amount), actual: paid.amount / 100 });
        }
      }
      res.json({ checked: stillOpen, captured, mismatches });
    } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
  });

  return r;
}

/** Gateway refunds (reversal ledger entries via the domain engine). */
export function createGatewayRefundRoute(options: GatewayRoutesOptions): Router {
  const { prisma } = options;
  const r = Router();

  r.post('/gateway', async (req, res) => {
    try {
      const { branchId, userId } = ctx(req);
      if (!branchId) { res.status(403).json({ detail: 'Account has no branch.' }); return; }
      const { paymentId, amount, reason } = req.body ?? {};
      if (!paymentId || !amount || !reason) {
        res.status(400).json({ type: 'validation-error', title: 'Invalid Input', status: 400, detail: 'paymentId, amount and reason are required.' });
        return;
      }
      const payment = await prisma.payment.findFirst({ where: { id: paymentId, branchId } });
      if (!payment) { res.status(404).json({ type: 'not-found', title: 'Not Found', status: 404, detail: 'Payment not found.' }); return; }
      const result = await refundGatewayPayment(prisma, { paymentId, amount, reason, createdBy: userId });
      res.status(201).json(result);
    } catch (e) { res.status(400).json({ detail: (e as Error).message }); }
  });

  return r;
}

/** Settlement report for the accountant (§4.1.6). */
export function createSettlementsRoute(options: GatewayRoutesOptions): Router {
  const { prisma } = options;
  const r = Router();

  r.get('/', async (req, res) => {
    try {
      const { branchId } = ctx(req);
      if (!branchId) { res.status(403).json({ detail: 'Account has no branch.' }); return; }
      const { from, to } = req.query;
      const payments = await prisma.payment.findMany({
        where: {
          branchId,
          status: 'SUCCESS',
          gatewayProvider: 'RAZORPAY',
          paidAt: {
            gte: from ? new Date(from as string) : new Date(Date.now() - 30 * 86400_000),
            lte: to ? new Date(to as string) : new Date(),
          },
        },
        orderBy: { paidAt: 'asc' },
      });
      const gross = payments.reduce((s, p) => s + Number(p.amount), 0);
      res.json({
        data: payments.map((p) => ({ id: p.id, receiptNo: p.receiptNo, amount: Number(p.amount), method: p.method, paidAt: p.paidAt, gatewayPaymentId: p.gatewayPaymentId })),
        totals: { count: payments.length, gross, netCredited: gross }, // gateway charges arrive with settlement reports; net = gross − fees
      });
    } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
  });

  return r;
}
