// ──────────────────────────────────────────────
// SaaS billing engine (BUILD_PLAN 4.2)
//
// 4.2.1 Plans: per-student/year pricing, branch/student caps, feature flags.
// 4.2.2 Tax invoices: 18% GST, SAC 997331, both GSTINs — "schools will ask
//        for a proper tax invoice". Trial→paid conversion issues one.
// 4.2.3 Dunning: reminders → grace → read-only suspension → churn. Automated
//        start, human override at every step (dunning_events is the trail).
// 4.2.4 Metering: point-in-time samples of students/staff/storage/credits.
//
// Enforced client-of-one rule: tenant state changes flow through HERE, so the
// status machine and the audit trail can never drift apart.
// ──────────────────────────────────────────────

import type { PrismaClient as ControlPlaneClient } from '@school-erp/control-plane';
import { audit } from './audit';
import { isValidGstin, gstinStateCode, stateName, panFromGstin, splitGst, amountInWords, GST_RATE, SAC_CODE } from '@school-erp/domain';

// ── 4.2.1 Plans ──

export type PlanFeatureFlags = Record<string, string | number | boolean | null>;

export interface UpsertPlanInput {
  code: string;
  name: string;
  pricePerStudentYear: number;
  maxBranches: number;
  maxStudents: number;
  featureFlags?: PlanFeatureFlags;
}

export async function upsertPlan(controlPlane: ControlPlaneClient, input: UpsertPlanInput, actor = 'cli') {
  const plan = await controlPlane.plan.upsert({
    where: { code: input.code },
    update: {
      name: input.name,
      pricePerStudentYear: input.pricePerStudentYear,
      maxBranches: input.maxBranches,
      maxStudents: input.maxStudents,
      ...(input.featureFlags ? { featureFlags: input.featureFlags } : {}),
    },
    create: {
      code: input.code,
      name: input.name,
      pricePerStudentYear: input.pricePerStudentYear,
      maxBranches: input.maxBranches,
      maxStudents: input.maxStudents,
      featureFlags: input.featureFlags ?? {},
    },
  });
  // ProvisionAudit.tenantId is a real FK to tenants — plan-level events are
  // not tenant-scoped, so the plan identity rides in the payload instead.
  await audit(controlPlane, actor, 'plan.upsert', null, { code: input.code, planId: plan.id });
  return plan;
}

export const DEFAULT_PLANS: UpsertPlanInput[] = [
  { code: 'STARTER', name: 'Starter', pricePerStudentYear: 150, maxBranches: 1, maxStudents: 500, featureFlags: { transport: false, library: true, exams: true } },
  { code: 'GROWTH', name: 'Growth', pricePerStudentYear: 250, maxBranches: 3, maxStudents: 3000, featureFlags: { transport: true, library: true, exams: true, communication: true } },
  { code: 'ENTERPRISE', name: 'Enterprise', pricePerStudentYear: 350, maxBranches: 50, maxStudents: 100_000, featureFlags: { transport: true, library: true, exams: true, communication: true, api: true } },
];

/** Seed the default ladder (STARTER/GROWTH/ENTERPRISE) — idempotent. */
export async function seedDefaultPlans(controlPlane: ControlPlaneClient, actor = 'cli') {
  for (const p of DEFAULT_PLANS) {
    await upsertPlan(controlPlane, p, actor);
  }
  return controlPlane.plan.findMany({ orderBy: { pricePerStudentYear: 'asc' } });
}

/** Cap check at enrollment time: does this tenant have student headroom? */
export async function checkStudentCap(
  controlPlane: ControlPlaneClient,
  tenantId: string,
  additionalStudents = 1,
): Promise<{ allowed: boolean; current: number; cap: number; planCode: string | null }> {
  const tenant = await controlPlane.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    include: { plan: true },
  });
  const latestUsage = await controlPlane.usageRecord.findFirst({
    where: { tenantId, metric: 'students' },
    orderBy: { capturedAt: 'desc' },
  });
  const current = Number(latestUsage?.value ?? 0);
  const cap = tenant.plan?.maxStudents ?? Number.MAX_SAFE_INTEGER;
  return { allowed: current + additionalStudents <= cap, current, cap, planCode: tenant.plan?.code ?? null };
}

// ── 4.2.2 Trial → paid + GST invoices ──

// Rate/SAC live in domain/gst.ts (single source of truth); re-exported here
// so callers of the billing engine keep their import surface.
export { GST_RATE, SAC_CODE };

