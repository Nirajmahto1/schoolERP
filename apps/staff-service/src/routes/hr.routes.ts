// ──────────────────────────────────────────────
// HR Routes — staff records, leave workflow, payroll (BUILD_PLAN 3.7)
//
// Payroll is computed from the staff record (basic) plus declared
// allowances/deductions (PF/ESI/TDS fields live inside deductions for now),
// one row per staff per month, idempotent per (staffId, month, year).
// Leave approval is a state machine: PENDING → APPROVED/REJECTED, with the
// approver identity recorded.
// ──────────────────────────────────────────────

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { PrismaClient } from '@school-erp/database';
import { ctx } from '@school-erp/auth';
import multer from 'multer';
import {
  DocumentError,
  deleteDocumentByUrl,
  multerLimits,
  readDocumentByName,
  saveDocument,
} from '../documents';

export const hrRoutes = Router();

/** Memory storage: the content sniff decides acceptance, so the buffer must
 *  be in hand before anything touches disk. */
const documentUpload = multer({ storage: multer.memoryStorage(), limits: multerLimits });

function prismaOf(req: Request): PrismaClient {
  return req.app.get('prisma') as PrismaClient;
}

function problem(res: Response, status: number, type: string, title: string, detail: string): void {
  res.status(status).type('application/problem+json').json({ type, title, status, detail });
}

// ── Staff records ──

const staffSchema = z.object({
  employeeId: z.string().min(1).max(40),
  firstName: z.string().min(1).max(60),
  lastName: z.string().min(1).max(60),
  dateOfBirth: z.coerce.date(),
  gender: z.enum(['MALE', 'FEMALE', 'OTHER']),
  designation: z.string().min(1).max(80),
  department: z.string().min(1).max(80),
  qualification: z.string().max(200).optional().nullable(),
  experience: z.number().int().min(0).max(60).default(0),
  joinDate: z.coerce.date(),
  salary: z.number().nonnegative(),
  address: z.string().max(500),
  phone: z.string().min(5).max(20),
  email: z.string().email().optional().nullable(),
  // Portal password for the new staff account. Optional (defaults to
  // 'staff123' to match the UI's promise) but NEVER ignored — the account
  // must be able to log in the moment it is created.
  password: z.string().min(8).max(128).optional(),
});

/** Designation/department → role code. The HR form sends the job title the
 *  school uses (Teacher, Accountant, Principal, …); the account's platform
 *  role must match, or a finance officer logs in to a teacher's empty UI. */
function roleCodeForStaff(designation: string, department: string): string {
  const key = `${designation} ${department}`.toLowerCase();
  if (/(principal|head.master|director)/.test(key)) return 'sys_principal';
  if (/(accountant|accounts)/.test(key)) return 'sys_accountant';
  if (/(finance|treasurer)/.test(key)) return 'sys_finance';
  if (/(librarian|library)/.test(key)) return 'sys_librarian';
  if (/(transport|driver|conductor)/.test(key)) return 'sys_transport_manager';
  if (/(admin|administrator|office|clerk|reception)/.test(key)) return 'sys_branch_admin';
  return 'sys_teacher';
}

hrRoutes.get('/', async (req: Request, res: Response) => {
  try {
    const { branchId } = ctx(req);
    if (!branchId) { problem(res, 403, 'authorization-error', 'Forbidden', 'Account has no branch.'); return; }
    const { department, q, isActive } = req.query;
    const where: Record<string, unknown> = { branchId, deletedAt: null };
    if (department) where.department = department;
    if (isActive !== undefined) where.isActive = isActive === 'true';
    if (q) where.OR = [
      { firstName: { contains: q as string, mode: 'insensitive' } },
      { lastName: { contains: q as string, mode: 'insensitive' } },
      { employeeId: { contains: q as string } },
    ];
    const staff = await prismaOf(req).staff.findMany({
      where,
      select: {
        id: true, employeeId: true, firstName: true, lastName: true, designation: true,
        department: true, joinDate: true, phone: true, isActive: true, photo: true,
      },
      orderBy: { employeeId: 'asc' },
    });
    res.json({ data: staff });
  } catch (e) { problem(res, 500, 'internal-error', 'Server Error', (e as Error).message); }
});

