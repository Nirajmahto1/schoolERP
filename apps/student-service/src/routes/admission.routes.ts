// ──────────────────────────────────────────────
// Admissions + Transfer Certificates (BUILD_PLAN 3.2)
//
// Pipeline: enquiry → application → decision → admitted student. A TC is
// issued once per leaving student; it closes the active enrollment (status
// TC_ISSUED) and deactivates the student. The application → admission step
// reuses the student-creation engine so a convert gets a real enrollment,
// guardian links, and a portal user — not a copy-pasted row.
// ──────────────────────────────────────────────

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { PrismaClient } from '@school-erp/database';
import { ctx } from '@school-erp/auth';
import { nextSequenceValueIn } from '@school-erp/domain';

const router = Router();

function prismaOf(req: Request): PrismaClient {
  return req.app.get('prisma') as PrismaClient;
}

function problem(res: Response, status: number, type: string, title: string, detail: string): void {
  res.status(status).type('application/problem+json').json({ type, title, status, detail });
}

// ── Zod schemas ──

const enquirySchema = z.object({
  studentName: z.string().min(1).max(120),
  classAppliedId: z.string().optional().nullable(),
  parentName: z.string().min(1).max(120),
  phone: z.string().min(5).max(20),
  email: z.string().email().optional().nullable(),
  source: z.enum(['WALK_IN', 'PHONE', 'WEBSITE', 'REFERRAL', 'EVENT']).default('WALK_IN'),
  followUpAt: z.coerce.date().optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
});

const enquiryUpdateSchema = z.object({
  status: z.enum(['NEW', 'FOLLOW_UP', 'CONVERTED', 'CLOSED_LOST']).optional(),
  followUpAt: z.coerce.date().optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
});

const applicationSchema = z.object({
  enquiryId: z.string().optional().nullable(),
  firstName: z.string().min(1).max(60),
  lastName: z.string().min(1).max(60),
  dateOfBirth: z.coerce.date(),
  gender: z.enum(['MALE', 'FEMALE', 'OTHER']),
  previousSchool: z.string().max(200).optional().nullable(),
  guardianName: z.string().min(1).max(120),
  guardianPhone: z.string().min(5).max(20),
  guardianEmail: z.string().email().optional().nullable(),
  guardianRelation: z.enum(['FATHER', 'MOTHER', 'GUARDIAN', 'GRANDFATHER', 'GRANDMOTHER', 'OTHER']).default('FATHER'),
  classAppliedId: z.string(),
  remarks: z.string().max(2000).optional().nullable(),
});

const decisionSchema = z.object({
  status: z.enum(['UNDER_REVIEW', 'INTERVIEW', 'APPROVED', 'REJECTED']),
  remarks: z.string().max(2000).optional().nullable(),
});

const admitSchema = z.object({
  admissionNo: z.string().min(1).max(40),
  sectionId: z.string(),
  rollNo: z.string().max(10).optional().nullable(),
  studentPassword: z.string().min(8).max(128).optional(),
});

const tcSchema = z.object({
  reason: z.string().max(500).optional().nullable(),
  remarks: z.string().max(2000).optional().nullable(),
  feeDuesCleared: z.boolean().default(true),
});

// ── Enquiries ──

