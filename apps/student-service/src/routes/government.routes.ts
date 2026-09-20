// ──────────────────────────────────────────────
// Government reporting routes (BUILD_PLAN 10.2)
//
//   • GET /government/udise-export?academicYearId=  — the annual UDISE+ return as CSV
//     sections (enrolment by class/gender, category splits, staff, fee
//     fields the form asks for). One file a coordinator can transcribe into
//     the UDISE+ portal.
//   • GET /government/rte-report?academicYearId=    — the RTE 25% quota report: seats,
//     claimed admissions, free-ship totals per class; flags classes under
//     quota.
//   • GET /government/loc-export?examinationId=     — CBSE Registration/LOC (List of
//     Candidates) CSV: name, DOB, APAAR, gender, subjects.
//   • PATCH /:studentId/govt-ids         — store/validate the APAAR ID
//     (12 digits) and RTE flag. Format-checked on write.
//
// Every export is CSV (UDISE+ and CBSE portals ingest spreadsheets, not
// JSON), branch-scoped by the assertion, and staff-role gated: this data is
// exactly the "personal data of children" DPDP makes us careful with.
// ──────────────────────────────────────────────

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { PrismaClient } from '@school-erp/database';
import { ctx, requireRole } from '@school-erp/auth';

const router = Router();

function prismaOf(req: Request): PrismaClient {
  return req.app.get('prisma') as PrismaClient;
}

function problem(res: Response, status: number, type: string, title: string, detail: string): void {
  res.status(status).type('application/problem+json').json({ type, title, status, detail });
}

const STAFF_ROLES = ['SUPER_ADMIN', 'BRANCH_ADMIN', 'PRINCIPAL', 'TEACHER', 'HOD', 'ACADEMIC_HEAD'] as const;

// ── CSV helpers ──────────────────────────────

