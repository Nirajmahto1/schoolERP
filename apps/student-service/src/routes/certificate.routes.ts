// ──────────────────────────────────────────────
// Certificate routes (BUILD_PLAN 10.3 #4)
//
// Issue, list, and download student certificates. The TC workflow (close the
// enrollment, deactivate the student) stays on the admissions router — this
// router handles the five "document" certificates and the TC's PDF download.
//
// The payload is a SNAPSHOT: every fact the PDF prints is captured at issue
// time and stored on the row, so re-downloading a certificate years later is
// byte-identical even if the student record has since been edited or erased —
// the same reason receipts snapshot the payment.
// ──────────────────────────────────────────────

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { PrismaClient } from '@school-erp/database';
import { ctx, requireRole } from '@school-erp/auth';
import { nextSequenceValueIn } from '@school-erp/domain';
import {
  renderAdmitCardPdf,
  renderBonafidePdf,
  renderCharacterPdf,
  renderFeeCertificatePdf,
  renderIdCardPdf,
  renderTcPdf,
  type CertPayload,
} from '../certificates/pdf';

const router = Router();

function prismaOf(req: Request): PrismaClient {
  return req.app.get('prisma') as PrismaClient;
}

function problem(res: Response, status: number, type: string, title: string, detail: string): void {
  res.status(status).type('application/problem+json').json({ type, title, status, detail });
}

const TYPES = ['BONAFIDE', 'CHARACTER', 'FEE_CERTIFICATE', 'ID_CARD', 'ADMIT_CARD'] as const;
type CertType = (typeof TYPES)[number];

const issueSchema = z.object({
  type: z.enum(TYPES),
  purpose: z.string().max(300).optional().nullable(),
  // ADMIT_CARD: exam name + per-subject rows snapshot from the exam schedule.
  examName: z.string().max(200).optional(),
  examId: z.string().optional(),
  // TC board-wording extras (optional; absent fields print '-').
  category: z.string().max(60).optional(),
  firstAdmission: z.string().max(40).optional(),
  lastExam: z.string().max(200).optional(),
  conduct: z.string().max(200).optional(),
  remarks: z.string().max(500).optional(),
});

const STAFF_ROLES = ['SUPER_ADMIN', 'BRANCH_ADMIN', 'PRINCIPAL', 'TEACHER', 'HOD', 'ACADEMIC_HEAD'] as const;

const fmtDate = (d: Date): string =>
  d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

