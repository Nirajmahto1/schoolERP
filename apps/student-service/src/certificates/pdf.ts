// ──────────────────────────────────────────────
// Certificate renderers (BUILD_PLAN 10.3 #4)
//
// "Certificates: Transfer Certificate (numbered, board-specific wording),
// bonafide, character, migration, fee-payment certificate, ID cards, admit
// cards. Small feature, constant demand."
//
// All six documents derive from the SAME snapshot shape — the JSON the issue
// route stamps at issue time — so what prints is byte-identical on every
// re-download, forever. The zero-dependency writer in @school-erp/domain does
// the measuring/escaping/serialization; this file is pure layout.
// ──────────────────────────────────────────────

import { assemblePdf, clip, MARGIN, PAGE_W, textWidth, type DrawOp } from '@school-erp/domain';

const RIGHT = PAGE_W - MARGIN;
const CONTENT_W = RIGHT - MARGIN;

export interface CertPayload {
  school: { name: string; address: string; city: string; state: string; pincode: string; phone: string; email: string };
  branch: { name: string; code: string };
  student: {
    name: string;
    admissionNo: string;
    dob: string; // formatted
    gender: string;
    father: string | null;
    mother: string | null;
    phone: string | null;
  };
  academic: { className: string; section: string; academicYear: string; rollNo: string | null };
  attendance: { workingDays: number; presentDays: number } | null;
  certNo: string;
  issueDate: string; // formatted
  purpose?: string | null;
  // FEE_CERTIFICATE only — invoice-level money facts, snapshot at issue.
  payments?: Array<{ invoiceNo: string; period: string; total: string; paid: string; status: string }>;
  totalOutstanding?: string;
  // ADMIT_CARD only
  examName?: string;
  subjects?: Array<{ name: string; date: string; timing: string; maxMarks?: string }>;
  // TC board-wording extras (CBSE-style sheet). Absent fields print '-'.
  category?: string;
  firstAdmission?: string;
  lastExam?: string;
  subjectsNames?: string;
  conduct?: string;
  applicationDate?: string;
  remarks?: string;
  // ID_CARD only
  bloodGroup?: string;
}

// ── shared helpers ──

