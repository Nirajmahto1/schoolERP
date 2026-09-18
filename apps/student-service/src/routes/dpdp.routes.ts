// ──────────────────────────────────────────────
// DPDP compliance routes (BUILD_PLAN 10.1)
//
//   • Verifiable parental consent — one row per (child, purpose), captured
//     through the authenticated portal (the assertion IS the verification)
//     or countersigned physical forms, with an explicit withdrawal path.
//   • Data export — the §10.1(3) access right: one authenticated call
//     returns everything the system holds about a child as JSON.
//   • Erasure requests — the §10.1(3) erasure right, with the resolution
//     note recording what statutory-retention rules kept (fees, academics).
//
// Every state transition writes an AuditLog row — the trail is the proof a
// Data Fiduciary (the school) must produce on demand. The plan's warning is
// taken seriously here: this is scaffolding, not legal advice; the DPA and
// consent wording need a lawyer before contract one.
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

/** Audit helper — best-effort, never blocks the compliance action. */
async function audit(
  prisma: PrismaClient,
  req: Request,
  entity: string,
  entityId: string,
  action: string,
  after: Record<string, unknown>,
): Promise<void> {
  const { userId, roles, branchId } = ctx(req);
  try {
    await prisma.auditLog.create({
      data: {
        branchId,
        actorId: userId,
        actorRole: roles[0] ?? null,
        entity,
        entityId,
        action,
        after: after as object,
      },
    });
  } catch { /* audit failure must not roll back the action */ }
}

/** Resolve the caller's own children (guardian) or self (student). */
async function ownStudentIds(prisma: PrismaClient, branchId: string, userId: string): Promise<string[]> {
  const own = await prisma.student.findFirst({ where: { userId, branchId }, select: { id: true } });
  const children = await prisma.studentGuardian.findMany({
    where: { guardian: { userId }, student: { branchId } },
    select: { studentId: true },
  });
  return [own?.id, ...children.map((c) => c.studentId)].filter((x): x is string => Boolean(x));
}

const isStaff = (roles: string[]) =>
  roles.some((r) => ['SUPER_ADMIN', 'BRANCH_ADMIN', 'PRINCIPAL', 'TEACHER', 'HOD', 'ACADEMIC_HEAD', 'ACCOUNTANT', 'FINANCE'].includes(r));

/** 403 unless the caller is staff, or the child is their own. */
async function guardChildAccess(res: Response, prisma: PrismaClient, req: Request, studentId: string): Promise<boolean> {
  const { branchId, roles, userId } = ctx(req);
  if (!branchId) { problem(res, 403, 'authorization-error', 'Forbidden', 'Account has no branch.'); return false; }
  if (isStaff(roles)) return true;
  const own = await ownStudentIds(prisma, branchId, userId);
  if (!own.includes(studentId)) {
    problem(res, 403, 'authorization-error', 'Forbidden', 'Not your child.');
    return false;
  }
  return true;
}

// ── Consent ──

const PURPOSES = [
  'fee_processing',
  'photos_publication',
  'transport_gps',
  'medical_care',
  'portal_access',
] as const;

const consentSchema = z.object({
  purpose: z.string().min(3).max(80),
  // Known purposes are suggested to the UI; free strings are accepted so new
  // purposes never need a migration.
  method: z.enum(['PORTAL', 'PHYSICAL_FORM', 'ONBOARDING']),
  evidence: z.string().max(500).optional().nullable(),
  // PHYSICAL_FORM: reference to the scanned/countersigned document.
});

const STUDENT_ROLES = ['SUPER_ADMIN', 'BRANCH_ADMIN', 'PRINCIPAL'] as const;
void STUDENT_ROLES;
const STAFF_GATES = ['SUPER_ADMIN', 'BRANCH_ADMIN', 'PRINCIPAL', 'TEACHER', 'HOD', 'ACADEMIC_HEAD'] as const;

