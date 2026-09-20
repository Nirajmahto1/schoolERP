// ──────────────────────────────────────────────
// CBSE-style report card PDF (BUILD_PLAN 10.3 #1)
//
// One page: school header, student block, subject marks table with grades,
// totals + CGPA, co-scholastic areas, result line, signature rails. Layout
// primitives come from @school-erp/domain/pdf — the same auditable
// zero-dependency writer as receipts, tax invoices and certificates.
// ──────────────────────────────────────────────

import { assemblePdf, clip, MARGIN, PAGE_H, PAGE_W, textWidth, type DrawOp } from '@school-erp/domain';

export interface ReportCardPdfData {
  schoolName: string;
  schoolLines: string[];
  examinationName: string;
  student: { name: string; admissionNo: string; className: string; section: string; apaarId: string | null; dob: string };
  subjects: Array<{ subject: string; maxMarks: number; marksObtained: number | null; grade: string | null }>;
  total: { marks: number; maxMarks: number; percent: number | null; grade: string | null; cgpa: number | null };
  coScholastics: Array<{ area: string; grade: string }>;
  result: { remarks: string | null; pass: boolean | null };
}

export function renderReportCardPdf(d: ReportCardPdfData): Buffer {
  const ops: DrawOp[] = [];
  let y = PAGE_H - MARGIN;

  const text = (x: number, size: number, bold: boolean, t: string) => {
    ops.push({ op: 'text', x, y, size, bold, text: t });
  };
  const center = (size: number, bold: boolean, t: string) => {
    const w = textWidth(t, size, bold);
    ops.push({ op: 'text', x: (PAGE_W - w) / 2, y, size, bold, text: t });
  };
  const rule = () => {
    ops.push({ op: 'line', x1: MARGIN, y1: y, x2: PAGE_W - MARGIN, y2: y });
  };

  // Header
  center(15, true, clip(d.schoolName.toUpperCase(), 15, true, PAGE_W - MARGIN * 2));
  y -= 16;
  for (const line of d.schoolLines) {
    center(8.5, false, clip(line, 8.5, false, PAGE_W - MARGIN * 2));
    y -= 11;
  }
  y -= 4;
  center(11, true, `REPORT CARD — ${clip(d.examinationName, 11, true, 360).toUpperCase()}`);
  y -= 10;
  rule();
  y -= 16;

  // Student block — two columns of label/value pairs.
  const col2 = PAGE_W / 2 + 12;
  const kv = (x: number, label: string, value: string) => {
    text(x, 9, true, label);
    text(x + textWidth(label, 9, true) + 4, 9, false, clip(value, 9, false, col2 - x - textWidth(label, 9, true) - 8));
  };
  kv(MARGIN, 'Name:', d.student.name);
  kv(col2, 'Class:', `${d.student.className} - ${d.student.section}`);
  y -= 13;
  kv(MARGIN, 'Admission No:', d.student.admissionNo);
  kv(col2, 'DOB:', d.student.dob);
  y -= 13;
  kv(MARGIN, 'APAAR/ABC ID:', d.student.apaarId ?? '-');
  y -= 14;

  // Subject table
  const cSubject = MARGIN, cMax = 330, cMarks = 420, cGrade = 500, cRight = PAGE_W - MARGIN;
  text(cSubject, 9.5, true, 'SUBJECT');
  text(cMax, 9.5, true, 'MAX');
  text(cMarks, 9.5, true, 'MARKS');
  text(cGrade, 9.5, true, 'GRADE');
  text(cRight - textWidth('RESULT', 9.5, true), 9.5, true, 'RESULT');
  y -= 4;
  rule();
  y -= 13;

  for (const s of d.subjects) {
    const pass = s.marksObtained == null ? null : undefined; // pass/fail needs passingMarks; kept grade-honest
    text(cSubject, 9.5, false, clip(s.subject, 9.5, false, cMax - cSubject - 8));
    text(cMax, 9.5, false, String(s.maxMarks));
    text(cMarks, 9.5, false, s.marksObtained == null ? 'AB' : String(s.marksObtained));
    text(cGrade, 9.5, true, s.grade ?? '-');
    text(cRight - textWidth(pass === null ? '-' : '-', 9.5, false), 9.5, false, '-');
    y -= 13;
  }
  rule();
  y -= 15;

  // Totals + CGPA
  text(MARGIN, 10, true, `TOTAL: ${d.total.marks} / ${d.total.maxMarks}`);
  text(250, 10, true, `PERCENT: ${d.total.percent ?? '-'}%`);
  text(370, 10, true, `GRADE: ${d.total.grade ?? '-'}`);
  text(460, 10, true, `CGPA: ${d.total.cgpa ?? '-'}`);
  y -= 20;

  // Co-scholastic areas
  if (d.coScholastics.length > 0) {
    text(MARGIN, 9.5, true, 'CO-SCHOLASTIC AREAS');
    y -= 13;
    let x = MARGIN;
    for (const cs of d.coScholastics) {
      const label = `${clip(cs.area, 9, false, 190)}: ${cs.grade}`;
      text(x, 9, false, label);
      x += textWidth(label, 9, false) + 18;
      if (x > PAGE_W - MARGIN - 120) { x = MARGIN; y -= 12; }
    }
    y -= 18;
  }

  // Result + remarks
  const resultWord = d.result.pass == null ? 'RESULT AWAITED' : d.result.pass ? 'PASS — PROMOTED' : 'NEEDS IMPROVEMENT';
  text(MARGIN, 10, true, resultWord);
  y -= 14;
  if (d.result.remarks) {
    text(MARGIN, 9, false, clip(`Class teacher: ${d.result.remarks}`, 9, false, PAGE_W - MARGIN * 2));
    y -= 13;
  }

  // Signature rails
  const sy = MARGIN + 26;
  ops.push({ op: 'line', x1: MARGIN, y1: sy, x2: MARGIN + 110, y2: sy });
  ops.push({ op: 'line', x1: (PAGE_W - 110) / 2, y1: sy, x2: (PAGE_W + 110) / 2, y2: sy });
  ops.push({ op: 'line', x1: PAGE_W - MARGIN - 110, y1: sy, x2: PAGE_W - MARGIN, y2: sy });
  text(MARGIN, 8.5, false, 'Class Teacher');
  text((PAGE_W - textWidth('Principal', 8.5, false)) / 2, 8.5, false, 'Principal');
  text(PAGE_W - MARGIN - textWidth('Parent / Guardian', 8.5, false), 8.5, false, 'Parent / Guardian');
  text(MARGIN, 8, false, `Generated ${new Date().toLocaleDateString('en-IN')} — EduCore`);

  return assemblePdf(ops);
}