function fmtMoney(n: string | number): string {
  const v = typeof n === 'string' ? Number(n) : n;
  return `Rs. ${v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function wrap(text: string, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (textWidth(next, size) > maxWidth && line) {
      lines.push(line);
      line = w;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

function header(ops: DrawOp[], d: CertPayload, title: string, startAt = 800): number {
  let y = startAt;
  ops.push({ op: 'text', x: MARGIN, y, size: 16, bold: true, text: clip(d.school.name, 16, true, CONTENT_W) });
  y -= 16;
  ops.push({
    op: 'text', x: MARGIN, y, size: 9, bold: false,
    text: clip(`${d.school.address}, ${d.school.city}, ${d.school.state} - ${d.school.pincode}`, 9, false, CONTENT_W),
  });
  y -= 13;
  ops.push({ op: 'text', x: MARGIN, y, size: 9, bold: false, text: clip(`Phone: ${d.school.phone}  |  Email: ${d.school.email}`, 9, false, CONTENT_W) });
  y -= 10;
  ops.push({ op: 'line', x1: MARGIN, y1: y, x2: RIGHT, y2: y });
  y -= 26;
  ops.push({ op: 'text', x: MARGIN + CONTENT_W / 2 - textWidth(title, 13, true) / 2, y, size: 13, bold: true, text: title });
  y -= 20;
  // Number + date — the certificate's identity line.
  ops.push({ op: 'text', x: MARGIN, y, size: 10, bold: false, text: `No: ${d.certNo}` });
  ops.push({ op: 'text', x: RIGHT - textWidth(`Date: ${d.issueDate}`, 10), y, size: 10, bold: false, text: `Date: ${d.issueDate}` });
  y -= 16;
  return y;
}

/** Ruled two-column row: label left, value right, hairline underneath. */
function row(ops: DrawOp[], y: number, n: number, label: string, value: string): number {
  ops.push({ op: 'text', x: MARGIN, y, size: 9.5, bold: false, text: `${n}.` });
  ops.push({ op: 'text', x: MARGIN + 18, y, size: 9.5, bold: false, text: clip(label, 9.5, false, 280) });
  ops.push({ op: 'text', x: MARGIN + 310, y, size: 9.5, bold: false, text: clip(value || '-', 9.5, false, RIGHT - MARGIN - 310) });
  ops.push({ op: 'line', x1: MARGIN, y1: y - 8, x2: RIGHT, y2: y - 8 });
  return y - 24;
}

function signatureFooter(ops: DrawOp[], y: number): void {
  ops.push({ op: 'line', x1: MARGIN, y1: y, x2: RIGHT, y2: y });
  ops.push({ op: 'text', x: MARGIN, y: y - 18, size: 9, bold: false, text: 'Prepared by' });
  ops.push({ op: 'text', x: MARGIN + 200, y: y - 18, size: 9, bold: false, text: 'Class Teacher' });
  ops.push({ op: 'text', x: RIGHT - textWidth('Principal (Seal & Signature)', 9, true), y: y - 18, size: 9, bold: true, text: 'Principal (Seal & Signature)' });
}

// ── 1. Bonafide ──

export function renderBonafidePdf(d: CertPayload): Buffer {
  const ops: DrawOp[] = [];
  let y = header(ops, d, 'BONAFIDE CERTIFICATE');
  y -= 24;
  const genderWord = d.student.gender === 'FEMALE' ? 'daughter' : 'son';
  const father = d.student.father ? `, ${genderWord} of Shri ${d.student.father}` : '';
  const body =
    `This is to certify that ${d.student.name}${father} is a bona fide student of ` +
    `${d.school.name} (${d.branch.name}), studying in Class ${d.academic.className}-${d.academic.section} ` +
    `during the academic year ${d.academic.academicYear}, bearing Admission No. ${d.student.admissionNo}.`;
  for (const line of wrap(body, 11, CONTENT_W)) {
    ops.push({ op: 'text', x: MARGIN, y, size: 11, bold: false, text: line });
    y -= 20;
  }
  if (d.purpose) {
    y -= 8;
    for (const line of wrap(`This certificate is issued at the student's request ${d.purpose}.`, 11, CONTENT_W)) {
      ops.push({ op: 'text', x: MARGIN, y, size: 11, bold: false, text: line });
      y -= 20;
    }
  }
  y -= 60;
  signatureFooter(ops, y);
  return assemblePdf(ops);
}

// ── 2. Character ──

export function renderCharacterPdf(d: CertPayload): Buffer {
  const ops: DrawOp[] = [];
  let y = header(ops, d, 'CHARACTER CERTIFICATE');
  y -= 24;
  const body =
    `This is to certify that ${d.student.name}, bearing Admission No. ${d.student.admissionNo}, ` +
    `studied in this school in Class ${d.academic.className}-${d.academic.section} during the academic year ` +
    `${d.academic.academicYear}. During his/her stay in the school, his/her conduct and character were found ` +
    `to be GOOD. He/She is leaving the school with no adverse remarks on record.`;
  for (const line of wrap(body, 11, CONTENT_W)) {
    ops.push({ op: 'text', x: MARGIN, y, size: 11, bold: false, text: line });
    y -= 20;
  }
  if (d.purpose) {
    y -= 8;
    for (const line of wrap(`Issued on request ${d.purpose}.`, 11, CONTENT_W)) {
      ops.push({ op: 'text', x: MARGIN, y, size: 11, bold: false, text: line });
      y -= 20;
    }
  }
  y -= 60;
  signatureFooter(ops, y);
  return assemblePdf(ops);
}

// ── 3. Fee-payment certificate ──