export interface ConvertToPaidInput {
  tenantId: string;
  planCode: string;
  seats: number;
  /** Supplier GSTIN falls back to env in production; overridable for tests. */
  supplierGstin?: string;
  /** Rule 46(a): supplier legal name printed on the invoice. */
  supplierName?: string;
  /** Rule 46(a): supplier address printed on the invoice. */
  supplierAddress?: string;
  actor?: string;
}

export interface ConversionResult {
  tenantStatus: string;
  subscriptionId: string;
  invoiceId: string;
  invoiceNo: string;
  amount: number;
  gstAmount: number;
  /** Rule 46 split — exactly one of these pairs is non-zero. */
  cgst: number;
  sgst: number;
  igst: number;
  placeOfSupply: string;
  amountInWords: string;
  /** PAN embedded in the supplier GSTIN (TDS forms reference it). */
  supplierPan: string | null;
  total: number;
}

/**
 * Trial → ACTIVE: creates the subscription period and ISSUES a proper tax
 * invoice (18% GST, SAC, both GSTINs). Invoice numbering is a control-plane
 * counter per fiscal year: SI-2026-27-00001.
 */
export async function convertTenantToPaid(controlPlane: ControlPlaneClient, input: ConvertToPaidInput): Promise<ConversionResult> {
  const plan = await controlPlane.plan.findUnique({ where: { code: input.planCode } });
  if (!plan) throw new Error(`Unknown plan ${input.planCode}`);
  const tenant = await controlPlane.tenant.findUniqueOrThrow({ where: { id: input.tenantId } });

  const now = new Date();
  const periodEnd = new Date(now);
  periodEnd.setFullYear(periodEnd.getFullYear() + 1);

  const fiscalYear = now.getMonth() >= 3
    ? `${now.getFullYear()}-${String(now.getFullYear() + 1).slice(2)}`
    : `${now.getFullYear() - 1}-${String(now.getFullYear()).slice(2)}`;

  return controlPlane.$transaction(async (tx) => {
    // Serialize invoice numbering across the fleet: concurrent conversions
    // counting the same FY would mint duplicate invoiceNo values (the unique
    // index turns that into a failed sale). A transaction-level advisory lock
    // makes count+mint atomic against every other issuer.
    await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext('saas_invoice_numbering'))");

    const subscription = await tx.subscription.create({
      data: {
        tenantId: tenant.id,
        planId: plan.id,
        periodStart: now,
        periodEnd,
        seats: input.seats,
        status: 'ACTIVE',
        billingAnchor: now,
      },
    });

    // Fiscal-year invoice counter: count invoices from this FY and increment.
    // (Safe now — the advisory lock above holds until this tx commits.)
    const fyCount = await tx.saasInvoice.count({
      where: { invoiceNo: { startsWith: `SI-${fiscalYear}-` } },
    });
    const invoiceNo = `SI-${fiscalYear}-${String(fyCount + 1).padStart(5, '0')}`;

    const amount = Number(plan.pricePerStudentYear) * input.seats;

    // ── Rule 46, CGST Rules 2017: the tax-invoice anatomy ──
    // Place of supply = the recipient's state, read from THEIR GSTIN when
    // registered. Unregistered (B2C) schools fall back to OUR state — the
    // default location of supply for a registered supplier under Sec 10(2)
    // of the IGST Act (same-state supply → CGST+SGST).
    const supplierGstin = (input.supplierGstin ?? '').trim().toUpperCase() || null;
    if (supplierGstin && !isValidGstin(supplierGstin)) {
      throw new Error(`SUPPLIER_GSTIN fails checksum validation: ${supplierGstin}`);
    }
    const supplierState = supplierGstin ? gstinStateCode(supplierGstin) : '27'; // platform default: Maharashtra
    const recipientGstin = tenant.isGstRegistered && tenant.gstin ? tenant.gstin.trim().toUpperCase() : null;
    if (recipientGstin && !isValidGstin(recipientGstin)) {
      throw new Error(`School GSTIN fails checksum validation: ${recipientGstin} — fix the tenant record before invoicing.`);
    }
    const placeOfSupply = recipientGstin ? gstinStateCode(recipientGstin) : supplierState;
    const split = splitGst(amount, supplierState, placeOfSupply);
    const gstAmount = Math.round(split.totalTax * 100) / 100;

    const invoice = await tx.saasInvoice.create({
      data: {
        tenantId: tenant.id,
        invoiceNo,
        amount,
        gstAmount,
        cgstAmount: Math.round(split.cgst * 100) / 100,
        sgstAmount: Math.round(split.sgst * 100) / 100,
        igstAmount: Math.round(split.igst * 100) / 100,
        gstRate: GST_RATE,
        sacCode: SAC_CODE,
        // Rule 46 parties: legal names + addresses. We hold the school's
        // legal name; a billing address column does not exist, so the legal
        // name doubles as the address line until tenant onboarding captures
        // more. Supplier identity comes from env at CLI level.
        supplierName: input.supplierName ?? null,
        supplierAddress: input.supplierAddress ?? null,
        supplierGstin,
        recipientName: tenant.legalName,
        recipientAddress: null,
        placeOfSupply: `${placeOfSupply} (${stateName(placeOfSupply)})`,
        reverseCharge: false, // platform collects and remits GST itself
        amountInWords: amountInWords(amount + gstAmount),
        issuedAt: now,
        periodStart: now,
        periodEnd,
        seats: input.seats,
        pricePerStudent: plan.pricePerStudentYear,
        status: 'ISSUED',
      },
    });

    await tx.tenant.update({ where: { id: tenant.id }, data: { status: 'ACTIVE', planId: plan.id } });
    await tx.dunningEvent.deleteMany({ where: { tenantId: tenant.id, stage: { in: ['REMINDER', 'GRACE'] } } });

    const actor = input.actor ?? 'cli';
    await audit(tx as unknown as ControlPlaneClient, actor, 'tenant.convert-paid', tenant.id, { planCode: input.planCode, seats: input.seats, invoiceNo });

    return {
      tenantStatus: 'ACTIVE',
      subscriptionId: subscription.id,
      invoiceId: invoice.id,
      invoiceNo,
      amount,
      gstAmount,
      cgst: Math.round(split.cgst * 100) / 100,
      sgst: Math.round(split.sgst * 100) / 100,
      igst: Math.round(split.igst * 100) / 100,
      placeOfSupply: stateName(placeOfSupply),
      amountInWords: amountInWords(amount + gstAmount),
      supplierPan: supplierGstin ? panFromGstin(supplierGstin) : null,
      total: amount + gstAmount,
    };
  });
}

