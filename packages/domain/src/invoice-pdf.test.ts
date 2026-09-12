// ──────────────────────────────────────────────
// Tax-invoice PDF tests — the document must carry the Rule 46 anatomy, and
// the bytes must be a valid single-page PDF for both GST splits.
// ──────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import { renderTaxInvoicePdf, type TaxInvoicePdfData } from './invoice-pdf';
import { PAGE_H, PAGE_W, textWidth } from './pdf';

const BASE: TaxInvoicePdfData = {
  invoiceNo: 'SI-2026-27-00042',
  issueDate: '12 Sep 2026',
  supplierName: 'VibeEd Technologies Pvt Ltd',
  supplierAddress: '4th Floor, Tech Park, Pune 411001',
  supplierGstin: '27AAECS1234A1ZY',
  supplierPan: 'AAECS1234A',
  recipientName: 'Delhi Public School, Noida',
  recipientAddress: 'Sector 45, Noida',
  recipientGstin: null,
  placeOfSupply: '27 (Maharashtra)',
  reverseCharge: false,
  sacCode: '997331',
  description: 'School ERP subscription — Growth plan',
  periodLine: '1 Apr 2026 – 31 Mar 2027 · 1,200 students',
  taxableValue: 300_000,
  gstRate: 18,
  cgst: 27_000,
  sgst: 27_000,
  igst: 0,
  total: 354_000,
  amountInWords: 'Rupees Three Lakh Fifty Four Thousand Only',
};

/** Extract the (single) content stream text from our minimal PDF. */
function contentOf(pdf: Buffer): string {
  const s = pdf.toString('latin1');
  const start = s.indexOf('stream\n') + 7;
  const end = s.indexOf('endstream');
  return s.slice(start, end);
}

describe('tax invoice PDF (Rule 46 anatomy)', () => {
  it('produces a valid single-page PDF with base-14 fonts', () => {
    const pdf = renderTaxInvoicePdf(BASE);
    expect(pdf.subarray(0, 8).toString('latin1')).toBe('%PDF-1.4');
    expect(pdf.toString('latin1')).toContain('/BaseFont /Helvetica');
    expect(pdf.toString('latin1')).toContain('/Count 1');
    expect(pdf.toString('latin1').trimEnd().endsWith('%%EOF')).toBe(true);
  });

  it('prints both parties, GSTINs, PAN and the B2C distinction', () => {
    const content = contentOf(renderTaxInvoicePdf(BASE));
    expect(content).toContain('TAX INVOICE');
    expect(content).toContain('SI-2026-27-00042');
    expect(content).toContain('VibeEd Technologies');
    expect(content).toContain('27AAECS1234A1ZY');
    expect(content).toContain('PAN: AAEC');
    expect(content).toContain('GSTIN: 27AAECS1234A1ZY');
    expect(content).toContain('GSTIN: Unregistered');
  });

  it('shows the intra-state split: CGST 9% + SGST 9%, no IGST', () => {
    const content = contentOf(renderTaxInvoicePdf(BASE));
    expect(content).toContain('CGST @ 9.00%');
    expect(content).toContain('SGST/UTGST @ 9.00%');
    expect(content).not.toContain('IGST @ 18.00%');
    expect(content).toContain('27,000.00'); // en-IN grouping kicks in at 1,00,000
    expect(content).toContain('3,54,000.00'); // lakh grouping on the total
  });

  it('shows the inter-state split: IGST only', () => {
    const content = contentOf(
      renderTaxInvoicePdf({
        ...BASE,
        placeOfSupply: '29 (Karnataka)',
        recipientGstin: '29AAECS1234A1ZU',
        cgst: 0,
        sgst: 0,
        igst: 54_000,
        total: 354_000,
      }),
    );
    expect(content).toContain('IGST @ 18.00%');
    expect(content).not.toContain('CGST @');
    expect(content).toContain('GSTIN: 29AAECS1234A1ZU'); // registered recipient
  });

  it('marks unregistered recipients and prints reverse charge when set', () => {
    const content = contentOf(renderTaxInvoicePdf({ ...BASE, reverseCharge: true }));
    expect(content).toContain('Unregistered');
    expect(content).toContain('Reverse Charge: Yes');
  });

  it('carries the amount in words, SAC, period and signature block', () => {
    const content = contentOf(renderTaxInvoicePdf(BASE));
    expect(content).toContain('Rupees Three Lakh Fifty Four Thousand Only');
    expect(content).toContain('997331');
    expect(content).toContain('1,200 students');
    expect(content).toContain('Authorised Signatory');
    expect(content).toContain('true and correct');
  });

  it('prints the paid stamp when the invoice is settled', () => {
    const content = contentOf(renderTaxInvoicePdf({ ...BASE, paidOn: '15 Sep 2026' }));
    expect(content).toContain('Payment received on 15 Sep 2026');
  });

  it('keeps every text op inside the page box', () => {
    const pdf = renderTaxInvoicePdf(BASE);
    const content = contentOf(pdf);
    const re = /1 0 0 1 ([\d.]+) ([\d.]+) Tm/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content))) {
      const x = Number(m[1]);
      const y = Number(m[2]);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(PAGE_W);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(PAGE_H);
    }
  });

  it('clips a long supplier name instead of overflowing the party box', () => {
    const pdf = renderTaxInvoicePdf({ ...BASE, supplierName: 'A'.repeat(120) });
    const content = contentOf(pdf);
    expect(content).toMatch(/\x85/); // WinAnsi ellipsis byte — something was clipped
    // The clipped party-box line must fit its 240pt column.
    const line = content.match(/\(A+\x85\) Tj/)![0];
    const text = line.slice(1, line.lastIndexOf(')'));
    expect(textWidth(text, 10, true)).toBeLessThanOrEqual(240);
    // The signature line is clipped to the page width, never runs off-page.
    expect(content).not.toMatch(/Tm \(-/); // no negative x coordinates
  });
});