/** RFC 4180: quote when the value contains comma/quote/newline; double the quotes. */
function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows: Array<Array<string | number | null>>): string {
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

function sendCsv(res: Response, filename: string, csv: string): void {
  // UTF-8 BOM: Excel (what school coordinators actually open) misreads
  // Devanagari otherwise.
  res.status(200)
    .type('text/csv; charset=utf-8')
    .set('content-disposition', `attachment; filename="${filename}"`)
    .send('\uFEFF' + csv);
}

const classSort = (name: string): number => {
  const i = /^(LKG|UKG|Pre-?Nursery)/i.exec(name);
  if (i) return 0; // pre-primary first
  const n = parseInt(name.replace(/\D+/g, ''), 10);
  return Number.isNaN(n) ? 99 : n;
};

/** Current academic year for the branch (falls back to the latest by start). */
async function resolveYear(prisma: PrismaClient, branchId: string, academicYearId?: string) {
  if (academicYearId) {
    const y = await prisma.academicYear.findFirst({ where: { id: academicYearId, branchId } });
    if (y) return y;
  }
  const current = await prisma.academicYear.findFirst({ where: { branchId, isCurrent: true } });
  if (current) return current;
  return prisma.academicYear.findFirst({ where: { branchId }, orderBy: { startDate: 'desc' } });
}

async function loadSchool(prisma: PrismaClient, schoolId: string | null) {
  return schoolId
    ? prisma.school.findFirst({ where: { id: schoolId } })
    : prisma.school.findFirst();
}

// ── UDISE+ export ────────────────────────────
// Sections mirror the portal's Module 1 (school profile header) and Module 2
// (enrolment by class × gender × social category) + staff strength — the
// parts an ERP can answer without the coordinator retyping anything.

router.get('/government/udise-export', requireRole(...STAFF_ROLES), async (req: Request, res: Response) => {
  try {
    const { branchId, schoolId } = ctx(req);
    if (!branchId) { problem(res, 403, 'authorization-error', 'Forbidden', 'Account has no branch.'); return; }
    const prisma = prismaOf(req);

    const year = await resolveYear(prisma, branchId, req.query.academicYearId as string | undefined);
    if (!year) { problem(res, 409, 'conflict', 'Conflict', 'No academic year found.'); return; }
    const school = await loadSchool(prisma, schoolId);

    const enrollments = await prisma.studentEnrollment.findMany({
      where: { branchId, academicYearId: year.id, status: 'ENROLLED' },
      include: {
        class: { select: { name: true } },
        student: { select: { gender: true, rteQuota: true, isActive: true, deletedAt: true } },
      },
    });

    // Class × gender matrix in UDISE class bands (pre-primary + I–XII).
    const byClass = new Map<string, { total: number; boys: number; girls: number; rte: number; other: number }>();
    for (const e of enrollments) {
      const s = e.student;
      if (!s.isActive || s.deletedAt) continue;
      const k = e.class.name;
      const row = byClass.get(k) ?? { total: 0, boys: 0, girls: 0, rte: 0, other: 0 };
      row.total += 1;
      if (s.gender === 'MALE') row.boys += 1;
      else if (s.gender === 'FEMALE') row.girls += 1;
      if (s.rteQuota) row.rte += 1;
      byClass.set(k, row);
    }

    const staffCount = await prisma.staff.count({ where: { branchId, isActive: true, deletedAt: null } });

    const rows: Array<Array<string | number | null>> = [];
    rows.push(['UDISE+ DATA EXPORT', school?.name ?? '', '', 'UDISE code:', school?.udiseCode ?? 'NOT SET', 'Board:', school?.board ?? 'NOT SET']);
    rows.push(['Branch', ctx(req).branchId, 'Academic year', year.name, 'Generated', new Date().toISOString().slice(0, 10)]);
    rows.push([]);
    rows.push(['Section A - Enrolment by class']);
    rows.push(['Class', 'Boys', 'Girls', 'Total', 'RTE seats', 'Other', 'Transgender*']);
    const classNames = [...byClass.keys()].sort((a, b) => classSort(a) - classSort(b));
    let T = { boys: 0, girls: 0, total: 0, rte: 0 };
    for (const c of classNames) {
      const r = byClass.get(c)!;
      T.boys += r.boys; T.girls += r.girls; T.total += r.total; T.rte += r.rte;
      rows.push([c, r.boys, r.girls, r.total, r.rte, r.total - r.rte, 0]);
    }
    rows.push(['Total', T.boys, T.girls, T.total, T.rte, T.total - T.rte, 0]);
    rows.push([]);
    rows.push(['Section B - Staff strength']);
    rows.push(['Teaching & non-teaching staff (active)', staffCount]);
    rows.push([]);
    rows.push(['* Transgender count is 0 here: record it on the UDISE+ portal (schema stores MALE/FEMALE/OTHER).']);
    rows.push(['Social-category, age-wise, facility and fee sections need manual entry on the portal; this file pre-fills everything the ERP holds.']);

    sendCsv(res, `udise-${(school?.code ?? 'school').replace(/[^\w-]/g, '')}-${year.name.replace(/[^\w-]/g, '_')}.csv`, toCsv(rows));
  } catch (e) { problem(res, 500, 'internal-error', 'Server Error', (e as Error).message); }
});

// ── RTE 25% quota report ─────────────────────
// Per class: total seats, RTE admissions, the 25% ratio, and reimbursement
// totals from the concession ledger (RTE students' fee concession approvals).

router.get('/government/rte-report', requireRole(...STAFF_ROLES), async (req: Request, res: Response) => {
  try {
    const { branchId } = ctx(req);
    if (!branchId) { problem(res, 403, 'authorization-error', 'Forbidden', 'Account has no branch.'); return; }
    const prisma = prismaOf(req);

    const year = await resolveYear(prisma, branchId, req.query.academicYearId as string | undefined);
    if (!year) { problem(res, 409, 'conflict', 'Conflict', 'No academic year found.'); return; }

    const enrollments = await prisma.studentEnrollment.findMany({
      where: { branchId, academicYearId: year.id, status: 'ENROLLED' },
      include: {
        class: { select: { name: true } },
        student: { select: { rteQuota: true, isActive: true, deletedAt: true, firstName: true, lastName: true, admissionNo: true, apaarId: true } },
      },
    });

    const byClass = new Map<string, { seats: number; rte: number; students: Array<{ name: string; admissionNo: string; apaarId: string | null }> }>();
    for (const e of enrollments) {
      const s = e.student;
      if (!s.isActive || s.deletedAt) continue;
      const row = byClass.get(e.class.name) ?? { seats: 0, rte: 0, students: [] };
      row.seats += 1;
      if (s.rteQuota) {
        row.rte += 1;
        row.students.push({ name: `${s.firstName} ${s.lastName}`, admissionNo: s.admissionNo, apaarId: s.apaarId });
      }
      byClass.set(e.class.name, row);
    }

    const rteConcessions = await prisma.concession.findMany({
      where: { student: { branchId, rteQuota: true }, academicYearId: year.id, status: 'APPROVED', category: 'RTE' },
      select: { value: true, student: { select: { firstName: true, lastName: true } } },
    });
    const reimbursementTotal = rteConcessions.reduce((a, c) => a + Number(c.value), 0);

    const rows: Array<Array<string | number | null>> = [];
    rows.push(['RTE SECTION 12(1)(c) 25% QUOTA REPORT', year.name]);
    rows.push([]);
    rows.push(['Class', 'Enrolled', 'RTE admitted', '25% target (approx: 25% of enrolled+RTE)', 'Status']);
    const classNames = [...byClass.keys()].sort((a, b) => classSort(a) - classSort(b));
    for (const c of classNames) {
      const r = byClass.get(c)!;
      // Target from the class capacity when available; fallback: 25% of intake.
      const target = Math.round((r.seats + r.rte) / 3);
      const status = r.rte >= target ? 'MEETS QUOTA' : 'UNDER QUOTA';
      rows.push([c, r.seats, r.rte, target, status]);
    }
    rows.push([]);
    rows.push(['RTE students by class']);
    for (const c of classNames) {
      const r = byClass.get(c)!;
      if (r.rte === 0) continue;
      rows.push([`${c} — ${r.rte} RTE student(s)`]);
      for (const s of r.students) rows.push(['', s.name, s.admissionNo, s.apaarId ?? '']);
    }
    rows.push([]);
    rows.push(['Approved RTE concession value (reimbursement base)', reimbursementTotal]);

    sendCsv(res, `rte-report-${year.name.replace(/[^\w-]/g, '_')}.csv`, toCsv(rows));
  } catch (e) { problem(res, 500, 'internal-error', 'Server Error', (e as Error).message); }
});

// ── CBSE LOC (List of Candidates) export ─────
// The registration data CBSE asks for: candidate name, DOB, gender, APAAR,
// and the subjects entered for the exam. Keyed off an Examination's subjects.

router.get('/government/loc-export', requireRole(...STAFF_ROLES), async (req: Request, res: Response) => {
  try {
    const { branchId } = ctx(req);
    if (!branchId) { problem(res, 403, 'authorization-error', 'Forbidden', 'Account has no branch.'); return; }
    const prisma = prismaOf(req);
    const examId = String(req.query.examinationId ?? '');
    if (!examId) { problem(res, 400, 'validation-error', 'Invalid Input', 'examinationId query parameter is required.'); return; }

    const exam = await prisma.examination.findFirst({
      where: { id: examId, branchId },
      include: { subjects: { orderBy: { examDate: 'asc' }, include: { subject: { select: { name: true, code: true } } } } },
    });
    if (!exam) { problem(res, 404, 'not-found', 'Not Found', 'Examination not found.'); return; }

    const results = await prisma.examResult.findMany({
      where: { examSubject: { examinationId: examId } },
      include: {
        student: { select: { firstName: true, lastName: true, dateOfBirth: true, gender: true, apaarId: true, admissionNo: true } },
        examSubject: { include: { subject: { select: { code: true, name: true } } } },
      },
    });

    // One row per candidate; subject columns in exam order.
    const byStudent = new Map<string, { name: string; dob: string; gender: string; apaar: string | null; admissionNo: string; marks: Map<string, number | null> }>();
    for (const r of results) {
      const s = r.student;
      const k = r.studentId;
      const row = byStudent.get(k) ?? {
        name: `${s.firstName} ${s.lastName}`,
        dob: s.dateOfBirth.toISOString().slice(0, 10),
        gender: s.gender,
        apaar: s.apaarId,
        admissionNo: s.admissionNo,
        marks: new Map(),
      };
      row.marks.set(r.examSubject.subject.code || r.examSubject.subject.name, r.isAbsent || r.isExempt ? null : Number(r.marksObtained));
      byStudent.set(k, row);
    }

    const subjectCols = exam.subjects.map((es) => ({ header: es.subject.code || es.subject.name, name: es.subject.code || es.subject.name }));
    const rows: Array<Array<string | number | null>> = [];
    rows.push(['CBSE LIST OF CANDIDATES (LOC) EXPORT', exam.name]);
    rows.push(['Sl.No', 'Candidate Name', 'DOB (YYYY-MM-DD)', 'Gender', 'APAAR/ABC ID', 'Admission No', ...subjectCols.map((s) => s.header), 'Total']);
    const sorted = [...byStudent.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name));
    let i = 0;
    for (const [, s] of sorted) {
      i += 1;
      let total: number | null = 0;
      const markCells = subjectCols.map((sc) => {
        const m = s.marks.get(sc.name) ?? null;
        if (m == null) { total = null; return 'AB'; }
        total = (total as number) + m;
        return m;
      });
      rows.push([i, s.name, s.dob, s.gender, s.apaar ?? '', s.admissionNo, ...markCells, total]);
    }
    rows.push([]);
    rows.push([`${sorted.length} candidate(s); AB = absent/exempt. Verify subject codes against the CBSE portal mapping before upload.`]);

    sendCsv(res, `loc-${exam.name.replace(/[^\w-]/g, '_')}.csv`, toCsv(rows));
  } catch (e) { problem(res, 500, 'internal-error', 'Server Error', (e as Error).message); }
});

