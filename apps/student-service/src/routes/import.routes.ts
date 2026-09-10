// ──────────────────────────────────────────────
// Bulk student import (BUILD_PLAN 3.2 — "your #1 sales unblocker")
//
// Dry-run first: upload → validate every row → per-row error report →
// commit. Two modes over the same endpoint, so the error report the admin
// sees in the preview is byte-identical to what the commit would produce.
//
// Excel columns (header row, case-insensitive, aliases allowed):
//   admissionNo* firstName* lastName* dateOfBirth* gender* class* section*
//   guardianName* guardianPhone* rollNo bloodGroup address phone
//   previousSchool guardianEmail
// (* = required)
//
// Section/class matching is case-insensitive on name. Rows are processed
// independently: one bad row never blocks the others. Commit matches on
// (branchId, admissionNo) — an existing student is updated, so re-running
// an import after fixing one row does not duplicate the others.
// ──────────────────────────────────────────────

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import * as XLSX from 'xlsx';
import type { PrismaClient } from '@school-erp/database';
import { ctx } from '@school-erp/auth';

const router = Router();

function prismaOf(req: Request): PrismaClient {
  return req.app.get('prisma') as PrismaClient;
}

function problem(res: Response, status: number, type: string, title: string, detail: string): void {
  res.status(status).type('application/problem+json').json({ type, title, status, detail });
}

const GENDERS = ['MALE', 'FEMALE', 'OTHER'] as const;

const rowSchema = z.object({
  admissionNo: z.string().min(1).max(40),
  firstName: z.string().min(1).max(60),
  lastName: z.string().min(1).max(60),
  dateOfBirth: z.coerce.date(),
  gender: z.enum(GENDERS),
  class: z.string().min(1).max(60),
  section: z.string().min(1).max(20),
  guardianName: z.string().min(1).max(120),
  guardianPhone: z.string().min(5).max(20),
  rollNo: z.string().max(10).optional().nullable(),
  bloodGroup: z.string().max(10).optional().nullable(),
  address: z.string().max(500).optional().nullable(),
  phone: z.string().max(20).optional().nullable(),
  previousSchool: z.string().max(200).optional().nullable(),
  guardianEmail: z.string().max(254).optional().nullable(),
});

type Row = z.infer<typeof rowSchema>;

/** Header aliases → canonical keys (case-insensitive match on upload). */
const HEADER_ALIASES: Record<string, string> = {
  'admissionno': 'admissionNo', 'admission no': 'admissionNo', 'admission_no': 'admissionNo', 'admno': 'admissionNo',
  'firstname': 'firstName', 'first name': 'firstName', 'first_name': 'firstName',
  'lastname': 'lastName', 'last name': 'lastName', 'last_name': 'lastName',
  'dateofbirth': 'dateOfBirth', 'date of birth': 'dateOfBirth', 'dob': 'dateOfBirth',
  'gender': 'gender', 'sex': 'gender',
  'class': 'class', 'grade': 'class',
  'section': 'section', 'sec': 'section',
  'guardianname': 'guardianName', 'guardian name': 'guardianName', 'parentname': 'guardianName', 'parent name': 'guardianName',
  'guardianphone': 'guardianPhone', 'guardian phone': 'guardianPhone', 'parentphone': 'guardianPhone', 'parent phone': 'guardianPhone', 'mobile': 'guardianPhone',
  'rollno': 'rollNo', 'roll no': 'rollNo', 'roll': 'rollNo',
  'bloodgroup': 'bloodGroup', 'blood group': 'bloodGroup',
  'address': 'address',
  'previousschool': 'previousSchool', 'previous school': 'previousSchool',
  'guardianemail': 'guardianEmail', 'guardian email': 'guardianEmail',
  'phone': 'phone', 'email': 'guardianEmail',
};

interface RowReport {
  row: number;
  admissionNo?: string;
  ok: boolean;
  errors: Array<{ field?: string; message: string }>;
}

interface ParsedWorkbook {
  rows: Row[];
  reports: RowReport[];
}

