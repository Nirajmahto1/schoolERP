// ──────────────────────────────────────────────
// Razorpay fee collection tests (BUILD_PLAN 4.1 + GATE 4)
//
// GATE 4, verbatim:
//   • End-to-end paid fee in Razorpay test mode, reconciled, receipt generated
//   • Deliberately dropped webhook is recovered by the reconciliation job
//   • Duplicate webhook does not double-credit (idempotency proven by test)
//   • Refund produces correct reversal ledger entries
//
// Razorpay is stubbed at the transport level (createFeeApp's razorpayFetch),
// so these run in CI without network access; the HMAC checks use the real
// crypto paths with real secrets. Every test seeds its OWN student + invoice,
// so captures never pollute each other's "outstanding dues".
// ──────────────────────────────────────────────

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { PrismaClient } from '@school-erp/database';
import { TestDatabase, assertionFor, seedTenant, testKeypair, testSecret, type TenantSeed } from '@school-erp/testing';
import { createHmac } from 'crypto';
import { createFeeApp } from '../src/index';
import type { FetchLike } from '../src/razorpay';

const KEY_ID = 'rzp_test_key1';
const KEY_SECRET = testSecret(24);
const WEBHOOK_SECRET = testSecret(24);

function webhookSignature(raw: string): string {
  return createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex');
}

