// ──────────────────────────────────────────────
// SaaS tax invoice PDF (BUILD_PLAN 4.2.2, Rule 46 CGST Rules 2017)
//
// The invoice format Indian accountants expect before they'll process it:
// supplier/recipient party boxes with GSTINs, place of supply, reverse
// charge, the taxable value, the CGST/SGST-vs-IGST split printed per head
// (GSTR filings reconcile against these), amount in words, SAC, and a
// signature block. Rendered with the same zero-dep writer as the fee
// receipt (see ./pdf).
// ──────────────────────────────────────────────

import { assemblePdf, clip, formatInr, MARGIN, PAGE_W, textWidth, type DrawOp } from './pdf';

export interface TaxInvoicePdfData {
  invoiceNo: string;
  issueDate: string;
  supplierName: string;
  supplierAddress: string | null;
  supplierGstin: string | null;
  supplierPan: string | null;
  recipientName: string;
  recipientAddress: string | null;
  /** Null → "Unregistered" (B2C) — Rule 46(b) requires the distinction. */
  recipientGstin: string | null;
  /** "27 (Maharashtra)" — state code + name. */
  placeOfSupply: string;
  reverseCharge: boolean;
  sacCode: string;
  description: string;
  /** e.g. "1 Apr 2026 – 31 Mar 2027 · 1,200 students" */
  periodLine: string | null;
  taxableValue: number;
  gstRate: number;
  cgst: number;
  sgst: number;
  igst: number;
  total: number;
  amountInWords: string;
  /** When paid, printed under the total — proof-of-payment on the same page. */
  paidOn?: string | null;
  declaration?: string;
}

const RIGHT = PAGE_W - MARGIN;