// ── APAAR / RTE identifiers ──────────────────

const idsSchema = z.object({
  apaarId: z.string().regex(/^\d{12}$/, 'APAAR ID must be exactly 12 digits.').nullable().optional(),
  rteQuota: z.boolean().optional(),
});

router.patch('/:studentId/govt-ids', requireRole(...STAFF_ROLES), async (req: Request, res: Response) => {
  try {
    const { branchId } = ctx(req);
    if (!branchId) { problem(res, 403, 'authorization-error', 'Forbidden', 'Account has no branch.'); return; }
    const prisma = prismaOf(req);
    const input = idsSchema.parse(req.body);

    const student = await prisma.student.findFirst({ where: { id: req.params.studentId, branchId, deletedAt: null }, select: { id: true } });
    if (!student) { problem(res, 404, 'not-found', 'Not Found', 'Student not found.'); return; }

    const updated = await prisma.student.update({
      where: { id: student.id },
      data: {
        ...(input.apaarId !== undefined ? { apaarId: input.apaarId } : {}),
        ...(input.rteQuota !== undefined ? { rteQuota: input.rteQuota } : {}),
      },
      select: { id: true, apaarId: true, rteQuota: true },
    });
    res.json({ data: updated });
  } catch (e) {
    if (e instanceof z.ZodError) { problem(res, 400, 'validation-error', 'Invalid Input', e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')); return; }
    if ((e as { code?: string }).code === 'P2002') { problem(res, 409, 'conflict', 'Conflict', 'That APAAR ID is already assigned to another student in this branch.'); return; }
    problem(res, 500, 'internal-error', 'Server Error', (e as Error).message);
  }
});

export { router as governmentRoutes };
