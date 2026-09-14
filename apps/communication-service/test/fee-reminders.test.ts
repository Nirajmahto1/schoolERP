// ──────────────────────────────────────────────
// Fee reminder trigger tests (BUILD_PLAN 5.6 #2)
//
// The money conversation with a parent is the most sensitive message a
// school sends. These prove the semantics: only outstanding money reminds,
// DUE_SOON and OVERDUE word differently, a re-run never re-spams (the log
// rows dedupe per invoice + kind), and the nightly sweep is branch-scoped.
// ──────────────────────────────────────────────

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { PrismaClient } from '@school-erp/database';
import { TestDatabase, assertionFor, seedTenant, testKeypair, type TenantSeed } from '@school-erp/testing';
import { createCommunicationApp } from '../src/index';

describe('fee due/overdue reminders', () => {
  let db: TestDatabase;
  let prisma: PrismaClient;
  let keypair: ReturnType<typeof testKeypair>;
  let seed: TenantSeed;
  let app: Express;
  let invoiceSeq = 0;

  const asComm = (): string =>
    assertionFor(keypair, 'communication-service', {
      userId: seed.adminUserId,
      email: 'admin@feerem.test',
      tenantId: seed.schoolId,
      branchId: seed.branchId,
      roles: ['BRANCH_ADMIN'],
      permissions: [],
    } as never);

  /** An outstanding invoice for the seeded student, due in `daysFromNow` days. */
  async function seedInvoice(daysFromNow: number, opts: { total?: number; paid?: number; status?: 'ISSUED' | 'PARTIALLY_PAID' | 'PAID' | 'VOID' } = {}) {
    invoiceSeq += 1;
    const dueDate = new Date();
    dueDate.setUTCDate(dueDate.getUTCDate() + daysFromNow);
    const total = opts.total ?? 12000;
    const paid = opts.paid ?? 0;
    return prisma.invoice.create({
      data: {
        branchId: seed.branchId,
        invoiceNo: `INV-FR-${String(invoiceSeq).padStart(5, '0')}`,
        studentId: seed.studentId,
        academicYearId: seed.academicYearId,
        dueDate,
        totalAmount: total,
        paidAmount: paid,
        status: opts.status ?? (paid > 0 ? 'PARTIALLY_PAID' : 'ISSUED'),
      },
    });
  }

  beforeAll(async () => {
    db = await TestDatabase.create(
      process.env.DATABASE_URL ?? 'postgresql://school_erp:Niraj1307!@localhost:5432/school_erp',
      { project: 'database' },
    );
    prisma = db.client();
    seed = await seedTenant(prisma, { code: 'FEEREM', name: 'Fee Reminder School' });
    keypair = testKeypair();
    app = createCommunicationApp({
      env: { INTERNAL_ASSERTION_PUBLIC_KEY: keypair.publicKey },
      prisma,
      messaging: { whatsapp: null, sms: null, quietHours: { start: 2, end: 3 } },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await db.teardown();
  });

  it('queues a DUE_SOON reminder for an invoice due within the window', async () => {
    const inv = await seedInvoice(2); // due in 2 days, inside the 3-day window

    const scan = await request(app)
      .post('/fee-reminders/scan')
      .set('x-internal-assertion', asComm())
      .send({})
      .expect(200);

    expect(scan.body.dueSoonFound).toBeGreaterThanOrEqual(1);
    expect(scan.body.remindersQueued).toBeGreaterThanOrEqual(1);
    const log = await prisma.notificationLog.findFirstOrThrow({ where: { template: `fee_reminder:DUE_SOON:${inv.invoiceNo}` } });
    expect(log.status).toBe('QUEUED');
    expect(log.channel).toBe('WHATSAPP');
    expect(log.subject).toBe('Fee due reminder');
    expect(log.body).toContain(inv.invoiceNo);
    expect(log.body).toContain('Rs. 12000.00');
    expect(log.body).toContain('Please pay before the due date');
  });

  it('queues an OVERDUE reminder with firm wording for a past-due invoice', async () => {
    const inv = await seedInvoice(-5); // due 5 days ago

    const scan = await request(app)
      .post('/fee-reminders/scan')
      .set('x-internal-assertion', asComm())
      .send({})
      .expect(200);

    expect(scan.body.overdueFound).toBeGreaterThanOrEqual(1);
    const log = await prisma.notificationLog.findFirstOrThrow({ where: { template: `fee_reminder:OVERDUE:${inv.invoiceNo}` } });
    expect(log.subject).toBe('Fee overdue notice');
    expect(log.body).toContain('OVERDUE');
    expect(log.body).toContain('still unpaid');
  });

  it('re-scanning never re-reminds (idempotent per invoice + kind)', async () => {
    const scan = await request(app)
      .post('/fee-reminders/scan')
      .set('x-internal-assertion', asComm())
      .send({})
      .expect(200);

    expect(scan.body.alreadyReminded).toBeGreaterThanOrEqual(2); // both invoices from before
    expect(scan.body.remindersQueued).toBe(0);
  });

  it('skips fully-paid, void, and far-future invoices', async () => {
    const paid = await seedInvoice(2, { total: 5000, paid: 5000, status: 'PAID' });
    const overpaid = await seedInvoice(2, { total: 5000, paid: 6000, status: 'PAID' });
    const void_ = await seedInvoice(2, { status: 'VOID' });
    const farFuture = await seedInvoice(30); // outside the 3-day window

    const before = await prisma.notificationLog.count({ where: { recipientType: 'GUARDIAN', OR: [{ template: { startsWith: 'fee_reminder:DUE_SOON:' } }, { template: { startsWith: 'fee_reminder:OVERDUE:' } }] } });

    const scan = await request(app)
      .post('/fee-reminders/scan')
      .set('x-internal-assertion', asComm())
      .send({})
      .expect(200);

    // The 30-day-out invoice is not in the window; nothing new for the others.
    const rows = await prisma.notificationLog.findMany({
      where: { recipientType: 'GUARDIAN', OR: [{ template: { startsWith: 'fee_reminder:DUE_SOON:' } }, { template: { startsWith: 'fee_reminder:OVERDUE:' } }] },
    });
    expect(rows.length).toBe(before); // no new rows at all
    expect(rows.some((r) => r.template.includes(farFuture.invoiceNo))).toBe(false);
    expect(rows.some((r) => r.template.includes(paid.invoiceNo))).toBe(false);
    expect(rows.some((r) => r.template.includes(overpaid.invoiceNo))).toBe(false);
    expect(rows.some((r) => r.template.includes(void_.invoiceNo))).toBe(false);
  });

  it('partially-paid invoices remind for the OUTSTANDING amount only', async () => {
    const inv = await seedInvoice(1, { total: 20000, paid: 15000 }); // 5,000 outstanding

    const scan = await request(app)
      .post('/fee-reminders/scan')
      .set('x-internal-assertion', asComm())
      .send({ channel: 'WHATSAPP' })
      .expect(200);

    expect(scan.body.remindersQueued).toBeGreaterThanOrEqual(1);
    const log = await prisma.notificationLog.findFirstOrThrow({ where: { template: `fee_reminder:DUE_SOON:${inv.invoiceNo}` } });
    expect(log.body).toContain('Rs. 5000.00'); // outstanding, not total
  });

  it('one row per opted-in guardian; the drainer takes the rows from there', async () => {
    const g2 = await prisma.guardian.create({ data: { fullName: 'Second Parent', phone: '918888888888' } });
    await prisma.studentGuardian.create({
      data: { studentId: seed.studentId, guardianId: g2.id, relation: 'MOTHER', receivesComms: true },
    });
    const inv = await seedInvoice(2);

    await request(app).post('/fee-reminders/scan').set('x-internal-assertion', asComm()).send({}).expect(200);

    const rows = await prisma.notificationLog.findMany({ where: { template: `fee_reminder:DUE_SOON:${inv.invoiceNo}` } });
    expect(rows).toHaveLength(2); // both opted-in guardians
    // Two guardians share the tag; the distinct dedupe means a re-scan skips.
    const again = await request(app).post('/fee-reminders/scan').set('x-internal-assertion', asComm()).send({}).expect(200);
    expect(again.body.remindersQueued).toBe(0);
    expect(again.body.alreadyReminded).toBeGreaterThanOrEqual(1);
  });
});