export function renderFeeCertificatePdf(d: CertPayload): Buffer {
  const ops: DrawOp[] = [];
  let y = header(ops, d, 'FEE PAYMENT CERTIFICATE');
  y -= 24;
  const body =
    `This is to certify that ${d.student.name} (Admission No. ${d.student.admissionNo}), ` +
    `of Class ${d.academic.className}-${d.academic.section}, academic year ${d.academic.academicYear}, ` +
    `has made the following fee payments against this school:`;
  for (const line of wrap(body, 11, CONTENT_W)) {
    ops.push({ op: 'text', x: MARGIN, y, size: 11, bold: false, text: line });
    y -= 20;
  }
  y -= 8;
  // Table: Invoice | Period | Total | Paid | Status
  const cols = [MARGIN, MARGIN + 150, MARGIN + 270, MARGIN + 390, MARGIN + 460];
  const heads = ['Invoice No.', 'Period', 'Total', 'Paid', 'Status'];
  ops.push({ op: 'line', x1: MARGIN, y1: y + 4, x2: RIGHT, y2: y + 4 });
  heads.forEach((h, i) => ops.push({ op: 'text', x: cols[i], y, size: 9.5, bold: true, text: h }));
  y -= 18;
  for (const p of d.payments ?? []) {
    ops.push({ op: 'text', x: cols[0], y, size: 9.5, bold: false, text: clip(p.invoiceNo, 9.5, false, 145) });
    ops.push({ op: 'text', x: cols[1], y, size: 9.5, bold: false, text: clip(p.period, 9.5, false, 115) });
    ops.push({ op: 'text', x: cols[2], y, size: 9.5, bold: false, text: p.total });
    ops.push({ op: 'text', x: cols[3], y, size: 9.5, bold: false, text: p.paid });
    ops.push({ op: 'text', x: cols[4], y, size: 9.5, bold: false, text: p.status });
    y -= 16;
  }
  ops.push({ op: 'line', x1: MARGIN, y1: y + 6, x2: RIGHT, y2: y + 6 });
  y -= 20;
  const closing = (d.totalOutstanding ?? 'Rs. 0.00') === 'Rs. 0.00'
    ? 'All fees due up to the date of this certificate have been paid in full.'
    : `Outstanding dues as on the date of this certificate: ${d.totalOutstanding}.`;
  for (const line of wrap(closing, 11, CONTENT_W)) {
    ops.push({ op: 'text', x: MARGIN, y, size: 11, bold: false, text: line });
    y -= 20;
  }
  y -= 40;
  signatureFooter(ops, y);
  return assemblePdf(ops);
}

// ── 4. Student ID card ──