/** Read + schema-validate the spreadsheet into rows plus per-row reports. */
function parseWorkbook(buffer: Buffer): ParsedWorkbook {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) throw new Error('The file contains no worksheets.');
  const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '', raw: false });

  const reports: RowReport[] = [];
  const rows: Row[] = [];

  raw.forEach((r, idx) => {
    const rowNo = idx + 2; // 1-indexed sheet with a header row.
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) {
      const canon = HEADER_ALIASES[k.trim().toLowerCase()];
      if (canon) out[canon] = typeof v === 'string' ? v.trim() : v;
    }
    const check = rowSchema.safeParse(out);
    if (check.success) {
      rows.push(check.data);
      reports.push({ row: rowNo, admissionNo: check.data.admissionNo, ok: true, errors: [] });
    } else {
      reports.push({
        row: rowNo,
        admissionNo: typeof out.admissionNo === 'string' ? (out.admissionNo as string) : undefined,
        ok: false,
        errors: check.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
      });
    }
  });

  return { rows, reports };
}

/** Cross-row + database validation that mutates and returns the reports. */
async function validateRows(
  prisma: PrismaClient,
  branchId: string,
  rows: Row[],
  reports: RowReport[],
): Promise<RowReport[]> {
  const classes = await prisma.class.findMany({
    where: { branchId },
    include: { sections: true },
  });
  const year = await prisma.academicYear.findFirst({ where: { branchId, isCurrent: true } });
  if (!year) throw new Error('Branch has no current academic year — cannot import.');
  const currentClasses = classes.filter((c) => c.academicYearId === year.id);

  // Duplicate admission numbers WITHIN the file.
  const seen = new Map<string, number>();
  for (const report of reports) {
    if (!report.ok) continue;
    const row = rows.find((r) => r.admissionNo === report.admissionNo);
    if (!row) continue;
    const key = row.admissionNo.trim().toUpperCase();
    if (seen.has(key)) {
      report.ok = false;
      report.errors.push({ field: 'admissionNo', message: `Duplicate admission number in file (first seen on row ${seen.get(key)}).` });
    } else {
      seen.set(key, report.row);
    }
  }

  // One DB roundtrip for existing admission numbers.
  const numbers = [...new Set(rows.map((r) => r.admissionNo.trim().toUpperCase()))];
  const existing = numbers.length
    ? await prisma.student.findMany({ where: { branchId, admissionNo: { in: numbers } }, select: { admissionNo: true } })
    : [];
  const existingSet = new Set(existing.map((s) => s.admissionNo.toUpperCase()));

  for (const report of reports) {
    if (!report.ok) continue;
    const row = rows.find((r) => r.admissionNo === report.admissionNo);
    if (!row) continue;

    if (existingSet.has(row.admissionNo.trim().toUpperCase())) {
      report.errors.push({ message: 'Existing student — will be UPDATED on commit.' });
    }
    const cls = currentClasses.find((c) => c.name.toLowerCase() === row.class.trim().toLowerCase());
    if (!cls) {
      report.ok = false;
      report.errors.push({ field: 'class', message: `Class "${row.class}" not found for the current academic year.` });
      continue;
    }
    if (!cls.sections.some((s) => s.name.toLowerCase() === row.section.trim().toLowerCase())) {
      report.ok = false;
      report.errors.push({ field: 'section', message: `Section "${row.section}" not found in class "${row.class}".` });
    }
  }
  return reports;
}