export function renderTaxInvoicePdf(d: TaxInvoicePdfData): Buffer {
  const ops: DrawOp[] = [];
  let y = 842 - MARGIN;

  const text = (x: number, size: number, bold: boolean, t: string) => {
    ops.push({ op: 'text', x, y, size, bold, text: t });
  };
  const textRight = (xRight: number, size: number, bold: boolean, t: string) => {
    ops.push({ op: 'text', x: xRight - textWidth(t, size, bold), y, size, bold, text: t });
  };
  const hline = () => {
    ops.push({ op: 'line', x1: MARGIN, y1: y, x2: RIGHT, y2: y });
  };

  // ── Title block ──
  text(MARGIN, 16, true, 'TAX INVOICE');
  textRight(RIGHT, 10, true, `Invoice No: ${clip(d.invoiceNo, 10, true, 220)}`);
  y -= 14;
  textRight(RIGHT, 9, false, `Date: ${d.issueDate}`);
  if (d.supplierGstin) {
    y -= 12;
    textRight(RIGHT, 9, false, `Supplier GSTIN: ${d.supplierGstin}`);
  }
  y -= 6;
  hline();

  // ── Party boxes (supplier left, recipient right) ──
  y -= 22;
  const colMid = 302;
  text(MARGIN, 8, true, 'FROM (SUPPLIER)');
  text(colMid + 12, 8, true, 'BILL TO (RECIPIENT)');
  y -= 14;
  const partyTop = y + 14;

  text(MARGIN, 10, true, clip(d.supplierName, 10, true, 240));
  text(colMid + 12, 10, true, clip(d.recipientName, 10, true, 240));
  y -= 13;
  for (const line of [d.supplierAddress].filter(Boolean) as string[]) {
    text(MARGIN, 9, false, clip(line, 9, false, 240));
    y -= 12;
  }
  let yR = y + 13;
  for (const line of [d.recipientAddress].filter(Boolean) as string[]) {
    text(colMid + 12, 9, false, clip(line, 9, false, 235));
    yR -= 12;
  }
  y = Math.min(y, yR) - 4;
  text(MARGIN, 9, false, `GSTIN: ${d.supplierGstin ?? '—'}`);
  text(colMid + 12, 9, false, `GSTIN: ${d.recipientGstin ?? 'Unregistered'}`);
  y -= 12;
  if (d.supplierPan) {
    text(MARGIN, 9, false, `PAN: ${d.supplierPan}`);
    y -= 12;
  }
  ops.push({ op: 'line', x1: colMid, y1: partyTop, x2: colMid, y2: y + 6 });
  y -= 2;
  hline();

  // ── Place of supply / reverse charge strip ──
  y -= 16;
  text(MARGIN, 9, false, `Place of Supply: ${clip(d.placeOfSupply, 9, false, 300)}`);
  textRight(RIGHT, 9, false, `Reverse Charge: ${d.reverseCharge ? 'Yes' : 'No'}`);
  y -= 2;
  hline();

  // ── Description table ──
  y -= 16;
  text(MARGIN + 4, 9, true, 'DESCRIPTION');
  textRight(RIGHT - 4, 9, true, 'AMOUNT (INR)');
  y -= 6;
  hline();
  y -= 16;
  text(MARGIN + 4, 9, false, clip(d.description, 9, false, 380));
  textRight(RIGHT - 4, 9, false, formatInr(d.taxableValue));
  if (d.periodLine) {
    y -= 12;
    text(MARGIN + 4, 8, false, clip(d.periodLine, 8, false, 380));
  }
  y -= 6;
  hline();

  // ── Tax lines: only the non-zero heads (Rule 46 split) ──
  const halfRate = d.gstRate / 2;
  const taxRow = (label: string, amount: number) => {
    y -= 16;
    text(MARGIN + 4, 9, false, label);
    textRight(RIGHT - 4, 9, false, formatInr(amount));
  };
  if (d.cgst > 0) taxRow(`CGST @ ${halfRate.toFixed(2)}%`, d.cgst);
  if (d.sgst > 0) taxRow(`SGST/UTGST @ ${halfRate.toFixed(2)}%`, d.sgst);
  if (d.igst > 0) taxRow(`IGST @ ${d.gstRate.toFixed(2)}%`, d.igst);
  y -= 6;
  hline();

  // ── Total + words ──
  y -= 20;
  textRight(RIGHT - 260, 11, true, 'TOTAL');
  textRight(RIGHT - 4, 11, true, formatInr(d.total));
  y -= 16;
  text(MARGIN, 9, true, clip(d.amountInWords, 9, true, PAGE_W - MARGIN * 2));
  y -= 12;
  text(MARGIN, 9, false, `SAC/HSN: ${d.sacCode}`);
  if (d.paidOn) {
    y -= 12;
    text(MARGIN, 9, true, `Payment received on ${d.paidOn}`);
  }
  y -= 6;
  hline();

  // ── Declaration + signature ──
  y -= 16;
  const declaration =
    d.declaration ??
    'We declare that this invoice shows the actual price of the services described and that all particulars are true and correct.';
  for (const line of wrap(declaration, 8, false, 360)) {
    text(MARGIN, 8, false, line);
    y -= 11;
  }
  const sigY = Math.max(y - 14, MARGIN + 40);
  const sigName = clip(`For ${d.supplierName}`, 9, true, PAGE_W - MARGIN * 2);
  ops.push({ op: 'text', x: RIGHT - textWidth(sigName, 9, true), y: sigY, size: 9, bold: true, text: sigName });
  ops.push({ op: 'text', x: RIGHT - textWidth('Authorised Signatory', 8, false), y: sigY - 34, size: 8, bold: false, text: 'Authorised Signatory' });

  return assemblePdf(ops);
}

/** Greedy word-wrap for the declaration text. */
function wrap(t: string, size: number, bold: boolean, maxWidth: number): string[] {
  const words = t.split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const candidate = cur ? `${cur} ${w}` : w;
    if (textWidth(candidate, size, bold) <= maxWidth) {
      cur = candidate;
    } else {
      if (cur) lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}