const money = (v: unknown): string =>
  `Rs. ${Number(v ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Load the student + every fact the snapshot needs (branch-scoped, hard). */
async function loadStudent(prisma: PrismaClient, branchId: string, studentId: string) {
  return prisma.student.findFirst({
    where: { id: studentId, branchId },
    select: {
      id: true, admissionNo: true, firstName: true, lastName: true,
      dateOfBirth: true, gender: true, bloodGroup: true, phone: true,
      admissionDate: true, deletedAt: true,
      branch: { select: { name: true, code: true, school: true } },
      guardians: {
        where: { receivesComms: true },
        select: { relation: true, guardian: { select: { fullName: true } } },
      },
      enrollments: {
        orderBy: { fromDate: 'desc' },
        take: 1,
        include: {
          class: { select: { name: true } },
          section: { select: { name: true } },
          academicYear: { select: { name: true } },
        },
      },
      attendanceSummaries: { orderBy: [{ year: 'asc' }, { month: 'asc' }] },
    },
  });
}

function buildPayload(s: NonNullable<Awaited<ReturnType<typeof loadStudent>>>, certNo: string, extra: z.infer<typeof issueSchema>): CertPayload {
  const enrollment = s.enrollments[0];
  const father = s.guardians.find((g) => g.relation === 'FATHER')?.guardian.fullName ?? null;
  const mother = s.guardians.find((g) => g.relation === 'MOTHER')?.guardian.fullName ?? null;
  const workingDays = s.attendanceSummaries.reduce((a, m) => a + m.workingDays, 0);
  const presentDays = s.attendanceSummaries.reduce((a, m) => a + m.presentDays, 0);
  return {
    school: {
      name: s.branch.school.name,
      address: s.branch.school.address,
      city: s.branch.school.city,
      state: s.branch.school.state,
      pincode: s.branch.school.pincode,
      phone: s.branch.school.phone,
      email: s.branch.school.email,
    },
    branch: { name: s.branch.name, code: s.branch.code },
    student: {
      name: `${s.firstName} ${s.lastName}`,
      admissionNo: s.admissionNo,
      dob: fmtDate(s.dateOfBirth),
      gender: s.gender,
      father,
      mother,
      phone: s.phone,
    },
    academic: {
      className: enrollment?.class.name ?? '-',
      section: enrollment?.section.name ?? '-',
      academicYear: enrollment?.academicYear.name ?? '-',
      rollNo: (enrollment as unknown as { rollNo?: string | null })?.rollNo ?? null,
    },
    attendance: s.attendanceSummaries.length ? { workingDays, presentDays } : null,
    certNo,
    issueDate: fmtDate(new Date()),
    purpose: extra.purpose ?? null,
    category: extra.category,
    firstAdmission: extra.firstAdmission ?? (s.admissionDate ? fmtDate(s.admissionDate) : undefined),
    lastExam: extra.lastExam,
    conduct: extra.conduct,
    remarks: extra.remarks,
    bloodGroup: s.bloodGroup ?? undefined,
  };
}

const RENDERERS: Record<CertType, (d: CertPayload) => Buffer> = {
  BONAFIDE: renderBonafidePdf,
  CHARACTER: renderCharacterPdf,
  FEE_CERTIFICATE: renderFeeCertificatePdf,
  ID_CARD: renderIdCardPdf,
  ADMIT_CARD: renderAdmitCardPdf,
};

const SEQUENCE_CODES: Record<CertType, string> = {
  BONAFIDE: 'BONAFIDE',
  CHARACTER: 'CHARACTER',
  FEE_CERTIFICATE: 'FEE_CERT',
  ID_CARD: 'ID_CARD',
  ADMIT_CARD: 'ADMIT_CARD',
};

const DOC_TITLES: Record<CertType, string> = {
  BONAFIDE: 'Bonafide Certificate',
  CHARACTER: 'Character Certificate',
  FEE_CERTIFICATE: 'Fee Payment Certificate',
  ID_CARD: 'Student ID Card',
  ADMIT_CARD: 'Admit Card',
};

function sendPdf(res: Response, filename: string, pdf: Buffer): void {
  res
    .status(200)
    .type('application/pdf')
    .set('content-disposition', `inline; filename="${filename}"`)
    .send(pdf);
}

// ── Issue a certificate (staff only) ──

router.post('/:studentId/certificates', requireRole(...STAFF_ROLES), async (req: Request, res: Response) => {
  try {
    const { branchId, userId } = ctx(req);
    if (!branchId) { problem(res, 403, 'authorization-error', 'Forbidden', 'Account has no branch.'); return; }
    const input = issueSchema.parse(req.body);
    const prisma = prismaOf(req);

    const student = await loadStudent(prisma, branchId, req.params.studentId);
    if (!student) { problem(res, 404, 'not-found', 'Not Found', 'Student not found.'); return; }

    // ADMIT_CARD pulls the exam schedule rows into the snapshot at issue time.
    let subjects: CertPayload['subjects'];
    if (input.type === 'ADMIT_CARD') {
      const exams = await prisma.examination.findMany({
        where: { branchId, ...(input.examId ? { id: input.examId } : {}) },
        orderBy: { createdAt: 'desc' },
        take: 1,
        include: {
          subjects: {
            orderBy: { examDate: 'asc' },
            include: { subject: { select: { name: true } } },
          },
        },
      });
      const exam = exams[0];
      if (!exam) { problem(res, 409, 'conflict', 'Conflict', 'No exam schedule found to print an admit card from.'); return; }
      input.examName = input.examName ?? exam.name;
      subjects = exam.subjects.map((es) => ({
        name: es.subject.name,
        date: fmtDate(es.examDate),
        timing: `${es.startTime} - ${es.endTime}`,
        maxMarks: String(es.maxMarks),
      }));
    }

    const created = await prisma.$transaction(async (tx) => {
      const certNo = await nextSequenceValueIn(tx as never, {
        branchId,
        code: SEQUENCE_CODES[input.type],
        format: `${input.type}/{AY}/{SEQ:4}`,
      });
      const payload = buildPayload(student, certNo, input);
      if (subjects) payload.subjects = subjects;
      if (input.examName) payload.examName = input.examName;
      // FEE_CERTIFICATE: snapshot the money table at issue time so the
      // printed certificate stays true even after later invoices/payments.
      if (input.type === 'FEE_CERTIFICATE') {
        const invoices = await tx.invoice.findMany({
          where: { studentId: student.id, deletedAt: null },
          orderBy: { dueDate: 'asc' },
          select: { invoiceNo: true, periodStart: true, periodEnd: true, totalAmount: true, paidAmount: true, status: true },
        });
        payload.payments = invoices.map((inv) => ({
          invoiceNo: inv.invoiceNo,
          period: inv.periodStart && inv.periodEnd
            ? `${fmtDate(inv.periodStart)} - ${fmtDate(inv.periodEnd)}`
            : 'Full year',
          total: money(inv.totalAmount),
          paid: money(inv.paidAmount),
          status: inv.status,
        }));
        const totalDue = invoices.reduce((a, i) => a + Number(i.totalAmount) - Number(i.paidAmount), 0);
        payload.totalOutstanding = money(totalDue);
      }
      return tx.studentCertificate.create({
        data: {
          branchId,
          studentId: student.id,
          type: input.type,
          certNo,
          purpose: input.purpose ?? null,
          payload: payload as unknown as object,
          issuedBy: userId,
        },
      });
    });

    res.status(201).json({
      id: created.id,
      type: created.type,
      certNo: created.certNo,
      issueDate: created.issueDate,
      downloadUrl: `/api/v1/students/${student.id}/certificates/${created.id}/pdf`,
    });
  } catch (e) {
    if (e instanceof z.ZodError) { problem(res, 400, 'validation-error', 'Invalid Input', e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')); return; }
    problem(res, 500, 'internal-error', 'Server Error', (e as Error).message);
  }
});

// ── List a student's certificates (staff, or the student/parent who owns it) ──

router.get('/:studentId/certificates', async (req: Request, res: Response) => {
  try {
    const { branchId, roles, userId } = ctx(req);
    if (!branchId) { problem(res, 403, 'authorization-error', 'Forbidden', 'Account has no branch.'); return; }
    const prisma = prismaOf(req);

    const isStaff = roles.some((r) => (STAFF_ROLES as readonly string[]).includes(r));
    let studentIds: string[];
    if (isStaff) {
      studentIds = [req.params.studentId];
    } else {
      // Students see their own; parents see their children. Resolved from the
      // caller's identity, never from a client-supplied id (IDOR gate).
      const own = await prisma.student.findFirst({ where: { userId, branchId }, select: { id: true } });
      const children = await prisma.studentGuardian.findMany({
        where: { guardian: { userId }, student: { branchId } },
        select: { studentId: true },
      });
      studentIds = [own?.id, ...children.map((c) => c.studentId)].filter((x): x is string => Boolean(x));
      if (!studentIds.includes(req.params.studentId)) {
        problem(res, 403, 'authorization-error', 'Forbidden', 'Not your certificate.');
        return;
      }
    }

    const rows = await prisma.studentCertificate.findMany({
      where: { branchId, studentId: { in: studentIds } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    res.json({
      data: rows.map((r) => ({
        id: r.id,
        studentId: r.studentId,
        type: r.type,
        title: DOC_TITLES[r.type],
        certNo: r.certNo,
        issueDate: r.issueDate,
        purpose: r.purpose,
        downloadUrl: `/api/v1/students/${r.studentId}/certificates/${r.id}/pdf`,
      })),
    });
  } catch (e) { problem(res, 500, 'internal-error', 'Server Error', (e as Error).message); }
});

// ── Download the PDF (staff, or the owning student/parent) ──

router.get('/:studentId/certificates/:certId/pdf', async (req: Request, res: Response) => {
  try {
    const { branchId, roles, userId } = ctx(req);
    if (!branchId) { problem(res, 403, 'authorization-error', 'Forbidden', 'Account has no branch.'); return; }
    const prisma = prismaOf(req);

    const cert = await prisma.studentCertificate.findFirst({
      where: { id: req.params.certId, branchId, studentId: req.params.studentId },
    });
    if (!cert) { problem(res, 404, 'not-found', 'Not Found', 'Certificate not found.'); return; }

    const isStaff = roles.some((r) => (STAFF_ROLES as readonly string[]).includes(r));
    if (!isStaff) {
      const own = await prisma.student.findFirst({ where: { userId, branchId }, select: { id: true } });
      const children = await prisma.studentGuardian.findMany({
        where: { guardian: { userId }, student: { branchId } },
        select: { studentId: true },
      });
      const allowed = [own?.id, ...children.map((c) => c.studentId)].filter((x): x is string => Boolean(x));
      if (!allowed.includes(cert.studentId)) {
        problem(res, 403, 'authorization-error', 'Forbidden', 'Not your certificate.');
        return;
      }
    }

    const payload = cert.payload as unknown as CertPayload;
    const pdf = RENDERERS[cert.type as CertType](payload);
    sendPdf(res, `${cert.type}-${cert.certNo}.pdf`, pdf);
  } catch (e) { problem(res, 500, 'internal-error', 'Server Error', (e as Error).message); }
});

// ── TC PDF download (issued by the admissions router's workflow) ──

router.get('/tcs/:tcId/pdf', requireRole(...STAFF_ROLES), async (req: Request, res: Response) => {
  try {
    const { branchId } = ctx(req);
    if (!branchId) { problem(res, 403, 'authorization-error', 'Forbidden', 'Account has no branch.'); return; }
    const prisma = prismaOf(req);

    const tc = await prisma.transferCertificate.findFirst({
      where: { id: req.params.tcId, branchId },
      include: {
        student: {
          include: {
            branch: { include: { school: true } },
            guardians: { select: { relation: true, guardian: { select: { fullName: true } } } },
            enrollments: {
              orderBy: { fromDate: 'desc' },
              include: {
                class: { select: { name: true } },
                section: { select: { name: true } },
                academicYear: { select: { name: true } },
              },
            },
            attendanceSummaries: { orderBy: [{ year: 'asc' }, { month: 'asc' }] },
          },
        },
      },
    });
    if (!tc) { problem(res, 404, 'not-found', 'Not Found', 'Transfer certificate not found.'); return; }

    const s = tc.student;
    const enrollment = s.enrollments[0];
    const father = s.guardians.find((g) => g.relation === 'FATHER')?.guardian.fullName ?? null;
    const mother = s.guardians.find((g) => g.relation === 'MOTHER')?.guardian.fullName ?? null;
    const workingDays = s.attendanceSummaries.reduce((a, m) => a + m.workingDays, 0);
    const presentDays = s.attendanceSummaries.reduce((a, m) => a + m.presentDays, 0);

    const payload: CertPayload = {
      school: {
        name: s.branch.school.name, address: s.branch.school.address, city: s.branch.school.city,
        state: s.branch.school.state, pincode: s.branch.school.pincode, phone: s.branch.school.phone,
        email: s.branch.school.email,
      },
      branch: { name: s.branch.name, code: s.branch.code },
      student: {
        name: `${s.firstName} ${s.lastName}`, admissionNo: s.admissionNo,
        dob: fmtDate(s.dateOfBirth), gender: s.gender, father, mother, phone: s.phone,
      },
      academic: {
        className: enrollment?.class.name ?? '-', section: enrollment?.section.name ?? '-',
        academicYear: enrollment?.academicYear.name ?? '-',
        rollNo: (enrollment as unknown as { rollNo?: string | null })?.rollNo ?? null,
      },
      attendance: s.attendanceSummaries.length ? { workingDays, presentDays } : null,
      certNo: tc.tcNo,
      issueDate: fmtDate(tc.issueDate),
      remarks: tc.remarks ?? undefined,
      applicationDate: fmtDate(tc.createdAt),
    };
    sendPdf(res, `TC-${tc.tcNo}.pdf`, renderTcPdf(payload));
  } catch (e) { problem(res, 500, 'internal-error', 'Server Error', (e as Error).message); }
});

export { router as certificateRoutes };