export interface IssueRenewalInput {
  tenantId: string;
  seats: number;
  supplierGstin?: string;
  /** Rule 46(a): supplier identity printed on the renewal invoice. */
  supplierName?: string;
  supplierAddress?: string;
  actor?: string;
}

/** Renewal invoice for an ACTIVE tenant (period rolls forward one year). */
export async function issueRenewalInvoice(controlPlane: ControlPlaneClient, input: IssueRenewalInput) {
  const tenant = await controlPlane.tenant.findUniqueOrThrow({
    where: { id: input.tenantId },
    include: { plan: true },
  });
  if (!tenant.plan) throw new Error('Tenant has no plan assigned.');
  return convertTenantToPaid(controlPlane, {
    tenantId: input.tenantId,
    planCode: tenant.plan.code,
    seats: input.seats,
    supplierGstin: input.supplierGstin,
    supplierName: input.supplierName,
    supplierAddress: input.supplierAddress,
    actor: input.actor,
  });
}

export async function markSaasInvoicePaid(controlPlane: ControlPlaneClient, invoiceId: string, actor = 'cli') {
  const invoice = await controlPlane.saasInvoice.update({
    where: { id: invoiceId },
    data: { status: 'PAID', paidAt: new Date() },
  });
  await audit(controlPlane, actor, 'saas_invoice.paid', invoice.tenantId, { invoiceId });
  return invoice;
}

// ── 4.2.3 Dunning ──

export const DUNNING_LADDER = [
  { stage: 'REMINDER', afterDaysPastDue: 1, nextStageDays: 7 },
  { stage: 'GRACE', afterDaysPastDue: 8, nextStageDays: 7 },
  { stage: 'SUSPENDED', afterDaysPastDue: 15, nextStageDays: 30 },
  { stage: 'CHURN_ALERT', afterDaysPastDue: 45, nextStageDays: null },
] as const;

export type DunningStage = (typeof DUNNING_LADDER)[number]['stage'];

/**
 * One pass of the dunning job. For every ACTIVE tenant whose latest invoice
 * is past due, advance the ladder: write the DunningEvent, set nextStageAt,
 * and SUSPEND the tenant at the SUSPENDED stage. Human override = calling
 * `overrideDunning` (recorded, with the actor's identity).
 */
