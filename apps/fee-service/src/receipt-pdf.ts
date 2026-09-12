// ──────────────────────────────────────────────
// Receipt PDF writer — hand-rolled, zero-dependency (BUILD_PLAN 4.1.4)
//
// A fee receipt is one page of text and hairlines; that needs almost none of
// pdfkit. This writes a minimal, valid PDF 1.4 with the base-14 Helvetica
// fonts — no compression, no images, no font embedding — so it renders
// everywhere (browsers, WhatsApp preview, the school's laser printer) with
// zero native deps. Escape \ ( ) in text; that is the whole hard part.
// ──────────────────────────────────────────────

const PAGE_W = 595; // A4 @ 72dpi
const PAGE_H = 842;
const MARGIN = 48;

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

/** Helvetica character widths (per 1000 units) for the ASCII range we print. */
const WIDTHS: { regular: Record<number, number>; bold: Record<number, number> } = {
  bold: buildWidths([278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 500, 500, 333, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 278, 278, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500]),
  regular: buildWidths([278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 500, 500, 334, 260, 334, 584, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 278, 278, 500, 500, 500, 500]),
};

function buildWidths(arr: number[]): Record<number, number> {
  const out: Record<number, number> = {};
  for (let i = 0; i < arr.length; i++) out[32 + i] = arr[i];
  return out;
}

function textWidth(text: string, size: number, bold: boolean): number {
  const w = bold ? WIDTHS.bold : WIDTHS.regular;
  let total = 0;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    total += w[code] ?? 556;
  }
  return (total / 1000) * size;
}

/** Narrow the string until it fits `maxWidth` at `size`. */
function clip(text: string, size: number, bold: boolean, maxWidth: number): string {
  if (textWidth(text, size, bold) <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && textWidth(`${t}…`, size, bold) > maxWidth) t = t.slice(0, -1);
  return `${t}…`;
}

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

interface Op { op: 'text'; x: number; y: number; size: number; bold: boolean; text: string }
interface Line { op: 'line'; x1: number; y1: number; x2: number; y2: number }
type Draw = Op | Line;

/**
 * Build the receipt PDF. Coordinates are PDF-native (origin bottom-left).
 * Content model is deliberately tiny: positioned text + rules — exactly what
 * a receipt needs, and what keeps the writer auditable.
 */
export function renderReceiptPdf(d: PdfReceiptData): Buffer {
  const ops: Draw[] = [];
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
  ops.push({ op: 'text', x: 0, y: ry, size: 0, bold: false, text: '' }); // spacer no-op
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

  // Footnote pinned near the bottom
  ops.push({ op: 'text', x: MARGIN, y: MARGIN + 8, size: 8, bold: false, text: esc(d.footnote) });

  return assemble(ops);
}

/** Serialize the content stream + objects into a valid single-page PDF. */
function assemble(ops: Draw[]): Buffer {
  const parts: string[] = [];
  for (const o of ops) {
    if (o.op === 'text') {
      if (!o.text) continue;
      parts.push(`BT /${o.bold ? 'F2' : 'F1'} ${o.size} Tf 1 0 0 1 ${o.x.toFixed(2)} ${o.y.toFixed(2)} Tm (${esc(o.text)}) Tj ET`);
    } else {
      parts.push(`${o.x1.toFixed(2)} ${o.y1.toFixed(2)} m ${o.x2.toFixed(2)} ${o.y2.toFixed(2)} l S`);
    }
  }
  const content = `${parts.join('\n')}\n`;

  // 1: Catalog, 2: Pages, 3: Page, 4: F1 Helvetica, 5: F2 Helvetica-Bold, 6: Contents
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream`,
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  return Buffer.from(pdf, 'latin1');
}