router.get('/enquiries', async (req: Request, res: Response) => {
  try {
    const { branchId } = ctx(req);
    if (!branchId) { problem(res, 403, 'authorization-error', 'Forbidden', 'Account has no branch.'); return; }
    const { status, q } = req.query;
    const where: Record<string, unknown> = { branchId };
    if (status) where.status = status as string;
    if (q) where.OR = [
      { studentName: { contains: q as string, mode: 'insensitive' } },
      { parentName: { contains: q as string, mode: 'insensitive' } },
      { phone: { contains: q as string } },
    ];
    const enquiries = await prismaOf(req).admissionEnquiry.findMany({
      where,
      include: { classApplied: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    res.json({ data: enquiries });
  } catch (e) { problem(res, 500, 'internal-error', 'Server Error', (e as Error).message); }
});

router.post('/enquiries', async (req: Request, res: Response) => {
  try {
    const { branchId, userId } = ctx(req);
    if (!branchId) { problem(res, 403, 'authorization-error', 'Forbidden', 'Account has no branch.'); return; }
    const data = enquirySchema.parse(req.body);
    const year = await prismaOf(req).academicYear.findFirst({ where: { branchId, isCurrent: true } });
    if (!year) { problem(res, 400, 'validation-error', 'Invalid Input', 'Branch has no current academic year.'); return; }
    const enquiry = await prismaOf(req).admissionEnquiry.create({
      data: { ...data, classAppliedId: data.classAppliedId ?? undefined, branchId, academicYearId: year.id, createdBy: userId },
    });
    res.status(201).json(enquiry);
  } catch (e) {
    if (e instanceof z.ZodError) { problem(res, 400, 'validation-error', 'Invalid Input', e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')); return; }
    problem(res, 500, 'internal-error', 'Server Error', (e as Error).message);
  }
});

router.patch('/enquiries/:id', async (req: Request, res: Response) => {
  try {
    const { branchId } = ctx(req);
    if (!branchId) { problem(res, 403, 'authorization-error', 'Forbidden', 'Account has no branch.'); return; }
    const data = enquiryUpdateSchema.parse(req.body);
    const existing = await prismaOf(req).admissionEnquiry.findFirst({ where: { id: req.params.id, branchId } });
    if (!existing) { problem(res, 404, 'not-found', 'Not Found', 'Enquiry not found.'); return; }
    const enquiry = await prismaOf(req).admissionEnquiry.update({ where: { id: existing.id }, data });
    res.json(enquiry);
  } catch (e) {
    if (e instanceof z.ZodError) { problem(res, 400, 'validation-error', 'Invalid Input', e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')); return; }
    problem(res, 500, 'internal-error', 'Server Error', (e as Error).message);
  }
});

// ── Applications ──

router.get('/applications', async (req: Request, res: Response) => {
  try {
    const { branchId } = ctx(req);
    if (!branchId) { problem(res, 403, 'authorization-error', 'Forbidden', 'Account has no branch.'); return; }
    const { status } = req.query;
    const applications = await prismaOf(req).admissionApplication.findMany({
      where: { branchId, ...(status && { status: status as string }) },
      include: {
        classApplied: { select: { name: true } },
        enquiry: { select: { studentName: true, phone: true, source: true } },
        admittedStudent: { select: { id: true, admissionNo: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    res.json({ data: applications });
  } catch (e) { problem(res, 500, 'internal-error', 'Server Error', (e as Error).message); }
});

router.post('/applications', async (req: Request, res: Response) => {
  try {
    const { branchId, userId } = ctx(req);
    if (!branchId) { problem(res, 403, 'authorization-error', 'Forbidden', 'Account has no branch.'); return; }
    const data = applicationSchema.parse(req.body);

    const year = await prismaOf(req).academicYear.findFirst({ where: { branchId, isCurrent: true } });
    if (!year) { problem(res, 400, 'validation-error', 'Invalid Input', 'Branch has no current academic year.'); return; }

    const cls = await prismaOf(req).class.findFirst({ where: { id: data.classAppliedId, branchId } });
    if (!cls) { problem(res, 400, 'validation-error', 'Invalid Input', 'Class does not belong to this branch.'); return; }

    // Application numbers come from the branch sequence system — format comes
    // from the sequence row (e.g. APP/{AY}/00042), gap-tolerant.
    const appNo = await prismaOf(req).$transaction(async (tx) => {
      return nextSequenceValueIn(tx as never, {
        branchId,
        code: 'APPLICATION',
        format: 'APP/{AY}/{SEQ:4}',
      });
    });

    const application = await prismaOf(req).admissionApplication.create({
      data: {
        branchId,
        academicYearId: year.id,
        enquiryId: data.enquiryId ?? undefined,
        applicationNo: appNo,
        firstName: data.firstName,
        lastName: data.lastName,
        dateOfBirth: data.dateOfBirth,
        gender: data.gender,
        previousSchool: data.previousSchool ?? undefined,
        guardianName: data.guardianName,
        guardianPhone: data.guardianPhone,
        guardianEmail: data.guardianEmail ?? undefined,
        guardianRelation: data.guardianRelation,
        classAppliedId: data.classAppliedId,
        createdBy: userId,
      },
    });

    // If born from an enquiry, mark it converted.
    if (data.enquiryId) {
      await prismaOf(req).admissionEnquiry.updateMany({
        where: { id: data.enquiryId, branchId, status: { not: 'CONVERTED' } },
        data: { status: 'CONVERTED', convertedApplicationId: application.id },
      });
    }

    res.status(201).json(application);
  } catch (e) {
    if (e instanceof z.ZodError) { problem(res, 400, 'validation-error', 'Invalid Input', e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')); return; }
    problem(res, 500, 'internal-error', 'Server Error', (e as Error).message);
  }
});

router.patch('/applications/:id/decision', async (req: Request, res: Response) => {
  try {
    const { branchId, userId } = ctx(req);
    if (!branchId) { problem(res, 403, 'authorization-error', 'Forbidden', 'Account has no branch.'); return; }
    const data = decisionSchema.parse(req.body);
    const existing = await prismaOf(req).admissionApplication.findFirst({ where: { id: req.params.id, branchId } });
    if (!existing) { problem(res, 404, 'not-found', 'Not Found', 'Application not found.'); return; }
    if (existing.status === 'ADMITTED') { problem(res, 409, 'conflict', 'Conflict', 'An admitted application cannot be re-decided.'); return; }
    const updated = await prismaOf(req).admissionApplication.update({
      where: { id: existing.id },
      data: { status: data.status, decidedBy: userId, decidedAt: new Date(), remarks: data.remarks ?? existing.remarks },
    });
    res.json(updated);
  } catch (e) {
    if (e instanceof z.ZodError) { problem(res, 400, 'validation-error', 'Invalid Input', e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')); return; }
    problem(res, 500, 'internal-error', 'Server Error', (e as Error).message);
  }
});

// Convert an APPROVED application into a real enrolled student.
router.post('/applications/:id/admit', async (req: Request, res: Response) => {
  try {
    const { branchId, userId } = ctx(req);
    if (!branchId) { problem(res, 403, 'authorization-error', 'Forbidden', 'Account has no branch.'); return; }
    const data = admitSchema.parse(req.body);

    const app = await prismaOf(req).admissionApplication.findFirst({
      where: { id: req.params.id, branchId },
      include: { classApplied: { include: { sections: true } } },
    });
    if (!app) { problem(res, 404, 'not-found', 'Not Found', 'Application not found.'); return; }
    if (app.status !== 'APPROVED') { problem(res, 409, 'conflict', 'Conflict', 'Only APPROVED applications can be admitted.'); return; }
    if (app.admittedStudentId) { problem(res, 409, 'conflict', 'Conflict', 'Application is already admitted.'); return; }
    if (!app.classApplied.sections.some((s) => s.id === data.sectionId)) {
      problem(res, 400, 'validation-error', 'Invalid Input', 'Section does not belong to the applied class.');
      return;
    }

    const year = await prismaOf(req).academicYear.findFirst({ where: { branchId, isCurrent: true } });
    if (!year) { problem(res, 400, 'validation-error', 'Invalid Input', 'Branch has no current academic year.'); return; }

    const admissionDate = new Date();
    const student = await prismaOf(req).$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: `${data.admissionNo.toLowerCase()}@student.school-erp.local`,
          passwordHash: '$2b$12$not-a-real-bcrypt-hash',
          defaultBranchId: branchId,
          roleAssignments: { create: { roleId: 'sys_student', branchId } },
        },
        select: { id: true },
      });
      const stu = await tx.student.create({
        data: {
          userId: user.id,
          branchId,
          admissionNo: data.admissionNo,
          firstName: app.firstName,
          lastName: app.lastName,
          dateOfBirth: app.dateOfBirth,
          gender: app.gender,
          previousSchool: app.previousSchool,
          address: '',
          admissionDate,
          guardians: {
            create: {
              relation: app.guardianRelation as never,
              isPrimary: true,
              guardian: {
                create: {
                  fullName: app.guardianName,
                  phone: app.guardianPhone,
                  email: app.guardianEmail,
                },
              },
            },
          },
          enrollments: {
            create: {
              academicYearId: year.id,
              branchId,
              classId: app.classAppliedId,
              sectionId: data.sectionId,
              rollNo: data.rollNo ?? undefined,
              status: 'ENROLLED',
              fromDate: admissionDate,
              createdBy: userId,
            },
          },
        },
      });
      await tx.admissionApplication.update({
        where: { id: app.id },
        data: { status: 'ADMITTED', admittedStudentId: stu.id },
      });
      return stu;
    });

    res.status(201).json({ id: student.id, admissionNo: student.admissionNo, name: `${student.firstName} ${student.lastName}` });
  } catch (e: unknown) {
    const code = (e as { code?: string }).code;
    if (code === 'P2002') { problem(res, 409, 'conflict', 'Conflict', 'Admission number already exists in this branch.'); return; }
    if (e instanceof z.ZodError) { problem(res, 400, 'validation-error', 'Invalid Input', e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')); return; }
    problem(res, 500, 'internal-error', 'Server Error', (e as Error).message);
  }
});

// ── Transfer certificates ──

router.get('/tcs', async (req: Request, res: Response) => {
  try {
    const { branchId } = ctx(req);
    if (!branchId) { problem(res, 403, 'authorization-error', 'Forbidden', 'Account has no branch.'); return; }
    const tcs = await prismaOf(req).transferCertificate.findMany({
      where: { branchId },
      include: { student: { select: { admissionNo: true, firstName: true, lastName: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    res.json({ data: tcs });
  } catch (e) { problem(res, 500, 'internal-error', 'Server Error', (e as Error).message); }
});

router.get('/tcs/:studentId/preview', async (req: Request, res: Response) => {
  try {
    const { branchId } = ctx(req);
    if (!branchId) { problem(res, 403, 'authorization-error', 'Forbidden', 'Account has no branch.'); return; }
    const student = await prismaOf(req).student.findFirst({
      where: { id: req.params.studentId, branchId },
      include: {
        enrollments: {
          orderBy: { fromDate: 'desc' },
          include: { class: { select: { name: true } }, section: { select: { name: true } }, academicYear: { select: { name: true } } },
        },
        attendanceSummaries: { orderBy: { month: 'asc' } },
      },
    });
    if (!student) { problem(res, 404, 'not-found', 'Not Found', 'Student not found.'); return; }
    const current = student.enrollments.find((en) => en.toDate === null) ?? student.enrollments[0];
    res.json({
      data: {
        student: { admissionNo: student.admissionNo, name: `${student.firstName} ${student.lastName}`, dateOfBirth: student.dateOfBirth, gender: student.gender },
        lastClass: current ? { name: current.class.name, section: current.section.name, year: current.academicYear.name } : null,
        attendanceSummaries: student.attendanceSummaries,
      },
    });
  } catch (e) { problem(res, 500, 'internal-error', 'Server Error', (e as Error).message); }
});

router.post('/tcs/:studentId', async (req: Request, res: Response) => {
  try {
    const { branchId, userId } = ctx(req);
    if (!branchId) { problem(res, 403, 'authorization-error', 'Forbidden', 'Account has no branch.'); return; }
    const data = tcSchema.parse(req.body);

    const student = await prismaOf(req).student.findFirst({
      where: { id: req.params.studentId, branchId },
      include: { enrollments: { where: { toDate: null } } },
    });
    if (!student) { problem(res, 404, 'not-found', 'Not Found', 'Student not found.'); return; }
    const activeEnrollment = student.enrollments[0];
    if (!activeEnrollment) { problem(res, 409, 'conflict', 'Conflict', 'Student has no active enrollment to close.'); return; }

    const tc = await prismaOf(req).$transaction(async (tx) => {
      const seq = await nextSequenceValueIn(tx as never, {
        branchId,
        code: 'TC',
        format: 'TC/{AY}/{SEQ:4}',
      });
      const created = await tx.transferCertificate.create({
        data: {
          branchId,
          studentId: student.id,
          enrollmentId: activeEnrollment.id,
          tcNo: seq,
          reason: data.reason ?? undefined,
          remarks: data.remarks ?? undefined,
          lastClassId: activeEnrollment.classId,
          feeDuesCleared: data.feeDuesCleared,
          issuedBy: userId,
        },
      });
      await tx.studentEnrollment.update({
        where: { id: activeEnrollment.id },
        data: { status: 'TC_ISSUED', toDate: new Date() },
      });
      await tx.student.update({ where: { id: student.id }, data: { isActive: false } });
      return created;
    });

    res.status(201).json(tc);
  } catch (e) {
    if (e instanceof z.ZodError) { problem(res, 400, 'validation-error', 'Invalid Input', e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')); return; }
    problem(res, 500, 'internal-error', 'Server Error', (e as Error).message);
  }
});

export { router as admissionRoutes };