export function renderIdCardPdf(d: CertPayload): Buffer {
  const ops: DrawOp[] = [];
  // Card region centered on the page.
  const x0 = 147, x1 = 447, yTop = 640, yBot = 300;
  ops.push({ op: 'line', x1: x0, y1: yTop, x2: x1, y2: yTop });
  ops.push({ op: 'line', x1: x0, y1: yBot, x2: x1, y2: yBot });
  ops.push({ op: 'line', x1: x0, y1: yTop, x2: x0, y2: yBot });
  ops.push({ op: 'line', x1: x1, y1: yTop, x2: x1, y2: yBot });

  const cx = (x0 + x1) / 2;
  let y = yTop - 26;
  ops.push({ op: 'text', x: cx - textWidth(d.school.name, 12, true) / 2, y, size: 12, bold: true, text: clip(d.school.name, 12, true, 290) });
  y -= 14;
  ops.push({ op: 'text', x: cx - textWidth('STUDENT IDENTITY CARD', 8, false) / 2, y, size: 8, bold: false, text: 'STUDENT IDENTITY CARD' });
  y -= 6;
  ops.push({ op: 'line', x1: x0, y1: y, x2: x1, y2: y });

  // Photo box (placeholder — photo upload stores a URL; printing it is a print-day concern).
  const pTop = y - 12, pBot = pTop - 100, pL = x0 + 18, pR = pL + 76;
  ops.push({ op: 'line', x1: pL, y1: pTop, x2: pR, y2: pTop });
  ops.push({ op: 'line', x1: pL, y1: pBot, x2: pR, y2: pBot });
  ops.push({ op: 'line', x1: pL, y1: pTop, x2: pL, y2: pBot });
  ops.push({ op: 'line', x1: pR, y1: pTop, x2: pR, y2: pBot });
  ops.push({ op: 'text', x: pL + 20, y: pBot + 46, size: 9, bold: false, text: 'Photo' });

  let ty = y - 30;
  const info = (label: string, value: string, bold = false) => {
    ops.push({ op: 'text', x: pR + 14, y: ty, size: 9.5, bold, text: clip(`${label}`, 9.5, bold, 70) });
    ops.push({ op: 'text', x: pR + 88, y: ty, size: 9.5, bold, text: clip(value, 9.5, bold, x1 - pR - 100) });
    ty -= 17;
  };
  info('Name:', d.student.name, true);
  info('Class:', `${d.academic.className}-${d.academic.section}`);
  info('Adm No:', d.student.admissionNo);
  info('DOB:', d.student.dob);
  info('Blood:', (d as CertPayload & { bloodGroup?: string }).bloodGroup ?? '-');
  info('Valid:', d.academic.academicYear);

  ops.push({ op: 'line', x1: x0, y1: yBot + 40, x2: x1, y2: yBot + 40 });
  ops.push({ op: 'text', x: cx - textWidth('This card must be carried at all times.', 7.5, false) / 2, y: yBot + 26, size: 7.5, bold: false, text: 'This card must be carried at all times.' });
  ops.push({ op: 'text', x: cx - textWidth('If found, please return to the school.', 7.5, false) / 2, y: yBot + 14, size: 7.5, bold: false, text: 'If found, please return to the school.' });
  ops.push({ op: 'text', x: x1 - textWidth('Authorised Signatory', 8, true) - 8, y: yBot + 62, size: 8, bold: true, text: 'Authorised Signatory' });
  return assemblePdf(ops);
}

// ── 5. Admit card ──

export function renderAdmitCardPdf(d: CertPayload): Buffer {
  const ops: DrawOp[] = [];
  const x0 = 60, x1 = PAGE_W - 60, yTop = 760, yBot = 220;
  ops.push({ op: 'line', x1: x0, y1: yTop, x2: x1, y2: yTop });
  ops.push({ op: 'line', x1: x0, y1: yBot, x2: x1, y2: yBot });
  ops.push({ op: 'line', x1: x0, y1: yTop, x2: x0, y2: yBot });
  ops.push({ op: 'line', x1: x1, y1: yTop, x2: x1, y2: yBot });

  const cx = (x0 + x1) / 2;
  let y = yTop - 28;
  ops.push({ op: 'text', x: cx - textWidth(d.school.name, 13, true) / 2, y, size: 13, bold: true, text: d.school.name });
  y -= 16;
  ops.push({ op: 'text', x: cx - textWidth('ADMIT CARD', 12, true) / 2, y, size: 12, bold: true, text: 'ADMIT CARD' });
  y -= 15;
  ops.push({ op: 'text', x: cx - textWidth(d.examName ?? 'Examination', 10, false) / 2, y, size: 10, bold: false, text: d.examName ?? 'Examination' });
  y -= 24;
  ops.push({ op: 'text', x: x0 + 16, y, size: 10, bold: false, text: `Candidate: ${clip(d.student.name, 10, false, 240)}` });
  ops.push({ op: 'text', x: x1 - 200, y, size: 10, bold: false, text: `Roll No: ${d.student.admissionNo}` });
  y -= 16;
  ops.push({ op: 'text', x: x0 + 16, y, size: 10, bold: false, text: `Class: ${d.academic.className}-${d.academic.section}` });
  ops.push({ op: 'text', x: x1 - 200, y, size: 10, bold: false, text: `Session: ${d.academic.academicYear}` });
  y -= 22;

  // Exam timetable table.
  const cols = [x0 + 16, x0 + 220, x0 + 340, x1 - 130];
  const heads = ['Date', 'Subject', 'Timing', 'Max Marks'];
  ops.push({ op: 'line', x1: x0 + 12, y1: y + 4, x2: x1 - 12, y2: y + 4 });
  heads.forEach((h, i) => ops.push({ op: 'text', x: cols[i], y, size: 9.5, bold: true, text: h }));
  y -= 17;
  for (const s of d.subjects ?? []) {
    ops.push({ op: 'text', x: cols[0], y, size: 9.5, bold: false, text: s.date });
    ops.push({ op: 'text', x: cols[1], y, size: 9.5, bold: false, text: clip(s.name, 9.5, false, 115) });
    ops.push({ op: 'text', x: cols[2], y, size: 9.5, bold: false, text: s.timing });
    ops.push({ op: 'text', x: cols[3], y, size: 9.5, bold: false, text: s.maxMarks ?? '-' });
    y -= 16;
  }
  ops.push({ op: 'line', x1: x0 + 12, y1: y + 6, x2: x1 - 12, y2: y + 6 });
  y -= 30;
  ops.push({ op: 'text', x: cx - textWidth('Candidate\'s Signature', 9, false) / 2, y: yBot + 30, size: 9, bold: false, text: "Candidate's Signature" });
  ops.push({ op: 'text', x: x1 - textWidth('Principal', 9, true) - 20, y: yBot + 30, size: 9, bold: true, text: 'Principal' });
  return assemblePdf(ops);
}

