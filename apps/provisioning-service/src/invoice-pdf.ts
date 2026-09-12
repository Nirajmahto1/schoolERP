// ──────────────────────────────────────────────
// SaaS tax invoice PDF rendering (BUILD_PLAN 4.2.2 + Rule 46, CGST Rules)
//
// One source of truth: the PDF derives from the SAME SaasInvoice row the
// accountant reconciles against — the number on the invoice the school
// receives is the number in the GSTR workbook. Bytes are cached in
// SaasInvoice.invoicePdf (base64) so re-downloads don't re-render; pass
// { regenerate: true } after a correction to force a fresh render.
//
// The layout lives in @school-erp/domain/invoice-pdf and is rendered by the
// same zero-dependency writer as the fee receipt (see fee-service).
// ──────────────────────────────────────────────

import type { PrismaClient as ControlPlaneClient } from '@school-erp/control-plane';
import { renderTaxInvoicePdf, formatIndianDate, type TaxInvoicePdfData } from '@school-erp/domain';

/** SaasInvoice + tenant as needed for the document. */
export async function loadSaasInvoiceForPdf(controlPlane: ControlPlaneClient, invoiceId: string) {
  return controlPlane.saasInvoice.findUniqueOrThrow({
    where: { id: invoiceId },
    include: { tenant: { select: { legalName: true, gstin: true, isGstRegistered: true } } },
  });
}

/** Stored row → layout data. Amounts are stored as rupees (Decimal(12,2)). */
export function toTaxInvoicePdfData(
  inv: {
    invoiceNo: string | null;
    issuedAt: Date | null;
    supplierName: string | null;
    supplierAddress: string | null;
    supplierGstin: string | null;
    recipientName: string | null;
    recipientAddress: string | null;
    placeOfSupply: string | null;
    reverseCharge: boolean;
    sacCode: string | null;
    seats: number | null;
    periodStart: Date | null;
    periodEnd: Date | null;
    pricePerStudent: unknown; // Decimal
    amount: unknown; // Decimal
    gstRate: unknown; // Decimal
    gstAmount: unknown; // Decimal
    cgstAmount: unknown; // Decimal
    sgstAmount: unknown; // Decimal
    igstAmount: unknown; // Decimal
    amountInWords: string | null;
    paidAt: Date | null;
  },
  tenant: { legalName: string; gstin: string | null; isGstRegistered: boolean },
): TaxInvoicePdfData {
  const n = (v: unknown) => Number(v ?? 0);
  const periodLine =
    inv.periodStart && inv.periodEnd
      ? `${formatIndianDate(inv.periodStart)} – ${formatIndianDate(inv.periodEnd)} · ${(
          inv.seats ?? 0
        ).toLocaleString('en-IN')} students${n(inv.pricePerStudent) ? ` @ Rs.${n(inv.pricePerStudent)}/student/year` : ''}`
      : null;

  return {
    invoiceNo: inv.invoiceNo ?? '(unnumbered)',
    issueDate: formatIndianDate(inv.issuedAt),
    supplierName: inv.supplierName ?? 'VibeEd Technologies Pvt Ltd',
    supplierAddress: inv.supplierAddress,
    supplierGstin: inv.supplierGstin,
    supplierPan: inv.supplierGstin ? inv.supplierGstin.slice(2, 12) : null,
    recipientName: inv.recipientName ?? tenant.legalName,
    recipientAddress: inv.recipientAddress,
    recipientGstin: tenant.isGstRegistered ? tenant.gstin : null,
    placeOfSupply: inv.placeOfSupply ?? '—',
    reverseCharge: inv.reverseCharge,
    sacCode: inv.sacCode ?? '997331',
    description: 'School ERP subscription (SaaS) — per-student annual licence',
    periodLine,
    taxableValue: n(inv.amount),
    gstRate: n(inv.gstRate),
    cgst: n(inv.cgstAmount),
    sgst: n(inv.sgstAmount),
    igst: n(inv.igstAmount),
    total: n(inv.amount) + n(inv.gstAmount),
    amountInWords: inv.amountInWords ?? '',
    paidOn: inv.paidAt ? formatIndianDate(inv.paidAt) : null,
  };
}

/**
 * Render (or fetch the cached) PDF for a tax invoice. Cache lives in
 * SaasInvoice.invoicePdf (base64); `regenerate` rebuilds after corrections.
 */
export async function renderSaasInvoicePdf(
  controlPlane: ControlPlaneClient,
  invoiceId: string,
  opts: { regenerate?: boolean } = {},
): Promise<{ pdf: Buffer; cached: boolean }> {
  const cachedB64 = opts.regenerate
    ? null
    : (await controlPlane.saasInvoice.findUnique({ where: { id: invoiceId }, select: { invoicePdf: true } }))
        ?.invoicePdf ?? null;
  if (cachedB64) return { pdf: Buffer.from(cachedB64, 'base64'), cached: true };

  const inv = await loadSaasInvoiceForPdf(controlPlane, invoiceId);
  const data = toTaxInvoicePdfData(inv, inv.tenant);
  const pdf = renderTaxInvoicePdf(data);

  await controlPlane.saasInvoice.update({
    where: { id: invoiceId },
    data: { invoicePdf: pdf.toString('base64') },
  });

  return { pdf, cached: false };
}
