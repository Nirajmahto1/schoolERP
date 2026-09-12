// ──────────────────────────────────────────────
// Tax-invoice PDF rendering tests (BUILD_PLAN 4.2.2 + Rule 46)
//
// Runs the full stack: convert a trial tenant → load the stored invoice →
// render → assert the Rule 46 anatomy in the bytes → assert caching.
// ──────────────────────────────────────────────

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient as ControlPlaneClient } from '@school-erp/control-plane';
import { convertTenantToPaid, seedDefaultPlans } from '../src/billing';
import { renderSaasInvoicePdf, toTaxInvoicePdfData } from '../src/invoice-pdf';

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

/** A fresh TRIAL tenant, ready to convert. */
async function makeTrialTenant(gst?: { gstin: string }) {
  const slug = `${run}-${Math.random().toString(36).slice(2, 8)}`;
  const tenant = await cp.tenant.create({
    data: { slug, legalName: `School ${slug}`, status: 'TRIAL', ...(gst ?? {}) },
  });
  const starter = await cp.plan.findUniqueOrThrow({ where: { code: 'STARTER' } });
  await cp.subscription.create({
    data: {
      tenantId: tenant.id,
      planId: starter.id,
      seats: 10,
      status: 'TRIAL',
      periodStart: new Date(),
      periodEnd: new Date(Date.now() + 14 * 86_400_000),
      billingAnchor: new Date(),
    },
  });
  return tenant;
}

describe('renderSaasInvoicePdf', () => {
  it('renders a Rule 46 PDF from a stored invoice and caches it', async () => {
    const tenant = await makeTrialTenant();
    const result = await convertTenantToPaid(cp, {
      tenantId: tenant.id,
      planCode: 'GROWTH',
      seats: 1200,
      supplierGstin: '27AAECS1234A1ZY',
      supplierName: 'VibeEd Technologies Pvt Ltd',
      supplierAddress: '4th Floor, Tech Park, Pune 411001',
    });

    const { pdf, cached } = await renderSaasInvoicePdf(cp, result.invoiceId);
    expect(cached).toBe(false);
    expect(pdf.subarray(0, 8).toString('latin1')).toBe('%PDF-1.4');
    expect(pdf.length).toBeGreaterThan(1200);
    const content = pdf.toString('latin1');
    expect(content).toContain('TAX INVOICE');
    expect(content).toContain(result.invoiceNo);
    expect(content).toContain('27AAECS1234A1ZY');
    expect(content).toContain('3,54,000.00');
    expect(content).toContain('Rupees Three Lakh Fifty Four Thousand Only');

    // Bytes land in the DB cache…
    const stored = await cp.saasInvoice.findUniqueOrThrow({
      where: { id: result.invoiceId },
      select: { invoicePdf: true },
    });
    expect(stored.invoicePdf).toBeTruthy();

    // …and a second call serves them.
    const second = await renderSaasInvoicePdf(cp, result.invoiceId);
    expect(second.cached).toBe(true);
    expect(second.pdf.equals(pdf)).toBe(true);

    // regenerate re-renders from the row.
    const third = await renderSaasInvoicePdf(cp, result.invoiceId, { regenerate: true });
    expect(third.cached).toBe(false);
    expect(third.pdf.equals(pdf)).toBe(true); // same row → same bytes
  });

  it('marks an unregistered school as B2C and a registered one as B2B', async () => {
    const b2c = await makeTrialTenant();
    const r1 = await convertTenantToPaid(cp, { tenantId: b2c.id, planCode: 'STARTER', seats: 50, supplierGstin: '27AAECS1234A1ZY' });
    const c1 = (await renderSaasInvoicePdf(cp, r1.invoiceId)).pdf.toString('latin1');
    expect(c1).toContain('GSTIN: Unregistered');
    expect(c1).toContain('CGST @ 9.00%'); // same state → intra-state

    const b2b = await makeTrialTenant({ isGstRegistered: true, gstin: '29AAECS1234A1ZU' });
    const r2 = await convertTenantToPaid(cp, { tenantId: b2b.id, planCode: 'STARTER', seats: 50, supplierGstin: '27AAECS1234A1ZY' });
    const c2 = (await renderSaasInvoicePdf(cp, r2.invoiceId)).pdf.toString('latin1');
    expect(c2).toContain('GSTIN: 29AAECS1234A1ZU');
    expect(c2).toContain('IGST @ 18.00%'); // MH → KA → inter-state
  });

  it('maps stored decimals and period fields into the layout data', () => {
    const data = toTaxInvoicePdfData(
      {
        invoiceNo: 'SI-2026-27-00007',
        issuedAt: new Date('2026-09-12'),
        supplierName: null,
        supplierAddress: null,
        supplierGstin: null,
        recipientName: null,
        recipientAddress: null,
        placeOfSupply: '27 (Maharashtra)',
        reverseCharge: false,
        sacCode: null,
        seats: 400,
        periodStart: new Date('2026-04-01'),
        periodEnd: new Date('2027-03-31'),
        pricePerStudent: '175.00',
        amount: '70000.00',
        gstRate: '18.00',
        gstAmount: '12600.00',
        cgstAmount: '6300.00',
        sgstAmount: '6300.00',
        igstAmount: '0',
        amountInWords: 'Rupees Eighty Two Thousand Six Hundred Only',
        paidAt: new Date('2026-09-15'),
      },
      { legalName: 'Fallback Legal Name', gstin: null, isGstRegistered: false },
    );
    expect(data.supplierName).toBe('VibeEd Technologies Pvt Ltd'); // env-less fallback
    expect(data.recipientName).toBe('Fallback Legal Name');
    expect(data.supplierGstin).toBeNull(); // → "GSTIN: Unregistered" path
    expect(data.taxableValue).toBe(70_000);
    expect(data.total).toBe(82_600);
    expect(data.periodLine).toContain('400 students');
    expect(data.periodLine).toContain('Rs.175/student/year');
    expect(data.paidOn).toBeTruthy();
  });
});
