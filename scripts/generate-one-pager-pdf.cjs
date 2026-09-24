// ──────────────────────────────────────────────
// Render docs/go-to-market/ONE-PAGER.md as a one-page A4 PDF into
// sales-assets/, using the repo's zero-dep PDF writer (packages/domain).
// Run: node scripts/generate-one-pager-pdf.cjs
// (first build domain if dist is missing: npm run build -w @school-erp/domain)
// ──────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const { assemblePdf, textWidth, PAGE_W, PAGE_H, MARGIN } = require('../packages/domain/dist/pdf.js');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'docs/go-to-market/ONE-PAGER.md');
const OUT_DIR = path.join(ROOT, 'sales-assets');

if (!fs.existsSync(path.join(ROOT, 'packages/domain/dist/pdf.js'))) {
  console.error('domain not built — run: npm run build -w @school-erp/domain');
  process.exit(1);
}

// ── inline markdown → runs of {text, bold} ──
function inlineRuns(s) {
  const src = String(s)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // [text](href) → text
    .replace(/`([^`]+)`/g, '$1');            // `code` → code
  const runs = [];
  const re = /\*\*(.+?)\*\*/g;
  let last = 0, m;
  while ((m = re.exec(src))) {
    if (m.index > last) runs.push({ text: src.slice(last, m.index), bold: false });
    runs.push({ text: m[1], bold: true });
    last = m.index + m[0].length;
  }
  if (last < src.length) runs.push({ text: src.slice(last), bold: false });
  return runs.filter((r) => r.text.length);
}

// pack runs into lines of words that fit maxWidth
function wrapRuns(runs, size, maxWidth) {
  const words = [];
  for (const r of runs) {
    for (const w of r.text.split(/(\s+)/)) {
      if (w.length) words.push({ w: /^\s+$/.test(w) ? ' ' : w, bold: r.bold });
    }
  }
  const lines = [];
  let cur = [], curW = 0;
  const width = (t, b) => textWidth(t, size, b);
  for (const item of words) {
    const iw = width(item.w, item.bold);
    if (item.w !== ' ' && curW + iw > maxWidth && cur.length) {
      while (cur.length && cur[cur.length - 1].w === ' ') cur.pop();
      lines.push(cur);
      cur = [];
      curW = 0;
      if (item.w === ' ') continue;
    }
    cur.push(item);
    curW += iw;
  }
  if (cur.length) lines.push(cur);
  return lines;
}

// collapse adjacent same-style words back into drawable runs
function mergeWords(line) {
  const runs = [];
  for (const it of line) {
    const lastRun = runs[runs.length - 1];
    if (lastRun && lastRun.bold === it.bold) lastRun.text += it.w;
    else runs.push({ text: it.w, bold: it.bold });
  }
  return runs;
}

// ── parse the markdown into blocks ──
const lines = fs.readFileSync(SRC, 'utf8').split(/\r?\n/);
const blocks = [];

let i = 0;
while (i < lines.length && !lines[i].startsWith('# ')) i++;
blocks.push({ type: 'title', runs: [{ text: (lines[i] || '').slice(2).trim(), bold: true }] });
i++;

let quote = [];
let table = null;
const flushQuote = () => {
  if (quote.length) {
    blocks.push({ type: 'note', runs: inlineRuns(quote.join(' ')) });
    quote = [];
  }
};
const flushTable = () => {
  if (table) {
    blocks.push({ type: 'table', header: table.header, rows: table.rows });
    table = null;
  }
};

for (; i < lines.length; i++) {
  const line = lines[i].trimEnd();
  if (line.startsWith('>')) {
    quote.push(line.replace(/^>\s?/, ''));
    continue;
  }
  if (/^\s*\|/.test(line)) {
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue; // |---| separator
    if (!table) table = { header: cells, rows: [] };
    else table.rows.push(cells);
    continue;
  }
  flushTable();
  flushQuote();
  if (/^## /.test(line)) blocks.push({ type: 'h2', runs: inlineRuns(line.slice(3).trim()) });
  else if (/^### /.test(line)) blocks.push({ type: 'h3', runs: inlineRuns(line.slice(4).trim()) });
  else if (/^- /.test(line)) blocks.push({ type: 'bullet', runs: inlineRuns(line.slice(2).trim()) });
  else if (line.trim() === '') continue;
  else blocks.push({ type: 'p', runs: inlineRuns(line.trim()) });
}
flushQuote();
flushTable();

// ── layout onto a single A4 page ──
const ops = [];
const W = PAGE_W - 2 * MARGIN;
let y = PAGE_H - MARGIN;
let minY = y;

function need(h) {
  y -= h;
  if (y < minY) minY = y;
}

function drawRuns(x, yy, size, runs) {
  let cx = x;
  for (const r of runs) {
    if (!r.text) continue;
    ops.push({ op: 'text', x: cx, y: yy, size, bold: !!r.bold, text: r.text });
    cx += textWidth(r.text, size, r.bold);
  }
  return cx - x;
}

function para(runs, { size = 8.6, lineH = 10.6, x = MARGIN, width = W, gap = 3 } = {}) {
  for (const line of wrapRuns(runs, size, width)) {
    need(lineH);
    drawRuns(x, y, size, mergeWords(line));
  }
  need(gap);
}

function bullet(runs) {
  const size = 8.6, lineH = 10.6, indent = 11;
  const ls = wrapRuns(runs, size, W - indent);
  ls.forEach((ln, idx) => {
    need(lineH);
    if (idx === 0) ops.push({ op: 'text', x: MARGIN, y, size, bold: false, text: '\u2022' });
    drawRuns(MARGIN + indent, y, size, mergeWords(ln));
  });
  need(2.2);
}

function h2(runs) {
  need(12);
  drawRuns(MARGIN, y, 11, runs);
  y -= 4;
  ops.push({ op: 'line', x1: MARGIN, y1: y, x2: PAGE_W - MARGIN, y2: y });
  need(6.5);
}

function tableBlock(t) {
  const size = 8.4, lineH = 10.4, pad = 3.5;
  const n = t.header.length;
  const weights = n === 3 ? [1.1, 0.9, 2.0] : n === 2 ? [1, 1] : t.header.map(() => 1);
  const total = weights.reduce((a, b) => a + b, 0);
  const cols = [];
  let cx = MARGIN;
  for (const wgt of weights) {
    cols.push({ x: cx, w: (W * wgt) / total });
    cx += (W * wgt) / total;
  }

  const drawRow = (cells, boldAll = false) => {
    const wrapped = cells.map((c, ci) =>
      boldAll
        ? wrapRuns([{ text: c, bold: true }], size, cols[ci].w - 8)
        : wrapRuns(inlineRuns(c), size, cols[ci].w - 8),
    );
    const inner = Math.max(...wrapped.map((ls) => ls.length)) * lineH;
    y -= pad;
    const startY = y;
    wrapped.forEach((ls, ci) => {
      let ly = startY;
      for (const ln of ls) {
        drawRuns(cols[ci].x, ly, size, mergeWords(ln));
        ly -= lineH;
      }
    });
    y -= inner;
    return inner + pad;
  };

  const hairline = () => {
    y -= 3;
    ops.push({ op: 'line', x1: MARGIN, y1: y, x2: PAGE_W - MARGIN, y2: y });
  };

  drawRow(t.header, true);
  hairline();
  for (const row of t.rows) {
    drawRow(row);
    hairline();
  }
  need(9);
}

// title block
para(blocks[0].runs, { size: 15, lineH: 18, gap: 2 });
y -= 1;
ops.push({ op: 'line', x1: MARGIN, y1: y, x2: PAGE_W - MARGIN, y2: y });
need(8);

for (const b of blocks.slice(1)) {
  if (b.type === 'note') para(b.runs, { size: 8, lineH: 9.8, gap: 5 });
  else if (b.type === 'h2') h2(b.runs.map((r) => ({ ...r, bold: true })));
  else if (b.type === 'h3') para(b.runs.map((r) => ({ ...r, bold: true })), { size: 10.5, lineH: 13, gap: 4 });
  else if (b.type === 'bullet') bullet(b.runs);
  else if (b.type === 'table') tableBlock(b);
  else para(b.runs);
}

// footer, pinned to the bottom margin
ops.push({ op: 'line', x1: MARGIN, y1: 46, x2: PAGE_W - MARGIN, y2: 46 });
ops.push({
  op: 'text',
  x: MARGIN,
  y: 34,
  size: 7.5,
  bold: false,
  text: 'EduCore \u00b7 generated from docs/go-to-market/ONE-PAGER.md \u00b7 '
    + new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }),
});

fs.mkdirSync(OUT_DIR, { recursive: true });
const buf = assemblePdf(ops);
const out = path.join(OUT_DIR, 'EduCore-One-Pager.pdf');
fs.writeFileSync(out, buf);
console.log(`Wrote ${out} (${buf.length} bytes, ${ops.length} ops)`);
console.log(`lowest content y=${minY.toFixed(1)} (footer rule at 46 — ${minY < 60 ? 'WARNING: tight, shrink sizes' : 'fits'})`);