export async function runDunningPass(
  controlPlane: ControlPlaneClient,
  opts: { now?: Date; supplierGstin?: string } = {},
): Promise<Array<{ tenantId: string; stage: string; suspended: boolean }>> {
  const now = opts.now ?? new Date();
  const outcomes: Array<{ tenantId: string; stage: string; suspended: boolean }> = [];

  const tenants = await controlPlane.tenant.findMany({
    where: { status: 'ACTIVE' },
    include: { invoices: { where: { status: 'ISSUED' }, orderBy: { createdAt: 'desc' }, take: 1 } },
  });

  for (const tenant of tenants) {
    const invoice = tenant.invoices[0];
    if (!invoice || !invoice.createdAt) continue;
    const daysPastDue = Math.floor((now.getTime() - invoice.createdAt.getTime()) / 86_400_000);

    // What stage is due as of now?
    const lastEvent = await controlPlane.dunningEvent.findFirst({
      where: { tenantId: tenant.id },
      orderBy: { createdAt: 'desc' },
    });
    const dueStage = [...DUNNING_LADDER]
      .reverse()
      .find((s) => daysPastDue >= s.afterDaysPastDue && (!lastEvent?.nextStageAt || lastEvent.nextStageAt <= now));
    if (!dueStage) continue;
    if (lastEvent?.stage === dueStage.stage) continue;

    const ladderIdx = DUNNING_LADDER.findIndex((s) => s.stage === dueStage.stage);
    const next = DUNNING_LADDER[ladderIdx + 1];
    const nextStageAt = next
      ? new Date(now.getTime() + dueStage.nextStageDays! * 86_400_000)
      : null;

    await controlPlane.dunningEvent.create({
      data: {
        tenantId: tenant.id,
        stage: dueStage.stage,
        channel: dueStage.stage === 'CHURN_ALERT' ? null : 'EMAIL',
        message: `Invoice ${invoice.invoiceNo ?? invoice.id} is ${daysPastDue} days past due — ${dueStage.stage}`,
        nextStageAt,
      },
    });

    let suspended = false;
    if (dueStage.stage === 'SUSPENDED' && tenant.status === 'ACTIVE') {
      await controlPlane.tenant.update({ where: { id: tenant.id }, data: { status: 'SUSPENDED' } });
      suspended = true;
    }

    outcomes.push({ tenantId: tenant.id, stage: dueStage.stage, suspended });
  }
  return outcomes;
}

/** Human override: stop, skip, or re-open the ladder — always recorded. */
export async function overrideDunning(
  controlPlane: ControlPlaneClient,
  tenantId: string,
  input: { message: string; actor: string; reactivate?: boolean },
) {
  await controlPlane.dunningEvent.create({
    data: { tenantId, stage: 'MANUAL_OVERRIDE', message: input.message, actor: input.actor },
  });
  if (input.reactivate) {
    await controlPlane.tenant.update({ where: { id: tenantId }, data: { status: 'ACTIVE' } });
  }
  await audit(controlPlane, input.actor, 'dunning.override', tenantId, { message: input.message, reactivate: input.reactivate ?? false });
}

// ── 4.2.4 Metering ──

export type UsageMetric = 'students' | 'staff' | 'storage_bytes' | 'messaging_credits';

export async function recordUsage(
  controlPlane: ControlPlaneClient,
  tenantId: string,
  metric: UsageMetric,
  value: number,
): Promise<void> {
  await controlPlane.usageRecord.create({ data: { tenantId, metric, value: BigInt(value) } });
}

export async function latestUsage(controlPlane: ControlPlaneClient, tenantId: string): Promise<Record<string, number>> {
  const rows = await controlPlane.usageRecord.findMany({
    where: { tenantId },
    orderBy: { capturedAt: 'desc' },
  });
  const seen = new Set<string>();
  const out: Record<string, number> = {};
  for (const row of rows) {
    if (seen.has(row.metric)) continue;
    seen.add(row.metric);
    out[row.metric] = Number(row.value);
  }
  return out;
}

export interface BillingReconResult {
  tenantId: string;
  seats: number;
  measuredStudents: number;
  overage: number;
}

/**
 * Metered billing reconciliation: seats on the subscription vs. measured
 * students. Overage > 0 means the school grew past its plan — the next
 * renewal uses the measured count (or the tenant upgrades). Never silently
 * billed; flagged for the humans who own the relationship.
 */
export async function reconcileMeteredBilling(
  controlPlane: ControlPlaneClient,
  tenantId: string,
): Promise<BillingReconResult> {
  const tenant = await controlPlane.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    include: { subscriptions: { orderBy: { periodStart: 'desc' }, take: 1 } },
  });
  const seats = tenant.subscriptions[0]?.seats ?? 0;
  const usage = await latestUsage(controlPlane, tenantId);
  const measured = usage.students ?? 0;
  return { tenantId, seats, measuredStudents: measured, overage: Math.max(0, measured - seats) };
}