router.post('/students/import', async (req: Request, res: Response) => {
  try {
    const { branchId, userId } = ctx(req);
    if (!branchId) { problem(res, 403, 'authorization-error', 'Forbidden', 'Account has no branch.'); return; }

    const mode = req.query.mode === 'commit' ? 'commit' : 'dry-run';
    const b64 = typeof req.body?.file === 'string' ? req.body.file : null;
    if (!b64) { problem(res, 400, 'validation-error', 'Invalid Input', 'Provide the spreadsheet as { "file": "<base64 xlsx>" }.'); return; }

    let parsed: ParsedWorkbook;
    try {
      parsed = parseWorkbook(Buffer.from(b64, 'base64'));
    } catch (e) {
      problem(res, 400, 'validation-error', 'Invalid Input', `Could not read spreadsheet: ${(e as Error).message}`);
      return;
    }
    let reports = parsed.reports;

    const prisma = prismaOf(req);
    try {
      reports = await validateRows(prisma, branchId, parsed.rows, reports);
    } catch (e) {
      problem(res, 400, 'validation-error', 'Invalid Input', (e as Error).message);
      return;
    }

    reports.sort((a, b) => a.row - b.row);

    if (mode === 'dry-run') {
      res.json({
        mode,
        summary: {
          total: reports.length,
          valid: reports.filter((r) => r.ok).length,
          invalid: reports.filter((r) => !r.ok).length,
        },
        rows: reports,
      });
      return;
    }

    // ── Commit mode: only rows that passed validation are written. ──
    const year = await prisma.academicYear.findFirst({ where: { branchId, isCurrent: true } });
    if (!year) { problem(res, 400, 'validation-error', 'Invalid Input', 'Branch has no current academic year.'); return; }
    const classes = await prisma.class.findMany({ where: { branchId, academicYearId: year.id }, include: { sections: true } });

    const committed: Array<{ row: number; admissionNo: string; studentId: string; action: 'created' | 'updated' }> = [];
    const failed: Array<{ row: number; admissionNo: string; message: string }> = [];

    for (const report of reports.filter((r) => r.ok)) {
      const row = parsed.rows.find((r) => r.admissionNo === report.admissionNo);
      if (!row) continue;
      try {
        const cls = classes.find((c) => c.name.toLowerCase() === row.class.trim().toLowerCase());
        const sec = cls?.sections.find((s) => s.name.toLowerCase() === row.section.trim().toLowerCase());
        if (!cls || !sec) throw new Error('class/section lookup failed');

        const existingStudent = await prisma.student.findUnique({
          where: { branchId_admissionNo: { branchId, admissionNo: row.admissionNo } },
          include: { enrollments: { where: { academicYearId: year.id } } },
        });

        if (existingStudent) {
          await prisma.student.update({
            where: { id: existingStudent.id },
            data: {
              firstName: row.firstName,
              lastName: row.lastName,
              bloodGroup: row.bloodGroup ?? undefined,
              phone: row.phone ?? undefined,
              address: row.address ?? undefined,
            },
          });
          // Ensure an enrollment for the current year exists.
          if (existingStudent.enrollments.length === 0) {
            await prisma.studentEnrollment.create({
              data: {
                studentId: existingStudent.id,
                academicYearId: year.id,
                branchId,
                classId: cls.id,
                sectionId: sec.id,
                rollNo: row.rollNo ?? undefined,
                status: 'ENROLLED',
                fromDate: new Date(),
                createdBy: userId,
              },
            });
          }
          committed.push({ row: report.row, admissionNo: row.admissionNo, studentId: existingStudent.id, action: 'updated' });
        } else {
          const user = await prisma.user.create({
            data: {
              // Branch-scoped placeholder email; the invite flow sets a
              // real one when the portal account is activated.
              email: `${branchId}-${row.admissionNo.toLowerCase()}@student.school-erp.local`,
              passwordHash: '$2b$12$not-a-real-bcrypt-hash',
              defaultBranchId: branchId,
              roleAssignments: { create: { roleId: 'sys_student', branchId } },
            },
            select: { id: true },
          });
          const student = await prisma.student.create({
            data: {
              userId: user.id,
              branchId,
              admissionNo: row.admissionNo,
              firstName: row.firstName,
              lastName: row.lastName,
              dateOfBirth: row.dateOfBirth,
              gender: row.gender,
              bloodGroup: row.bloodGroup ?? undefined,
              address: row.address ?? '',
              phone: row.phone ?? undefined,
              previousSchool: row.previousSchool ?? undefined,
              admissionDate: new Date(),
              guardians: {
                create: {
                  relation: 'FATHER' as never,
                  isPrimary: true,
                  guardian: {
                    create: { fullName: row.guardianName, phone: row.guardianPhone, email: row.guardianEmail ?? undefined },
                  },
                },
              },
              enrollments: {
                create: {
                  academicYearId: year.id,
                  branchId,
                  classId: cls.id,
                  sectionId: sec.id,
                  rollNo: row.rollNo ?? undefined,
                  status: 'ENROLLED',
                  fromDate: new Date(),
                  createdBy: userId,
                },
              },
            },
            select: { id: true },
          });
          committed.push({ row: report.row, admissionNo: row.admissionNo, studentId: student.id, action: 'created' });
        }
      } catch (e) {
        failed.push({ row: report.row, admissionNo: row?.admissionNo ?? '', message: (e as Error).message });
      }
    }

    res.json({
      mode,
      summary: { committed: committed.length, failed: failed.length, skippedInvalid: reports.filter((r) => !r.ok).length },
      committed,
      failed,
    });
  } catch (e) { problem(res, 500, 'internal-error', 'Server Error', (e as Error).message); }
});

export { router as importRoutes };