// ── 6. Transfer Certificate (CBSE-style ruled sheet) ──

export function renderTcPdf(d: CertPayload): Buffer {
  const ops: DrawOp[] = [];
  let y = header(ops, d, 'TRANSFER CERTIFICATE');
  y -= 10;
  let n = 1;
  y = row(ops, y, n++, "Pupil's Name", d.student.name);
  y = row(ops, y, n++, "Mother's Name", d.student.mother ?? '-');
  y = row(ops, y, n++, "Father's / Guardian's Name", d.student.father ?? '-');
  y = row(ops, y, n++, 'Nationality', 'Indian');
  y = row(ops, y, n++, 'Whether the candidate belongs to SC/ST/OBC', d.category ?? 'General');
  y = row(ops, y, n++, 'Date of first admission in the school', d.firstAdmission ?? '-');
  y = row(ops, y, n++, 'Date of Birth (Christian era)', d.student.dob);
  y = row(ops, y, n++, 'Date of issue of Transfer Certificate', d.issueDate);
  y = row(ops, y, n++, 'Class in which the pupil last studied', `${d.academic.className} (Section ${d.academic.section})`);
  y = row(ops, y, n++, 'School/Board Annual Examination last taken with result', d.lastExam ?? '-');
  y = row(ops, y, n++, 'Whether failed, if so, the class in which failed', 'Not applicable');
  y = row(ops, y, n++, 'Subjects studied', d.subjectsNames ?? '-');
  y = row(ops, y, n++, 'Fee concessions, if any', 'None');
  y = row(ops, y, n++, 'Total working days', String(d.attendance?.workingDays ?? 0));
  y = row(ops, y, n++, 'Total present days', String(d.attendance?.presentDays ?? 0));
  y = row(ops, y, n++, 'NCC cadet / Scouts / Guides', '-');
  y = row(ops, y, n++, 'Games played or extra co-curricular activities', '-');
  y = row(ops, y, n++, 'General conduct', d.conduct ?? 'Good');
  y = row(ops, y, n++, 'Date of application for certificate', d.applicationDate ?? '-');
  y = row(ops, y, n++, 'Any other remark', d.remarks ?? '-');
  y -= 6;
  signatureFooter(ops, y);
  return assemblePdf(ops);
}
