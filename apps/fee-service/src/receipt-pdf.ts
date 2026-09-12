// ──────────────────────────────────────────────
// Fee receipt PDF layout (BUILD_PLAN 4.1.4)
//
// The layout lives here; the zero-dependency PDF primitives (measure,
// escape, WinAnsi-transliterate, serialize) live in @school-erp/domain/pdf
// and are shared with the SaaS tax invoice — two documents, one auditable
// writer.
// ──────────────────────────────────────────────

import { assemblePdf, clip, MARGIN, PAGE_H, PAGE_W, textWidth, type DrawOp } from '@school-erp/domain';

export interface PdfReceiptData {
  receiptNo: string;
  date: string;
  schoolName: string;
  schoolLines: string[];
  studentLine: string;
  modeLine: string;
  referenceLine?: string | null;
  rows: Array<{ label: string; invoice: string; amount: string }>;
  total: string;
  footnote: string;
}

/**
 * Build the receipt PDF. Coordinates are PDF-native (origin bottom-left).
 * Content model is deliberately tiny: positioned text + rules — exactly what
 * a receipt needs, and what keeps the writer auditable.
 */
export function renderReceiptPdf(d: PdfReceiptData): Buffer {
  const ops: DrawOp[] = [];
  let y = PAGE_H - MARGIN;

  const text = (x: number, size: number, bold: boolean, t: string) => {
    ops.push({ op: 'text', x, y, size, bold, text: t });
  };
  const textRight = (xRight: number, size: number, bold: boolean, t: string) => {
    const w = textWidth(t, size, bold);
    ops.push({ op: 'text', x: xRight - w, y, size, bold, text: t });
  };

  // Letterhead
  const school = clip(d.schoolName, 16, true, PAGE_W - MARGIN * 2 - 180);
  text(MARGIN, 16, true, school);
  y -= 20;
  for (const line of d.schoolLines) {
    text(MARGIN, 9, false, clip(line, 9, false, 340));
    y -= 12;
  }
  // Receipt number block, top-right
  const ry = PAGE_H - MARGIN;
  const right = (t: string, size: number, bold: boolean, dy: number) => {
    const w = textWidth(t, size, bold);
    ops.push({ op: 'text', x: PAGE_W - MARGIN - w, y: ry - dy, size, bold, text: t });
  };
  right('FEE RECEIPT', 11, true, 0);
  right(`No: ${d.receiptNo}`, 10, true, 16);
  right(`Date: ${d.date}`, 9, false, 30);

  y -= 8;
  ops.push({ op: 'line', x1: MARGIN, y1: y, x2: PAGE_W - MARGIN, y2: y });
  y -= 26;

  // Student + mode
  text(MARGIN, 10, true, clip(`Student: ${d.studentLine}`, 10, true, PAGE_W - MARGIN * 2 - 220));
  right2(d.modeLine, 10, false, 0);
  y -= 16;

  function right2(t: string, size: number, bold: boolean, dy: number) {
    const w = textWidth(t, size, bold);
    ops.push({ op: 'text', x: PAGE_W - MARGIN - w, y: y + dy, size, bold, text: t });
  }

  // Table header band
  y -= 6;
  ops.push({ op: 'line', x1: MARGIN, y1: y, x2: PAGE_W - MARGIN, y2: y });
  y -= 16;
  text(MARGIN + 4, 9, true, 'FEE HEAD');
  text(260, 9, true, 'INVOICE');
  const colAmt = PAGE_W - MARGIN - 4;
  textRight(colAmt, 9, true, 'AMOUNT (INR)');
  y -= 6;
  ops.push({ op: 'line', x1: MARGIN, y1: y, x2: PAGE_W - MARGIN, y2: y });
  y -= 16;

  for (const row of d.rows) {
    text(MARGIN + 4, 9, false, clip(row.label, 9, false, 200));
    text(260, 9, false, clip(row.invoice, 9, false, 140));
    textRight(colAmt, 9, false, row.amount);
    y -= 16;
  }

  y -= 2;
  ops.push({ op: 'line', x1: MARGIN, y1: y, x2: PAGE_W - MARGIN, y2: y });
  y -= 18;
  textRight(PAGE_W / 2, 10, true, 'TOTAL PAID');
  textRight(colAmt, 10, true, d.total);

  y -= 26;
  text(MARGIN, 9, false, clip(d.modeLine, 9, false, PAGE_W - MARGIN * 2));
  if (d.referenceLine) {
    y -= 12;
    text(MARGIN, 8, false, clip(d.referenceLine, 8, false, PAGE_W - MARGIN * 2));
  }

  // Footnote pinned near the bottom (escaping happens in the writer).
  ops.push({ op: 'text', x: MARGIN, y: MARGIN + 8, size: 8, bold: false, text: d.footnote });

  return assemblePdf(ops);
}
