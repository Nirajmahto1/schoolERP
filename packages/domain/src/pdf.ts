// ──────────────────────────────────────────────
// Zero-dependency PDF 1.4 writer — shared by the fee receipt and the SaaS
// tax invoice (BUILD_PLAN 4.1.4 / 4.2.2).
//
// Both documents are one page of positioned text and hairlines; that needs
// almost none of pdfkit. This writes a minimal, valid PDF with the base-14
// Helvetica fonts — no compression, no images, no font embedding — so it
// renders everywhere (browsers, WhatsApp preview, the school's laser
// printer) with zero native deps.
//
// Content model is deliberately tiny: text ops + line ops. Callers build the
// layout; this module measures, escapes, and serializes. Escape \ ( ) in
// text; that is the whole hard part.
// ──────────────────────────────────────────────

export const PAGE_W = 595; // A4 @ 72dpi
export const PAGE_H = 842;
export const MARGIN = 48;

/**
 * Transliterate to WinAnsi (CP1252): the fonts declare /WinAnsiEncoding, so
 * smart punctuation must be emitted as its CP1252 byte, and anything WinAnsi
 * lacks (₹) is spelled out. Without this, latin1 encoding silently turns
 * em-dashes and ellipses into '?'.
 */
const WINANSI_MAP: Record<string, string> = {
  '\u2014': String.fromCharCode(0x97), // em dash
  '\u2013': String.fromCharCode(0x96), // en dash
  '\u2018': String.fromCharCode(0x91), // left single quote
  '\u2019': String.fromCharCode(0x92), // right single quote
  '\u201C': String.fromCharCode(0x93), // left double quote
  '\u201D': String.fromCharCode(0x94), // right double quote
  '\u2026': String.fromCharCode(0x85), // horizontal ellipsis
  '\u2022': String.fromCharCode(0x95), // bullet
  '\u20B9': 'Rs.', // rupee sign — WinAnsi has no glyph for it
};

function toWinAnsi(s: string): string {
  let out = '';
  for (const ch of s) out += WINANSI_MAP[ch] ?? (ch.codePointAt(0)! <= 0xff ? ch : '?');
  return out;
}

/** Escape the two characters PDF string literals care about. */
export const esc = (s: string) =>
  toWinAnsi(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

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

export function textWidth(text: string, size: number, bold = false): number {
  const w = bold ? WIDTHS.bold : WIDTHS.regular;
  let total = 0;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    total += w[code] ?? 556;
  }
  return (total / 1000) * size;
}

/** Narrow the string until it fits `maxWidth` at `size`. */
export function clip(text: string, size: number, bold: boolean, maxWidth: number): string {
  if (textWidth(text, size, bold) <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && textWidth(`${t}…`, size, bold) > maxWidth) t = t.slice(0, -1);
  return `${t}…`;
}

export interface TextOp { op: 'text'; x: number; y: number; size: number; bold: boolean; text: string }
export interface LineOp { op: 'line'; x1: number; y1: number; x2: number; y2: number }
export type DrawOp = TextOp | LineOp;

/**
 * Serialize the content stream + objects into a valid single-page PDF.
 * Objects: 1 Catalog, 2 Pages, 3 Page, 4 Helvetica, 5 Helvetica-Bold, 6 Contents.
 */
export function assemblePdf(ops: DrawOp[]): Buffer {
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

// ── Indian formatting helpers (shared by receipt + invoice documents) ──

/** ₹12,34,567.89 — en-IN grouping, always two decimals. */
export function formatInr(n: number): string {
  return n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** 12 Sep 2026 — the date style used on both documents. */
export function formatIndianDate(d: Date | string | null | undefined): string {
  return d
    ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
    : '—';
}