describe('GATE 4: Razorpay fee collection', () => {
  let db: TestDatabase;
  let prisma: PrismaClient;
  let keypair: ReturnType<typeof testKeypair>;
  let seed: TenantSeed;
  let app: Express;
  let headTuitionId: string;
  let invoiceSeq = 0;
  let studentSeq = 0;

  /** Stub gateway state — what Razorpay "knows" in these tests. */
  const gwPayments = new Map<string, { order_id: string; amountPaise: number; status: string; method: string }>();
  let orderSeq = 0;

  const asFee = (): string =>
    assertionFor(keypair, 'fee-service', {
      userId: seed.adminUserId,
      email: 'admin@fee.test',
      tenantId: seed.schoolId,
      branchId: seed.branchId,
      roles: ['BRANCH_ADMIN'],
      permissions: [],
    } as never);

  /** A fresh student with one open ₹12,000 invoice; returns both ids. */
  async function seedDue(): Promise<{ studentId: string; invoiceNo: string }> {
    studentSeq += 1;
    const user = await prisma.user.create({
      data: {
        email: `due${studentSeq}@rzp.test`,
        passwordHash: 'x',
        defaultBranchId: seed.branchId,
        roleAssignments: { create: { roleId: 'sys_student', branchId: seed.branchId } },
      },
      select: { id: true },
    });
    const student = await prisma.student.create({
      data: {
        userId: user.id,
        branchId: seed.branchId,
        admissionNo: `RZP-${String(studentSeq).padStart(4, '0')}`,
        firstName: 'Due', lastName: String(studentSeq),
        dateOfBirth: new Date('2013-01-01'),
        gender: 'MALE',
        address: 'x',
        admissionDate: new Date('2026-04-01'),
      },
      select: { id: true },
    });
    invoiceSeq += 1;
    const invoiceNo = `RZP-INV-${String(invoiceSeq).padStart(3, '0')}`;
    await prisma.invoice.create({
      data: {
        invoiceNo, studentId: student.id, branchId: seed.branchId,
        academicYearId: seed.academicYearId, dueDate: new Date('2026-09-01'),
        totalAmount: 12000, status: 'ISSUED',
        lines: { create: { feeHeadId: headTuitionId, amount: 12000, description: 'Tuition' } },
        ledgerEntries: {
          create: {
            branchId: seed.branchId, studentId: student.id, academicYearId: seed.academicYearId,
            type: 'DEMAND', amount: 12000, feeHeadId: headTuitionId,
            description: 'Tuition', reference: invoiceNo,
          },
        },
      },
    });
    return { studentId: student.id, invoiceNo };
  }

  /** Run one captured gateway payment for a student, end to end. */
  async function payViaWebhook(studentId: string): Promise<{ orderId: string; gwPaymentId: string; paymentId: string }> {
    const order = await request(app)
      .post('/checkout/orders')
      .set('x-internal-assertion', asFee())
      .send({ studentId, academicYearId: seed.academicYearId })
      .expect(201);
    orderSeq += 1;
    const gwPaymentId = `pay_${orderSeq}`;
    gwPayments.set(gwPaymentId, { order_id: order.body.orderId, amountPaise: order.body.amount * 100, status: 'captured', method: 'card' });
    const event = {
      event: 'payment.captured',
      payload: { payment: { entity: { id: gwPaymentId, order_id: order.body.orderId, amount: order.body.amount * 100, method: 'card', status: 'captured' } } },
    };
    const raw = JSON.stringify(event);
    const res = await request(app)
      .post('/webhooks/razorpay')
      .set('x-razorpay-signature', webhookSignature(raw))
      .set('Content-Type', 'application/json')
      .send(raw)
      .expect(200);
    expect(res.body.captured).toBe(true);
    const payment = await prisma.payment.findFirstOrThrow({ where: { gatewayOrderId: order.body.orderId, status: 'SUCCESS' } });
    return { orderId: order.body.orderId, gwPaymentId, paymentId: payment.id };
  }

  beforeAll(async () => {
    db = await TestDatabase.create(process.env.DATABASE_URL as string);
    prisma = db.client();
    keypair = testKeypair();
    seed = await seedTenant(prisma, { code: 'RZP4', name: 'Razorpay Test School' });

    headTuitionId = (await prisma.feeHead.create({
      data: { code: 'TUIT', name: 'Tuition', branchId: seed.branchId, type: 'TUITION' },
    })).id;

    const fetchImpl: FetchLike = async (url, init) => {
      if (url.endsWith('/orders') && init?.method === 'POST') {
        const body = JSON.parse(init.body ?? '{}');
        orderSeq += 1;
        const id = `order_${orderSeq}`;
        return { ok: true, status: 200, json: async () => ({ id, amount: body.amount, currency: 'INR', status: 'created' }) };
      }
      const orderPayments = url.match(/\/orders\/(order_\d+)\/payments$/);
      if (orderPayments) {
        const items = [...gwPayments.entries()]
          .filter(([, p]) => p.order_id === orderPayments[1])
          .map(([pid, p]) => ({ id: pid, order_id: p.order_id, amount: p.amountPaise, status: p.status, method: p.method }));
        return { ok: true, status: 200, json: async () => ({ items }) };
      }
      const pay = url.match(/\/payments\/(pay_\d+)$/);
      if (pay) {
        const p = gwPayments.get(pay[1]);
        return {
          ok: true,
          status: 200,
          json: async () => (p ? { id: pay[1], order_id: p.order_id, amount: p.amountPaise, status: p.status, method: p.method } : {}),
        };
      }
      return { ok: false, status: 404, json: async () => ({ error: { description: 'not found' } }) };
    };

    app = createFeeApp({
      env: {
        INTERNAL_ASSERTION_PUBLIC_KEY: keypair.publicKey,
        RAZORPAY_KEY_ID: KEY_ID,
        RAZORPAY_KEY_SECRET: KEY_SECRET,
        RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
      },
      prisma,
      razorpayFetch: fetchImpl,
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await db.teardown();
  });

  it('creates a checkout order from open dues and stores an INITIATED intent', async () => {
    const { studentId } = await seedDue();
    const res = await request(app)
      .post('/checkout/orders')
      .set('x-internal-assertion', asFee())
      .send({ studentId, academicYearId: seed.academicYearId })
      .expect(201);

    expect(res.body.amount).toBe(12000);
    expect(res.body.orderId).toMatch(/^order_/);
    expect(res.body.keyId).toBe(KEY_ID);

    const intent = await prisma.payment.findUniqueOrThrow({ where: { id: res.body.paymentId } });
    expect(intent.status).toBe('INITIATED');
    expect(intent.gatewayOrderId).toBe(res.body.orderId);
    expect(Number(intent.amount)).toBe(12000);
    expect(intent.receiptNo).toBeNull(); // minted only at capture
  });

  it('captures via checkout verify: allocation, ledger, receipt (GATE 4 e2e)', async () => {
    const { studentId, invoiceNo } = await seedDue();
    const order = await request(app)
      .post('/checkout/orders')
      .set('x-internal-assertion', asFee())
      .send({ studentId, academicYearId: seed.academicYearId })
      .expect(201);

    orderSeq += 1;
    const paymentId = `pay_${orderSeq}`;
    gwPayments.set(paymentId, { order_id: order.body.orderId, amountPaise: order.body.amount * 100, status: 'captured', method: 'upi' });

    const sig = createHmac('sha256', KEY_SECRET).update(`${order.body.orderId}|${paymentId}`).digest('hex');
    const res = await request(app)
      .post('/checkout/verify')
      .set('x-internal-assertion', asFee())
      .send({ razorpay_order_id: order.body.orderId, razorpay_payment_id: paymentId, razorpay_signature: sig })
      .expect(200);

    expect(res.body.captured).toBe(true);
    expect(res.body.payment.receiptNo).toBeTruthy();

    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: res.body.payment.id } });
    expect(payment.status).toBe('SUCCESS');
    expect(payment.gatewayPaymentId).toBe(paymentId);
    expect(payment.gatewayProvider).toBe('RAZORPAY');

    const invoice = await prisma.invoice.findFirstOrThrow({ where: { invoiceNo } });
    expect(invoice.status).toBe('PAID');
    expect(Number(invoice.paidAmount)).toBe(12000);

    // Ledger ties out: DEMAND 12000, PAYMENT −12000 → 0.
    const ledgerSum = await prisma.feeLedger.aggregate({ where: { studentId }, _sum: { amount: true } });
    expect(Number(ledgerSum._sum.amount)).toBe(0);
  });

  it('rejects a bad checkout signature', async () => {
    const { studentId } = await seedDue();
    const order = await request(app)
      .post('/checkout/orders')
      .set('x-internal-assertion', asFee())
      .send({ studentId, academicYearId: seed.academicYearId })
      .expect(201);
    const res = await request(app)
      .post('/checkout/verify')
      .set('x-internal-assertion', asFee())
      .send({ razorpay_order_id: order.body.orderId, razorpay_payment_id: 'pay_fake', razorpay_signature: 'deadbeef' })
      .expect(400);
    expect(res.body.title).toBe('Bad Signature');
  });

  it('webhook captures a payment and a duplicate webhook does NOT double-credit (GATE 4 idempotency)', async () => {
    const { studentId } = await seedDue();
    const order = await request(app)
      .post('/checkout/orders')
      .set('x-internal-assertion', asFee())
      .send({ studentId, academicYearId: seed.academicYearId })
      .expect(201);

    orderSeq += 1;
    const gwPaymentId = `pay_${orderSeq}`;
    gwPayments.set(gwPaymentId, { order_id: order.body.orderId, amountPaise: order.body.amount * 100, status: 'captured', method: 'card' });
    const event = {
      event: 'payment.captured',
      payload: { payment: { entity: { id: gwPaymentId, order_id: order.body.orderId, amount: order.body.amount * 100, method: 'card', status: 'captured' } } },
    };
    const raw = JSON.stringify(event);

    const first = await request(app)
      .post('/webhooks/razorpay')
      .set('x-razorpay-signature', webhookSignature(raw))
      .set('Content-Type', 'application/json')
      .send(raw)
      .expect(200);
    expect(first.body.captured).toBe(true);

    // Deliberately the SAME event again (Razorpay retries; GATE 4: no double credit).
    const second = await request(app)
      .post('/webhooks/razorpay')
      .set('x-razorpay-signature', webhookSignature(raw))
      .set('Content-Type', 'application/json')
      .send(raw)
      .expect(200);
    expect(second.body.captured).toBe(false);

    const payment = await prisma.payment.findFirstOrThrow({ where: { gatewayOrderId: order.body.orderId, status: 'SUCCESS' } });
    const allocations = await prisma.paymentAllocation.findMany({ where: { paymentId: payment.id } });
    expect(allocations.reduce((s, a) => s + Number(a.amount), 0)).toBe(12000); // not 24000
    const ledgerSum = await prisma.feeLedger.aggregate({ where: { studentId }, _sum: { amount: true } });
    expect(Number(ledgerSum._sum.amount)).toBe(0); // still tied out
  });

  it('rejects a webhook with a bad signature (401)', async () => {
    const raw = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_x', order_id: 'order_x', amount: 100 } } } });
    await request(app)
      .post('/webhooks/razorpay')
      .set('x-razorpay-signature', 'not-the-real-signature')
      .set('Content-Type', 'application/json')
      .send(raw)
      .expect(401);
  });

  it('recovers a deliberately dropped webhook via the reconciliation job (GATE 4)', async () => {
    const { studentId } = await seedDue();
    const order = await request(app)
      .post('/checkout/orders')
      .set('x-internal-assertion', asFee())
      .send({ studentId, academicYearId: seed.academicYearId })
      .expect(201);

    orderSeq += 1;
    const gwPaymentId = `pay_${orderSeq}`;
    gwPayments.set(gwPaymentId, { order_id: order.body.orderId, amountPaise: order.body.amount * 100, status: 'captured', method: 'netbanking' });

    // NO webhook is delivered. The intent stays INITIATED...
    let intent = await prisma.payment.findFirstOrThrow({ where: { gatewayOrderId: order.body.orderId } });
    expect(intent.status).toBe('INITIATED');

    // ...until the reconciliation job polls the gateway.
    const res = await request(app)
      .post('/reconcile/run')
      .set('x-internal-assertion', asFee())
      .expect(200);
    expect(res.body.captured.map((c: { paymentId: string }) => c.paymentId)).toContain(intent.id);

    intent = await prisma.payment.findUniqueOrThrow({ where: { id: intent.id } });
    expect(intent.status).toBe('SUCCESS');
    const openAfter = await prisma.invoice.findMany({ where: { studentId, status: { in: ['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'] } } });
    expect(openAfter).toHaveLength(0);
    const ledgerSum = await prisma.feeLedger.aggregate({ where: { studentId }, _sum: { amount: true } });
    expect(Number(ledgerSum._sum.amount)).toBe(0);
  });

  it('flags an amount mismatch instead of crediting it', async () => {
    const { studentId } = await seedDue();
    const order = await request(app)
      .post('/checkout/orders')
      .set('x-internal-assertion', asFee())
      .send({ studentId, academicYearId: seed.academicYearId })
      .expect(201);

    orderSeq += 1;
    const gwPaymentId = `pay_${orderSeq}`;
    gwPayments.set(gwPaymentId, { order_id: order.body.orderId, amountPaise: 999 * 100, status: 'captured', method: 'upi' });
    const event = {
      event: 'payment.captured',
      payload: { payment: { entity: { id: gwPaymentId, order_id: order.body.orderId, amount: 999 * 100, method: 'upi', status: 'captured' } } },
    };
    const raw = JSON.stringify(event);
    const res = await request(app)
      .post('/webhooks/razorpay')
      .set('x-razorpay-signature', webhookSignature(raw))
      .set('Content-Type', 'application/json')
      .send(raw)
      .expect(200);
    expect(res.body.captured).toBe(false);

    const intent = await prisma.payment.findFirstOrThrow({ where: { gatewayOrderId: order.body.orderId } });
    expect(intent.status).toBe('INITIATED'); // untouched — a human looks at it
    const ledgerSum = await prisma.feeLedger.aggregate({ where: { studentId }, _sum: { amount: true } });
    expect(Number(ledgerSum._sum.amount)).toBe(12000); // only the DEMAND
  });

  it('refund produces correct reversal ledger entries (GATE 4)', async () => {
    const { studentId } = await seedDue();
    const { paymentId } = await payViaWebhook(studentId);

    // Partial refund of ₹2,000.
    const res = await request(app)
      .post('/refunds/gateway')
      .set('x-internal-assertion', asFee())
      .send({ paymentId, amount: 2000, reason: 'Transport credit for June' })
      .expect(201);
    expect(res.body.amount).toBe(2000);
    expect(res.body.reversals.length).toBeGreaterThan(0);

    const ledger = await prisma.feeLedger.findMany({ where: { paymentId, type: 'REFUND' } });
    expect(ledger.reduce((s, e) => s + Number(e.amount), 0)).toBe(2000);

    const invoice = await prisma.invoice.findFirstOrThrow({ where: { studentId } });
    expect(Number(invoice.paidAmount)).toBe(10000);
    expect(invoice.status).toBe('PARTIALLY_PAID');

    // Full ledger view: DEMAND +12000, PAYMENT −12000, REFUND +2000 → +2000
    // owed — which ties out with the invoice (12000 total − 10000 paid).
    const ledgerSum = await prisma.feeLedger.aggregate({ where: { studentId }, _sum: { amount: true } });
    expect(Number(ledgerSum._sum.amount)).toBe(2000);
    expect(Number(invoice.paidAmount)).toBe(10000);
  });

  it('refuses to refund more than the captured amount', async () => {
    const { studentId } = await seedDue();
    const { paymentId } = await payViaWebhook(studentId);
    await request(app)
      .post('/refunds/gateway')
      .set('x-internal-assertion', asFee())
      .send({ paymentId, amount: 50000, reason: 'over-refund attempt' })
      .expect(400);
  });

  it('checkout without configured keys answers 503, not a crash', async () => {
    const bare = createFeeApp({
      env: { INTERNAL_ASSERTION_PUBLIC_KEY: keypair.publicKey },
      prisma,
    });
    const { studentId } = await seedDue();
    await request(bare)
      .post('/checkout/orders')
      .set('x-internal-assertion', asFee())
      .send({ studentId, academicYearId: seed.academicYearId })
      .expect(503);
  });

  it('gateway payments show in the settlement report', async () => {
    const res = await request(app)
      .get('/settlements')
      .set('x-internal-assertion', asFee())
      .expect(200);
    expect(res.body.totals.count).toBeGreaterThanOrEqual(3);
    expect(res.body.totals.gross).toBeGreaterThan(0);
  });
});