// NOTE: static paths (/payroll, /leaves) MUST be registered before /:id —
// Express matches in registration order, and "payroll"/"leaves" would otherwise
// be swallowed as an :id (observed: GET /hr/payroll → 404 "Staff member not found").
hrRoutes.get('/leaves', async (req: Request, res: Response) => {
  try {
    const { branchId } = ctx(req);
    if (!branchId) { problem(res, 403, 'authorization-error', 'Forbidden', 'Account has no branch.'); return; }
    const { status } = req.query;
    const leaves = await prismaOf(req).leaveRequest.findMany({
      where: { staff: { branchId }, ...(status && { status: status as never }) },
      include: { staff: { select: { employeeId: true, firstName: true, lastName: true, designation: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    res.json({ data: leaves });
  } catch (e) { problem(res, 500, 'internal-error', 'Server Error', (e as Error).message); }
});

hrRoutes.get('/payroll', async (req: Request, res: Response) => {
  try {
    const { branchId } = ctx(req);
    if (!branchId) { problem(res, 403, 'authorization-error', 'Forbidden', 'Account has no branch.'); return; }
    const { month, year } = req.query;
    const rows = await prismaOf(req).payroll.findMany({
      where: {
        staff: { branchId },
        ...(month && { month: parseInt(month as string) }),
        ...(year && { year: parseInt(year as string) }),
      },
      include: { staff: { select: { employeeId: true, firstName: true, lastName: true, designation: true } } },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    res.json({ data: rows });
  } catch (e) { problem(res, 500, 'internal-error', 'Server Error', (e as Error).message); }
});

hrRoutes.get('/:id', async (req: Request, res: Response) => {
  try {
    const { branchId } = ctx(req);
    if (!branchId) { problem(res, 403, 'authorization-error', 'Forbidden', 'Account has no branch.'); return; }
    const staff = await prismaOf(req).staff.findFirst({
      where: { id: req.params.id, branchId, deletedAt: null },
      include: {
        branchAssignments: { include: { branch: { select: { name: true, code: true } } } },
        leaveRequests: { orderBy: { createdAt: 'desc' }, take: 10 },
        payrolls: { orderBy: [{ year: 'desc' }, { month: 'desc' }], take: 12 },
      },
    });
    if (!staff) { problem(res, 404, 'not-found', 'Not Found', 'Staff member not found.'); return; }
    res.json({ data: staff });
  } catch (e) { problem(res, 500, 'internal-error', 'Server Error', (e as Error).message); }
});

hrRoutes.post('/', async (req: Request, res: Response) => {
  try {
    const { branchId, userId } = ctx(req);
    if (!branchId) { problem(res, 403, 'authorization-error', 'Forbidden', 'Account has no branch.'); return; }
    const data = staffSchema.parse(req.body);

    const staff = await prismaOf(req).$transaction(async (tx) => {
      // Hash the actually-provided password — the account must be usable at
      // once. (This used to write a literal fake bcrypt hash, which is why
      // newly created staff could never log in.)
      const bcrypt = await import('bcryptjs');
      const passwordHash = await bcrypt.hash(data.password || 'staff123', 12);
      const user = await tx.user.create({
        data: {
          email: data.email ?? `${branchId}-${data.employeeId.toLowerCase()}@staff.school-erp.local`,
          passwordHash,
          defaultBranchId: branchId,
          roleAssignments: { create: { roleId: roleCodeForStaff(data.designation, data.department), branchId } },
        },
        select: { id: true },
      });
      return tx.staff.create({
        data: {
          userId: user.id,
          branchId,
          employeeId: data.employeeId,
          firstName: data.firstName,
          lastName: data.lastName,
          dateOfBirth: data.dateOfBirth,
          gender: data.gender,
          designation: data.designation,
          department: data.department,
          qualification: data.qualification ?? '',
          experience: data.experience,
          joinDate: data.joinDate,
          salary: data.salary,
          address: data.address,
          phone: data.phone,
          branchAssignments: { create: { branchId, isPrimary: true } },
        },
        select: { id: true, employeeId: true, firstName: true, lastName: true },
      });
    });
    res.status(201).json(staff);
  } catch (e: unknown) {
    const code = (e as { code?: string }).code;
    if (code === 'P2002') { problem(res, 409, 'conflict', 'Conflict', 'Employee ID already exists in this branch.'); return; }
    if (e instanceof z.ZodError) { problem(res, 400, 'validation-error', 'Invalid Input', e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')); return; }
    problem(res, 500, 'internal-error', 'Server Error', (e as Error).message);
  }
});

// ── Identity documents (Aadhaar etc.) ──
// KYC files: upload is multipart, content is sniffed (not trusted), storage is
// server-named + checksummed, and every download writes an access log.

hrRoutes.post('/:id/documents', documentUpload.single('file'), async (req: Request, res: Response) => {
  try {
    const { branchId, userId } = ctx(req);
    if (!branchId) { problem(res, 403, 'authorization-error', 'Forbidden', 'Account has no branch.'); return; }
    const staff = await prismaOf(req).staff.findFirst({ where: { id: req.params.id, branchId, deletedAt: null } });
    if (!staff) { problem(res, 404, 'not-found', 'Not Found', 'Staff member not found.'); return; }
    if (!req.file) { problem(res, 400, 'validation-error', 'Invalid Input', 'Attach the document as the "file" form field.'); return; }

    const docType = ['AADHAAR', 'BIRTH_CERTIFICATE', 'TC', 'CASTE_CERTIFICATE'].includes(String(req.body?.type))
      ? String(req.body.type)
      : 'AADHAAR';
    const title = String(req.body?.title ?? `${docType} — ${staff.firstName} ${staff.lastName}`).slice(0, 120);

    const saved = await saveDocument(req.file.buffer);
    const doc = await prismaOf(req).document.create({
      data: {
        staffId: staff.id,
        type: docType as never,
        title,
        s3Key: saved.url,
        checksum: saved.checksum,
        mimeType: saved.mimeType,
        sizeBytes: saved.sizeBytes,
        uploadedBy: userId,
      },
      select: { id: true, type: true, title: true, s3Key: true, mimeType: true, sizeBytes: true, createdAt: true },
    });
    res.status(201).json(doc);
  } catch (e: unknown) {
    if (e instanceof DocumentError) { problem(res, e.status, e.code, 'Document Rejected', e.message); return; }
    problem(res, 500, 'internal-error', 'Server Error', (e as Error).message);
  }
});

hrRoutes.get('/:id/documents', async (req: Request, res: Response) => {
  try {
    const { branchId } = ctx(req);
    if (!branchId) { problem(res, 403, 'authorization-error', 'Forbidden', 'Account has no branch.'); return; }
    const staff = await prismaOf(req).staff.findFirst({ where: { id: req.params.id, branchId, deletedAt: null } });
    if (!staff) { problem(res, 404, 'not-found', 'Not Found', 'Staff member not found.'); return; }
    const docs = await prismaOf(req).document.findMany({
      where: { staffId: staff.id, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { id: true, type: true, title: true, s3Key: true, mimeType: true, sizeBytes: true, isVerified: true, createdAt: true },
    });
    res.json({ data: docs });
  } catch (e) { problem(res, 500, 'internal-error', 'Server Error', (e as Error).message); }
});

// ── Leave workflow ──

hrRoutes.post('/leaves/:id/decision', async (req: Request, res: Response) => {
  try {
    const { branchId, userId } = ctx(req);
    if (!branchId) { problem(res, 403, 'authorization-error', 'Forbidden', 'Account has no branch.'); return; }
    const { status } = req.body ?? {};
    if (!['APPROVED', 'REJECTED', 'CANCELLED'].includes(status)) {
      problem(res, 400, 'validation-error', 'Invalid Input', 'status must be APPROVED, REJECTED or CANCELLED.');
      return;
    }
    const leave = await prismaOf(req).leaveRequest.findFirst({ where: { id: req.params.id, staff: { branchId } } });
    if (!leave) { problem(res, 404, 'not-found', 'Not Found', 'Leave request not found.'); return; }
    if (leave.status !== 'PENDING') { problem(res, 409, 'conflict', 'Conflict', 'Leave was already decided.'); return; }

    const updated = await prismaOf(req).leaveRequest.update({
      where: { id: leave.id },
      data: { status, approvedBy: userId },
    });
    res.json(updated);
  } catch (e) { problem(res, 500, 'internal-error', 'Server Error', (e as Error).message); }
});

// ── Payroll (3.7) ──

const payrollRunSchema = z.object({
  month: z.number().int().min(1).max(12),
  year: z.number().int().min(2000).max(2100),
  allowances: z.number().nonnegative().default(0),
  deductions: z.number().nonnegative().default(0),
});

hrRoutes.post('/payroll/run', async (req: Request, res: Response) => {
  try {
    const { branchId, userId } = ctx(req);
    if (!branchId) { problem(res, 403, 'authorization-error', 'Forbidden', 'Account has no branch.'); return; }
    const { month, year, allowances, deductions } = payrollRunSchema.parse(req.body);

    const staff = await prismaOf(req).staff.findMany({ where: { branchId, isActive: true, deletedAt: null } });

    // Idempotent per (staff, month, year) via upsert — re-running a payroll
    // month corrects nothing and duplicates nothing.
    const processed: Array<{ staffId: string; employeeId: string; netSalary: number }> = [];
    for (const s of staff) {
      const basic = Number(s.salary);
      const net = basic + allowances - deductions;
      const row = await prismaOf(req).payroll.upsert({
        where: { staffId_month_year: { staffId: s.id, month, year } },
        create: { staffId: s.id, month, year, basicSalary: basic, allowances, deductions, netSalary: net, status: 'PENDING' },
        update: { basicSalary: basic, allowances, deductions, netSalary: net },
      });
      processed.push({ staffId: s.id, employeeId: s.employeeId, netSalary: Number(row.netSalary) });
    }
    res.status(201).json({ month, year, staffCount: processed.length, totalNet: processed.reduce((sum, p) => sum + p.netSalary, 0), processed, runBy: userId });
  } catch (e) {
    if (e instanceof z.ZodError) { problem(res, 400, 'validation-error', 'Invalid Input', e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')); return; }
    problem(res, 500, 'internal-error', 'Server Error', (e as Error).message);
  }
});

hrRoutes.post('/payroll/:id/pay', async (req: Request, res: Response) => {
  try {
    const { branchId, userId } = ctx(req);
    if (!branchId) { problem(res, 403, 'authorization-error', 'Forbidden', 'Account has no branch.'); return; }
    const row = await prismaOf(req).payroll.findFirst({ where: { id: req.params.id, staff: { branchId } } });
    if (!row) { problem(res, 404, 'not-found', 'Not Found', 'Payroll row not found.'); return; }
    if (row.status === 'PAID') { problem(res, 409, 'conflict', 'Conflict', 'Already paid.'); return; }
    const updated = await prismaOf(req).payroll.update({
      where: { id: row.id },
      data: { status: 'PAID', paidOn: new Date() },
    });
    res.json(updated);
    void userId;
  } catch (e) { problem(res, 500, 'internal-error', 'Server Error', (e as Error).message); }
});