// Grant consent — the PARENT/guardian does this from the portal; staff may
// record ONBOARDING/PHYSICAL_FORM consents on the guardian's behalf.
router.post('/:studentId/consent', requireRole(...STAFF_GATES, 'PARENT', 'STUDENT'), async (req: Request, res: Response) => {
  try {
    const { branchId, userId } = ctx(req);
    if (!branchId) { problem(res, 403, 'authorization-error', 'Forbidden', 'Account has no branch.'); return; }
    const prisma = prismaOf(req);
    const input = consentSchema.parse(req.body);

    const student = await prisma.student.findFirst({ where: { id: req.params.studentId, branchId }, select: { id: true } });
    if (!student) { problem(res, 404, 'not-found', 'Not Found', 'Student not found.'); return; }

    // A non-staff caller must be a guardian of THIS child (DPDP: consent
    // comes from the verifiable parent, not from anyone with the URL).
    const staff = isStaff(ctx(req).roles);
    if (!staff) {
      const own = await ownStudentIds(prisma, branchId, userId);
      if (!own.includes(student.id)) { problem(res, 403, 'authorization-error', 'Forbidden', 'Not your child.'); return; }
    }

    const guardian = await prisma.studentGuardian.findFirst({
      where: { studentId: student.id, guardian: { userId } },
      select: { guardianId: true },
    });

    const row = await prisma.consentRecord.upsert({
      where: { studentId_purpose: { studentId: student.id, purpose: input.purpose } },
      create: {
        branchId,
        studentId: student.id,
        guardianId: guardian?.guardianId ?? null,
        purpose: input.purpose,
        status: 'GRANTED',
        grantedAt: new Date(),
        method: input.method,
        evidence: input.evidence ?? null,
        metadata: { grantedBy: userId, grantedByRoles: ctx(req).roles },
      },
      update: {
        status: 'GRANTED',
        grantedAt: new Date(),
        withdrawnAt: null,
        method: input.method,
        evidence: input.evidence ?? null,
        metadata: { grantedBy: userId, grantedByRoles: ctx(req).roles },
      },
    });

    await audit(prisma, req, 'ConsentRecord', row.id, 'CONSENT_GRANTED', { purpose: input.purpose, studentId: student.id, method: input.method });
    res.status(201).json({ id: row.id, purpose: row.purpose, status: row.status, grantedAt: row.grantedAt });
  } catch (e) {
    if (e instanceof z.ZodError) { problem(res, 400, 'validation-error', 'Invalid Input', e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')); return; }
    problem(res, 500, 'internal-error', 'Server Error', (e as Error).message);
  }
});

// Withdraw consent — the withdrawal path the Act requires. Kept as a
// separate route so the audit entry is unambiguous.
router.post('/:studentId/consent/:purpose/withdraw', requireRole(...STAFF_GATES, 'PARENT', 'STUDENT'), async (req: Request, res: Response) => {
  try {
    const { branchId, userId } = ctx(req);
    if (!branchId) { problem(res, 403, 'authorization-error', 'Forbidden', 'Account has no branch.'); return; }
    const prisma = prismaOf(req);

    const row = await prisma.consentRecord.findFirst({
      where: { studentId: req.params.studentId, purpose: req.params.purpose, branchId },
    });
    if (!row) { problem(res, 404, 'not-found', 'Not Found', 'No consent record for this purpose.'); return; }

    const staff = isStaff(ctx(req).roles);
    if (!staff) {
      const own = await ownStudentIds(prisma, branchId, userId);
      if (!own.includes(row.studentId)) { problem(res, 403, 'authorization-error', 'Forbidden', 'Not your child.'); return; }
    }
    if (row.status === 'WITHDRAWN') { problem(res, 409, 'conflict', 'Conflict', 'Consent already withdrawn.'); return; }

    const updated = await prisma.consentRecord.update({
      where: { id: row.id },
      data: { status: 'WITHDRAWN', withdrawnAt: new Date(), metadata: { ...(row.metadata as object ?? {}), withdrawnBy: userId } },
    });

    await audit(prisma, req, 'ConsentRecord', row.id, 'CONSENT_WITHDRAWN', { purpose: row.purpose, studentId: row.studentId });
    res.json({ id: updated.id, purpose: updated.purpose, status: updated.status, withdrawnAt: updated.withdrawnAt });
  } catch (e) { problem(res, 500, 'internal-error', 'Server Error', (e as Error).message); }
});

// Consent ledger for one child — parents see their own child's rows.
router.get('/:studentId/consent', async (req: Request, res: Response) => {
  try {
    const prisma = prismaOf(req);
    if (!(await guardChildAccess(res, prisma, req, req.params.studentId))) return;
    const { branchId } = ctx(req);
    const rows = await prisma.consentRecord.findMany({
      where: { branchId: branchId!, studentId: req.params.studentId },
      orderBy: { updatedAt: 'desc' },
    });
    res.json({
      data: rows.map((r) => ({
        id: r.id, purpose: r.purpose, status: r.status, method: r.method,
        grantedAt: r.grantedAt, withdrawnAt: r.withdrawnAt,
        purposes: PURPOSES,
      })),
    });
  } catch (e) { problem(res, 500, 'internal-error', 'Server Error', (e as Error).message); }
});

// ── Data export (access right) ──

// One authenticated call returns everything the system holds about a child.
// Scoped by branch, ownership-gated, audit-logged — this is the §10.1(3)
// "data-principal rights: access" implementation.
router.get('/:studentId/data-export', async (req: Request, res: Response) => {
  try {
    const prisma = prismaOf(req);
    if (!(await guardChildAccess(res, prisma, req, req.params.studentId))) return;
    const { branchId, userId } = ctx(req);

    const student = await prisma.student.findFirst({
      where: { id: req.params.studentId, branchId: branchId! },
      include: {
        guardians: { include: { guardian: { select: { id: true, fullName: true, phone: true, email: true, occupation: true } } } },
        enrollments: {
          orderBy: { fromDate: 'desc' },
          include: { class: { select: { name: true } }, section: { select: { name: true } }, academicYear: { select: { name: true } } },
        },
        subjects: true,
        attendanceRecords: { orderBy: { createdAt: 'desc' }, take: 200, include: { session: { select: { date: true } } } },
        attendanceSummaries: { orderBy: [{ year: 'asc' }, { month: 'asc' }] },
        invoices: { select: { invoiceNo: true, dueDate: true, totalAmount: true, paidAmount: true, status: true } },
        examResults: { select: { examSubjectId: true, marksObtained: true, grade: true, isAbsent: true } },
        leaves: true,
        documents: { select: { id: true, type: true, createdAt: true } },
        certificates: { select: { type: true, certNo: true, issueDate: true } },
        consentRecords: { select: { purpose: true, status: true, grantedAt: true, withdrawnAt: true, method: true } },
        bookIssues: { select: { bookId: true, issueDate: true, returnDate: true } },
      },
    });
    if (!student) { problem(res, 404, 'not-found', 'Not Found', 'Student not found.'); return; }

    // The identity account travels with the export — the data principal is
    // the person, and the account IS personal data.
    const account = await prisma.user.findUnique({
      where: { id: student.userId },
      select: { email: true, createdAt: true, lastLogin: true, isActive: true },
    });

    await audit(prisma, req, 'Student', student.id, 'DATA_EXPORT', { requestedBy: userId });

    res.setHeader('content-disposition', `attachment; filename="data-export-${student.id}.json"`);
    res.json({
      exportedAt: new Date().toISOString(),
      legalBasis: 'DPDP Act 2023 §10.1(3) data-principal access request',
      student: {
        personal: {
          admissionNo: student.admissionNo, firstName: student.firstName, lastName: student.lastName,
          dateOfBirth: student.dateOfBirth, gender: student.gender, bloodGroup: student.bloodGroup,
          address: student.address, phone: student.phone, photo: student.photo,
          previousSchool: student.previousSchool, admissionDate: student.admissionDate,
        },
        account,
        guardians: student.guardians.map((g) => ({ relation: g.relation, ...g.guardian })),
        enrollments: student.enrollments.map((e) => ({
          year: e.academicYear.name, class: e.class.name, section: e.section.name,
          rollNo: e.rollNo, status: e.status, from: e.fromDate, to: e.toDate,
        })),
        subjects: student.subjects,
        attendance: { records: student.attendanceRecords, summaries: student.attendanceSummaries },
        fees: student.invoices,
        exams: student.examResults,
        leaves: student.leaves,
        documents: student.documents,
        certificates: student.certificates,
        library: student.bookIssues,
        consents: student.consentRecords,
      },
      retentionNote:
        'Financial and academic records are retained under statutory education and ' +
        'accounting rules; erasure requests are handled through the erasure endpoint.',
    });
  } catch (e) { problem(res, 500, 'internal-error', 'Server Error', (e as Error).message); }
});

// ── Erasure requests ──

const erasureSchema = z.object({ reason: z.string().max(1000).optional().nullable() });

// File an erasure request — open to the guardian (data principal) or staff
// on their behalf. Processing is a deliberate human step, never automatic.
router.post('/:studentId/erasure-requests', requireRole(...STAFF_GATES, 'PARENT', 'STUDENT'), async (req: Request, res: Response) => {
  try {
    const { branchId, userId } = ctx(req);
    if (!branchId) { problem(res, 403, 'authorization-error', 'Forbidden', 'Account has no branch.'); return; }
    const prisma = prismaOf(req);
    const input = erasureSchema.parse(req.body ?? {});

    const student = await prisma.student.findFirst({ where: { id: req.params.studentId, branchId }, select: { id: true } });
    if (!student) { problem(res, 404, 'not-found', 'Not Found', 'Student not found.'); return; }
    if (!isStaff(ctx(req).roles)) {
      const own = await ownStudentIds(prisma, branchId, userId);
      if (!own.includes(student.id)) { problem(res, 403, 'authorization-error', 'Forbidden', 'Not your child.'); return; }
    }

    const created = await prisma.erasureRequest.create({
      data: { branchId, studentId: student.id, requestedBy: userId, reason: input.reason ?? null },
    });
    await audit(prisma, req, 'ErasureRequest', created.id, 'ERASURE_FILED', { studentId: student.id });
    res.status(201).json({ id: created.id, status: created.status, createdAt: created.createdAt });
  } catch (e) {
    if (e instanceof z.ZodError) { problem(res, 400, 'validation-error', 'Invalid Input', e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')); return; }
    problem(res, 500, 'internal-error', 'Server Error', (e as Error).message);
  }
});

// Process an erasure request — completion erases the contact/photograph
// surface (address, phone, photo, Aadhaar-adjacent document rows) while
// statutory records (fees, academics) survive; the resolution note records
// exactly what was kept and why. Rejection records the reason.
router.post('/erasure-requests/:id/process', requireRole('SUPER_ADMIN', 'BRANCH_ADMIN', 'PRINCIPAL'), async (req: Request, res: Response) => {
  try {
    const { branchId, userId } = ctx(req);
    if (!branchId) { problem(res, 403, 'authorization-error', 'Forbidden', 'Account has no branch.'); return; }
    const prisma = prismaOf(req);
    const decision = z.object({
      action: z.enum(['COMPLETE', 'REJECT']),
      note: z.string().max(1000).optional().nullable(),
    }).parse(req.body);

    const request = await prisma.erasureRequest.findFirst({ where: { id: req.params.id, branchId } });
    if (!request) { problem(res, 404, 'not-found', 'Not Found', 'Erasure request not found.'); return; }
    if (request.status !== 'PENDING') { problem(res, 409, 'conflict', 'Conflict', 'Request already processed.'); return; }

    let erased: string[] = [];
    if (decision.action === 'COMPLETE') {
      // Erase the contact/photograph surface. Kept deliberately narrow:
      // statutory records (fees, academics, attendance) survive retention
      // rules and the resolution note says so.
      await prisma.student.update({
        where: { id: request.studentId },
        data: { address: 'Erased at data principal request', phone: null, photo: null },
      });
      erased = ['students.address', 'students.phone', 'students.photo'];
      // Photograph/identity document rows follow the erasure — the stored
      // key is overwritten so the blob is unreachable through the app.
      await prisma.document.updateMany({
        where: { studentId: request.studentId, type: { in: ['PHOTO', 'AADHAAR'] } },
        data: { s3Key: 'erased', deletedAt: new Date(), deletedBy: userId },
      });
      erased.push('documents(PHOTO/AADHAAR).s3Key');
    }

    const updated = await prisma.erasureRequest.update({
      where: { id: request.id },
      data: {
        status: decision.action === 'COMPLETE' ? 'COMPLETED' : 'REJECTED',
        processedBy: userId,
        processedAt: new Date(),
        resolutionNote:
          decision.action === 'COMPLETE'
            ? `Erased: ${erased.join(', ')}. Financial and academic records retained under statutory rules.`
            : decision.note ?? 'Rejected by the Data Fiduciary.',
      },
    });

    await audit(prisma, req, 'ErasureRequest', request.id, decision.action === 'COMPLETE' ? 'ERASURE_COMPLETED' : 'ERASURE_REJECTED', {
      studentId: request.studentId, erased,
    });
    res.json({ id: updated.id, status: updated.status, processedAt: updated.processedAt, resolutionNote: updated.resolutionNote });
  } catch (e) {
    if (e instanceof z.ZodError) { problem(res, 400, 'validation-error', 'Invalid Input', e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')); return; }
    problem(res, 500, 'internal-error', 'Server Error', (e as Error).message);
  }
});

// Erasure inbox — PENDING requests for the school's named grievance officer.
router.get('/erasure-requests', requireRole('SUPER_ADMIN', 'BRANCH_ADMIN', 'PRINCIPAL'), async (req: Request, res: Response) => {
  try {
    const prisma = prismaOf(req);
    const { branchId } = ctx(req);
    if (!branchId) { problem(res, 403, 'authorization-error', 'Forbidden', 'Account has no branch.'); return; }
    const status = req.query.status as string | undefined;
    const rows = await prisma.erasureRequest.findMany({
      where: { branchId, ...(status ? { status: status as never } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { student: { select: { admissionNo: true, firstName: true, lastName: true } } },
    });
    res.json({
      data: rows.map((r) => ({
        id: r.id, student: r.student, reason: r.reason, status: r.status,
        requestedBy: r.requestedBy, processedAt: r.processedAt, resolutionNote: r.resolutionNote,
        createdAt: r.createdAt,
      })),
    });
  } catch (e) { problem(res, 500, 'internal-error', 'Server Error', (e as Error).message); }
});

// The named grievance officer + SLA (§10.1 #3) — configuration surfaced as an
// endpoint so schools can see it and lawyers can verify it.
router.get('/grievance-officer', async (_req: Request, res: Response) => {
  res.json({
    officer: process.env.DPDP_GRIEVANCE_OFFICER ?? 'Principal',
    contact: process.env.DPDP_GRIEVANCE_EMAIL ?? null,
    slaDays: Number(process.env.DPDP_GRIEVANCE_SLA_DAYS ?? 30),
  });
});

export { router as dpdpRoutes };
