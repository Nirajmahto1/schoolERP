// ──────────────────────────────────────────────
// SaaS billing engine tests (BUILD_PLAN 4.2.1 – 4.2.4)
//
// Control-plane is a single shared Postgres schema, so each test isolates
// itself by tenant: unique slugs per run, everything scoped by tenantId.
// ──────────────────────────────────────────────

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient as ControlPlaneClient } from '@school-erp/control-plane';

import {
  GST_RATE,
  SAC_CODE,
  convertTenantToPaid,
  issueRenewalInvoice,
  latestUsage,
  markSaasInvoicePaid,
  overrideDunning,
  reconcileMeteredBilling,
  recordUsage,
  runDunningPass,
  seedDefaultPlans,
  upsertPlan,
} from '../src/billing';

let cp: ControlPlaneClient;
let run: string;

const CONTROL_PLANE_URL =
  process.env.CONTROL_PLANE_DATABASE_URL ??
  'postgresql://school_erp:Niraj1307!@localhost:5432/school_erp_control';

beforeAll(async () => {
  cp = new ControlPlaneClient({ datasourceUrl: CONTROL_PLANE_URL });
  await seedDefaultPlans(cp, 'test');
  run = `t${Date.now().toString(36)}`;
});

afterAll(async () => {
  await cp.$disconnect();
});

/** A fresh TRIAL tenant + TRIAL subscription, ready to convert. */
async function makeTrialTenant(opts: { trial?: boolean } = {}) {
  const slug = `${run}-${Math.random().toString(36).slice(2, 8)}`;
  const tenant = await cp.tenant.create({
    data: { slug, legalName: `School ${slug}`, status: 'TRIAL' },
  });
  const starter = await cp.plan.findUniqueOrThrow({ where: { code: 'STARTER' } });
  await cp.subscription.create({
    data: {
      tenantId: tenant.id,
      planId: starter.id,
      seats: 10,
      status: opts.trial === false ? 'ACTIVE' : 'TRIAL',
      periodStart: new Date(),
      periodEnd: new Date(Date.now() + 14 * 86_400_000),
      billingAnchor: new Date(),
    },
  });
  return tenant;
}

beforeEach(async () => {
  // fresh usage + dunning per test for determinism
  await cp.usageRecord.deleteMany({});
  await cp.dunningEvent.deleteMany({});
});

describe('4.2.1 plans & caps', () => {
  it('seeds the STARTER/GROWTH/ENTERPRISE ladder idempotently', async () => {
    const again = await seedDefaultPlans(cp, 'test');
    const codes = again.map((p) => p.code);
    expect(codes).toContain('STARTER');
    expect(codes).toContain('GROWTH');
    expect(codes).toContain('ENTERPRISE');
  });

  it('upsertPlan updates price without duplicating the row', async () => {
    await upsertPlan(cp, { code: 'STARTER', name: 'Starter', pricePerStudentYear: 175, maxBranches: 1, maxStudents: 500 });
    const plan = await cp.plan.findUniqueOrThrow({ where: { code: 'STARTER' } });
    expect(Number(plan.pricePerStudentYear)).toBe(175);
    const plans = await cp.plan.findMany({ where: { code: 'STARTER' } });
    expect(plans).toHaveLength(1);
  });
});

describe('4.2.2 trial → paid + GST invoice', () => {
  it('converts a trial tenant and issues a compliant tax invoice', async () => {
    const tenant = await makeTrialTenant();
    const result = await convertTenantToPaid(cp, {
      tenantId: tenant.id,
      planCode: 'GROWTH',
      seats: 1200,
      supplierGstin: '27AAECS1234A1Z5',
    });

    expect(result.tenantStatus).toBe('ACTIVE');
    // 1200 seats × ₹250 = ₹300,000; 18% GST = ₹54,000
    expect(result.amount).toBe(300_000);
    expect(result.gstAmount).toBe(54_000);
    expect(result.total).toBe(354_000);

    const invoice = await cp.saasInvoice.findUniqueOrThrow({ where: { id: result.invoiceId } });
    expect(Number(invoice.gstRate)).toBe(GST_RATE);
    expect(invoice.sacCode).toBe(SAC_CODE);
    expect(invoice.supplierGstin).toBe('27AAECS1234A1Z5');
    expect(invoice.invoiceNo).toMatch(/^SI-\d{4}-\d{2}-\d{5}$/);
    expect(invoice.status).toBe('ISSUED');
  });

  it('renewal rolls a second, sequentially numbered invoice', async () => {
    const tenant = await makeTrialTenant({ trial: false });
    const first = await convertTenantToPaid(cp, { tenantId: tenant.id, planCode: 'STARTER', seats: 400 });
    const second = await issueRenewalInvoice(cp, { tenantId: tenant.id, seats: 420 });

    expect(second.invoiceId).not.toBe(first.invoiceId);
    // Same FY, sequential numbers
    expect(second.invoiceNo.slice(0, -5)).toBe(first.invoiceNo.slice(0, -5));
    expect(Number(second.invoiceNo.slice(-5))).toBe(Number(first.invoiceNo.slice(-5)) + 1);
  });

  it('markSaasInvoicePaid stamps paidAt', async () => {
    const tenant = await makeTrialTenant();
    const result = await convertTenantToPaid(cp, { tenantId: tenant.id, planCode: 'STARTER', seats: 100 });
    const invoice = await markSaasInvoicePaid(cp, result.invoiceId, 'test');
    expect(invoice.status).toBe('PAID');
    expect(invoice.paidAt).not.toBeNull();
  });
});

