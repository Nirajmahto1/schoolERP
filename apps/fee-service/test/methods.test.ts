// ──────────────────────────────────────────────
// Payment-method tests (BUILD_PLAN 4.1.3 / 4.1.5 / 4.1.8)
//
// Cheque lifecycle: RECEIVE (credits at once) → DEPOSIT → CREDIT, and the
// scandal path: BOUNCE reverses the credit + books the penalty, leaving the
// ledger tied out with the (restored) dues. Carry-forward re-demands closing
// balances into the new year so the GATE-2 tie-out survives the year roll.
// ──────────────────────────────────────────────

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { PrismaClient } from '@school-erp/database';
import { TestDatabase, assertionFor, seedTenant, testKeypair, type TenantSeed } from '@school-erp/testing';
import { createFeeApp } from '../src/index';

describe('payment methods (cheques, deposits, VAs, carry-forward)', () => {
  let db: TestDatabase;
  let prisma: PrismaClient;
  let keypair: ReturnType<typeof testKeypair>;
  let seed: TenantSeed;
  let app: Express;
  let headTuitionId: string;
  let studentSeq = 0;

  const asFee = (): string =>
    assertionFor(keypair, 'fee-service', {
      userId: seed.adminUserId,
      email: 'admin@methods.test',
      tenantId: seed.schoolId,
      branchId: seed.branchId,
      roles: ['BRANCH_ADMIN'],
      permissions: [],
    } as never);

  async function seedDue(amount = 8000): Promise<{ studentId: string; invoiceId: string }> {
    studentSeq += 1;
    const user = await prisma.user.create({
      data: {
        email: `m${studentSeq}@methods.test`,
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
        admissionNo: `MTH-${String(studentSeq).padStart(4, '0')}`,
        firstName: 'Meth', lastName: String(studentSeq),
        dateOfBirth: new Date('2013-01-01'),
        gender: 'FEMALE',
        address: 'x',
        admissionDate: new Date('2026-04-01'),
      },
      select: { id: true },
    });
    const invoice = await prisma.invoice.create({
      data: {
        invoiceNo: `MTH-INV-${String(studentSeq).padStart(3, '0')}`,
        studentId: student.id, branchId: seed.branchId, academicYearId: seed.academicYearId,
        dueDate: new Date('2026-09-01'), totalAmount: amount, status: 'ISSUED',
        lines: { create: { feeHeadId: headTuitionId, amount } },
        ledgerEntries: {
          create: {
            branchId: seed.branchId, studentId: student.id, academicYearId: seed.academicYearId,
            type: 'DEMAND', amount, feeHeadId: headTuitionId, reference: `MTH-INV-${studentSeq}`,
          },
        },
      },
    });
    return { studentId: student.id, invoiceId: invoice.id };
  }

  beforeAll(async () => {
    db = await TestDatabase.create(process.env.DATABASE_URL as string);
    prisma = db.client();
    keypair = testKeypair();
    seed = await seedTenant(prisma, { code: 'MTH4', name: 'Methods School' });
    headTuitionId = (await prisma.feeHead.create({
      data: { code: 'TUIT', name: 'Tuition', branchId: seed.branchId, type: 'TUITION' },
    })).id;
    app = createFeeApp({ env: { INTERNAL_ASSERTION_PUBLIC_KEY: keypair.publicKey }, prisma });
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await db.teardown();
  });

  it('cheque receive → deposit → credit: payment posts at receive, risk window closes at credit', async () => {
    const { studentId } = await seedDue();

    const rec = await request(app)
      .post('/cheques')
      .set('x-internal-assertion', asFee())
      .send({
        studentId, academicYearId: seed.academicYearId, amount: 8000,
        chequeNumber: 'CHQ-1001', bankName: 'HDFC', chequeDate: new Date('2026-09-05'),
      })
      .expect(201);
    expect(rec.body.receiptNo).toBeTruthy();
    expect(rec.body.chequeStatus).toBe('RECEIVED');

    // Payment posted immediately — the fee shows as covered.
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: rec.body.paymentId } });
    expect(payment.status).toBe('SUCCESS');
    expect(payment.method).toBe('CHEQUE');
    const invoice = await prisma.invoice.findFirstOrThrow({ where: { studentId } });
    expect(invoice.status).toBe('PAID');

    const dep = await request(app).post(`/cheques/${rec.body.chequeId}/deposit`).set('x-internal-assertion', asFee()).expect(200);
    expect(dep.body.status).toBe('DEPOSITED');

    const cred = await request(app).post(`/cheques/${rec.body.chequeId}/credit`).set('x-internal-assertion', asFee()).expect(200);
    expect(cred.body.status).toBe('CREDITED');
  });

  it('cheque bounce reverses the credit and books the penalty (4.1.8)', async () => {
    const { studentId } = await seedDue(6000);
    const rec = await request(app)
      .post('/cheques')
      .set('x-internal-assertion', asFee())
      .send({
        studentId, academicYearId: seed.academicYearId, amount: 6000,
        chequeNumber: 'CHQ-2002', bankName: 'SBI', chequeDate: new Date('2026-09-05'),
      })
      .expect(201);

    await request(app).post(`/cheques/${rec.body.chequeId}/deposit`).set('x-internal-assertion', asFee()).expect(200);

    const bounce = await request(app)
      .post(`/cheques/${rec.body.chequeId}/bounce`)
      .set('x-internal-assertion', asFee())
      .send({ reason: 'Insufficient funds', penaltyAmount: 750 })
      .expect(200);
    expect(bounce.body.status).toBe('BOUNCED');
    expect(bounce.body.penaltyAmount).toBe(750);

    // Dues restored: invoice back to OPEN (OVERDUE here — the seeded due
    // date is in the past), paid zeroed.
    const invoice = await prisma.invoice.findFirstOrThrow({ where: { studentId } });
    expect(invoice.paidAmount.toString()).toBe('0');
    expect(invoice.status).toBe('OVERDUE');

    // Ledger: DEMAND +6000, PAYMENT −6000, REFUND +6000 (reversal), LATE_FEE +750
    // → 6750 owed, and the payment itself is DISPUTED.
    const ledgerSum = await prisma.feeLedger.aggregate({ where: { studentId }, _sum: { amount: true } });
    expect(Number(ledgerSum._sum.amount)).toBe(6750);
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: rec.body.paymentId } });
    expect(payment.status).toBe('DISPUTED');

    // Double bounce refused.
    await request(app)
      .post(`/cheques/${rec.body.chequeId}/bounce`)
      .set('x-internal-assertion', asFee())
      .send({ reason: 'again' })
      .expect(409);
  });

  it('bank deposit bundles cheques and credit closes them', async () => {
    const a = await seedDue(3000);
    const b = await seedDue(4500);
    const ids: string[] = [];
    for (const { studentId } of [a, b]) {
      const rec = await request(app)
        .post('/cheques')
        .set('x-internal-assertion', asFee())
        .send({
          studentId, academicYearId: seed.academicYearId, amount: studentId === a.studentId ? 3000 : 4500,
          chequeNumber: `CHQ-D${ids.length}`, bankName: 'ICICI', chequeDate: new Date('2026-09-06'),
        })
        .expect(201);
      ids.push(rec.body.chequeId);
    }

    const deposit = await request(app)
      .post('/bank-deposits')
      .set('x-internal-assertion', asFee())
      .send({ depositedAt: new Date().toISOString(), bankName: 'ICICI Main', chequeIds: ids })
      .expect(201);
    expect(deposit.body.status).toBe('PREPARED');
    expect(Number(deposit.body.totalCheques)).toBe(7500);
    expect(deposit.body.depositSlipNo).toBeTruthy();

    const credit = await request(app).post(`/bank-deposits/${deposit.body.id}/credit`).set('x-internal-assertion', asFee()).expect(200);
    expect(credit.body.creditedCheques).toBe(2);

    const after = await prisma.chequePayment.findMany({ where: { id: { in: ids } } });
    expect(after.every((c) => c.status === 'CREDITED')).toBe(true);
  });

  it('virtual account is idempotent per student (4.1.3)', async () => {
    const { studentId } = await seedDue();
    const first = await request(app)
      .post('/virtual-accounts')
      .set('x-internal-assertion', asFee())
      .send({ studentId, accountNumber: 'VADPS0000001', ifsc: 'RAZR0000001', beneficiaryName: 'DPS Demo School' })
      .expect(201);
    expect(first.body.created).toBe(true);

    const second = await request(app)
      .post('/virtual-accounts')
      .set('x-internal-assertion', asFee())
      .send({ studentId, accountNumber: 'VADPS0000001', ifsc: 'RAZR0000001', beneficiaryName: 'DPS Demo School' })
      .expect(200);
    expect(second.body.created).toBe(false);
    expect(second.body.virtualAccount.id).toBe(first.body.virtualAccount.id);
  });

  it('carry-forward re-demands closing dues into the new year (4.1.5)', async () => {
    const { studentId } = await seedDue(5000);
    // Create the NEXT academic year.
    const nextYear = await prisma.academicYear.create({
      data: { branchId: seed.branchId, name: '2027-28', startDate: new Date('2027-04-01'), endDate: new Date('2028-03-31'), isCurrent: false },
    });

    // Dry run: reports but doesn't bill. Earlier tests in this branch left
    // other students with dues (bounced + unpaid VA student), so carried > 1
    // is CORRECT — carry-forward sweeps every due-bearing student.
    const dry = await request(app)
      .post('/carry-forward')
      .set('x-internal-assertion', asFee())
      .send({ fromAcademicYearId: seed.academicYearId, toAcademicYearId: nextYear.id, dryRun: true })
      .expect(200);
    const mine = dry.body.details.find((d: { studentId: string }) => d.studentId === studentId);
    expect(mine.balance).toBe(5000);
    expect(mine.skipped).toBe(false);

    // Real run.
    const run = await request(app)
      .post('/carry-forward')
      .set('x-internal-assertion', asFee())
      .send({ fromAcademicYearId: seed.academicYearId, toAcademicYearId: nextYear.id })
      .expect(200);
    expect(run.body.carried).toBeGreaterThanOrEqual(1);

    const carriedInvoice = await prisma.invoice.findFirstOrThrow({
      where: { studentId, academicYearId: nextYear.id },
    });
    expect(Number(carriedInvoice.totalAmount)).toBe(5000);
    const carriedLines = await prisma.invoiceLine.findMany({ where: { invoiceId: carriedInvoice.id } });
    expect(carriedLines[0].description).toContain('carried');

    // Ledger tie-out across BOTH years: old-year balance was re-demanded, so
    // the student now owes 5000 (old year) + 5000 (carried) = 10000 total.
    const totalLedger = await prisma.feeLedger.aggregate({ where: { studentId }, _sum: { amount: true } });
    expect(Number(totalLedger._sum.amount)).toBe(10000);
  });

  // ── 4.1.4: receipts render, cache, and queue to guardians ──

  it('receipt renders a valid PDF, caches the bytes, and HTML matches the receiptNo', async () => {
    const { studentId, invoiceId } = await seedDue(12000);
    const pay = await request(app)
      .post('/payments')
      .set('x-internal-assertion', asFee())
      .send({ studentId, academicYearId: seed.academicYearId, amount: 12000, method: 'CASH', invoiceIds: [invoiceId] })
      .expect(201);
    const paymentId = pay.body.payment.id;
    expect(paymentId).toBeTruthy();

    const pdf = await request(app)
      .get(`/payments/${paymentId}/receipt.pdf`)
      .set('x-internal-assertion', asFee())
      .expect(200)
      .expect('Content-Type', /pdf/);
    // A minimal PDF 1.4: header, xref table, EOF marker.
    expect(pdf.body.slice(0, 8).toString('latin1')).toContain('%PDF-1.4');
    expect(pdf.body.toString('latin1')).toContain('%%EOF');
    expect(pdf.body.toString('latin1')).toContain('FEE RECEIPT');
    expect(pdf.body.length).toBeGreaterThan(500);

    // Cached for the parent portal / batch downloads.
    const row = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(row.receiptPdf).toBe(pdf.body.toString('base64'));

    const json = await request(app)
      .get(`/payments/${paymentId}/receipt`)
      .set('x-internal-assertion', asFee())
      .expect(200);
    expect(json.body.receiptNo).toBe(row.receiptNo);
    expect(json.body.documentHtml).toContain(`Receipt ${row.receiptNo}`);
    expect(json.body.documentHtml).toContain('₹12,000.00');
  });

  it('receipt send queues EMAIL + WHATSAPP rows for opted-in guardians', async () => {
    const { studentId, invoiceId } = await seedDue(5000);
    // Guardian with email + phone, opted in.
    const gUser = await prisma.user.create({
      data: { email: `g${studentSeq}@methods.test`, passwordHash: 'x', defaultBranchId: seed.branchId },
      select: { id: true },
    });
    const guardian = await prisma.guardian.create({
      data: {
        userId: gUser.id, fullName: 'Rekha Meth',
        phone: '+919800000001', email: `g${studentSeq}@methods.test`,
        students: { create: { studentId, relation: 'MOTHER', receivesComms: true } },
      },
      select: { id: true },
    });

    const pay = await request(app)
      .post('/payments')
      .set('x-internal-assertion', asFee())
      .send({ studentId, academicYearId: seed.academicYearId, amount: 5000, method: 'CASH', invoiceIds: [invoiceId] })
      .expect(201);
    const paymentId = pay.body.payment.id;

    const sent = await request(app)
      .post(`/payments/${paymentId}/receipt/send`)
      .set('x-internal-assertion', asFee())
      .send({})
      .expect(201);
    expect(sent.body.queued).toBe(2);

    const logs = await prisma.notificationLog.findMany({ where: { recipientId: guardian.id } });
    expect(logs.map((l) => l.channel).sort()).toEqual(['EMAIL', 'WHATSAPP']);
    expect(logs.every((l) => l.status === 'QUEUED')).toBe(true);
    expect(logs.find((l) => l.channel === 'WHATSAPP')?.recipient).toBe('+919800000001');
    expect(logs.find((l) => l.channel === 'EMAIL')?.body).toContain('Receipt');
  });

  it('receipt send refuses non-SUCCESS payments', async () => {
    const { studentId } = await seedDue(9000);
    // An INITIATED gateway intent has no captured money → no receipt.
    const intent = await prisma.payment.create({
      data: {
        branchId: seed.branchId, studentId, academicYearId: seed.academicYearId,
        amount: 9000, method: 'ONLINE', status: 'INITIATED',
        gatewayProvider: 'razorpay', gatewayOrderId: 'order_test_receipt_gate',
      },
      select: { id: true },
    });
    await request(app)
      .post(`/payments/${intent.id}/receipt/send`)
      .set('x-internal-assertion', asFee())
      .send({})
      .expect(409);
  });
});