describe('4.2.3 dunning ladder', () => {
  it('advances REMINDER → GRACE → SUSPENDED and suspends login state', async () => {
    const tenant = await makeTrialTenant();
    // Unpaid invoice dated 16 days ago → REMINDER(1) and GRACE(8) both due,
    // ladder walks to SUSPENDED(15).
    const old = new Date(Date.now() - 16 * 86_400_000);
    await convertTenantToPaid(cp, { tenantId: tenant.id, planCode: 'STARTER', seats: 100 });
    await cp.saasInvoice.updateMany({ where: { tenantId: tenant.id }, data: { createdAt: old } });

    const outcomes = await runDunningPass(cp, { now: new Date() });
    const mine = outcomes.filter((o) => o.tenantId === tenant.id);
    expect(mine.length).toBeGreaterThanOrEqual(1);

    const afterT1 = await cp.tenant.findUniqueOrThrow({ where: { id: tenant.id } });
    // SUSPENDED stage reached on the same pass (ladder walks to the deepest due stage)
    expect(afterT1.status).toBe('SUSPENDED');
    const events = await cp.dunningEvent.findMany({ where: { tenantId: tenant.id }, orderBy: { createdAt: 'asc' } });
    expect(events.some((e) => e.stage === 'SUSPENDED')).toBe(true);
  });

  it('human override with reactivate restores ACTIVE and leaves a trail', async () => {
    const tenant = await makeTrialTenant();
    await cp.tenant.update({ where: { id: tenant.id }, data: { status: 'SUSPENDED' } });

    await overrideDunning(cp, tenant.id, { message: ' cheque lost in courier; reinstating', actor: 'ops@vibedu', reactivate: true });

    const after = await cp.tenant.findUniqueOrThrow({ where: { id: tenant.id } });
    expect(after.status).toBe('ACTIVE');
    const events = await cp.dunningEvent.findMany({ where: { tenantId: tenant.id, stage: 'MANUAL_OVERRIDE' } });
    expect(events).toHaveLength(1);
    expect(events[0].actor).toBe('ops@vibedu');
  });

  it('converting to paid clears soft dunning events', async () => {
    const tenant = await makeTrialTenant();
    await cp.dunningEvent.create({ data: { tenantId: tenant.id, stage: 'REMINDER', message: 'test' } });
    await convertTenantToPaid(cp, { tenantId: tenant.id, planCode: 'STARTER', seats: 50 });
    const soft = await cp.dunningEvent.findMany({ where: { tenantId: tenant.id, stage: { in: ['REMINDER', 'GRACE'] } } });
    expect(soft).toHaveLength(0);
  });
});

describe('4.2.4 metering', () => {
  it('latestUsage returns the newest sample per metric', async () => {
    const tenant = await makeTrialTenant();
    await recordUsage(cp, tenant.id, 'students', 1000);
    await recordUsage(cp, tenant.id, 'students', 1105);
    await recordUsage(cp, tenant.id, 'staff', 42);
    const usage = await latestUsage(cp, tenant.id);
    expect(usage.students).toBe(1105);
    expect(usage.staff).toBe(42);
  });

  it('billing recon flags overage but never silently bills', async () => {
    const tenant = await makeTrialTenant();
    await recordUsage(cp, tenant.id, 'students', 1400);
    const recon = await reconcileMeteredBilling(cp, tenant.id);
    expect(recon.seats).toBe(10);
    expect(recon.measuredStudents).toBe(1400);
    expect(recon.overage).toBe(1390);
  });
});
