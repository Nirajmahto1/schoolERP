// ──────────────────────────────────────────────
// School ERP — Exam Service (app factory)
//
// Phase 3.6 (BUILD_PLAN §3 #6): examinations move out of academic-service
// into their own module — one of "the two places bugs cost you a customer".
// Owns: exam schedules, mark entry with audit, the ENTRY → SUBMITTED →
// VERIFIED → PUBLISHED publication workflow, grading, and report-card
// aggregation. Nothing is parent-visible until PUBLISHED (2.6.5).
// ──────────────────────────────────────────────

import express, { type Express } from 'express';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { PrismaClient } from '@school-erp/database';
import { PrismaClient as ControlPlaneClient } from '@school-erp/control-plane';
import { requireAssertion, stripSpoofableHeaders, ctx } from '@school-erp/auth';
import type { ServiceEnv } from '@school-erp/config';

/** MUST equal the gateway route-table audience for this service. */
export const SERVICE_NAME = 'exam-service';

export interface ExamAppOptions {
  env: ServiceEnv;
  prisma: PrismaClient;
  controlPlane?: ControlPlaneClient;
}

function problem(res: Response, status: number, type: string, title: string, detail: string): void {
  res.status(status).type('application/problem+json').json({ type, title, status, detail });
}

const router = Router();

// ── Schemas ──

const examSchema = z.object({
  name: z.string().min(1).max(120),
  academicYearId: z.string(),
  assessmentTypeId: z.string().optional().nullable(),
  startDate: z.coerce.date(),
  endDate: z.coerce.date(),
  subjects: z.array(z.object({
    subjectId: z.string(),
    examDate: z.coerce.date(),
    startTime: z.string().regex(/^\d{2}:\d{2}$/),
    endTime: z.string().regex(/^\d{2}:\d{2}$/),
    maxMarks: z.number().int().positive(),
    passingMarks: z.number().int().nonnegative(),
  })).min(1),
});

const markEntrySchema = z.object({
  examSubjectId: z.string(),
  marks: z.array(z.object({
    studentId: z.string(),
    marksObtained: z.number().min(0).optional().nullable(),
    isAbsent: z.boolean().default(false),
    isExempt: z.boolean().default(false),
    remarks: z.string().max(500).optional().nullable(),
  })).min(1),
});

const statusSchema = z.object({
  status: z.enum(['SUBMITTED', 'VERIFIED', 'PUBLISHED']),
  remarks: z.string().max(500).optional().nullable(),
});

export function createExamApp({ env, prisma }: ExamAppOptions): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(stripSpoofableHeaders);
  app.use(express.json({ limit: '2mb' }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: SERVICE_NAME, timestamp: new Date().toISOString() });
  });
  app.get('/ready', async (_req, res) => {
    try { await prisma.$queryRaw`SELECT 1`; res.json({ status: 'ready', service: SERVICE_NAME }); }
    catch { res.status(503).json({ type: 'unavailable', title: 'Not Ready', status: 503, detail: 'Database is not reachable.' }); }
  });

  // ── Examinations ──

  router.get('/examinations', async (req: Request, res: Response) => {
    try {
      const { branchId } = ctx(req);
      if (!branchId) { problem(res, 403, 'authorization-error', 'Forbidden', 'Account has no branch.'); return; }
      const exams = await prisma.examination.findMany({
        where: { branchId },
        include: {
          assessmentType: { select: { name: true, code: true, weightage: true } },
          subjects: { include: { subject: { select: { name: true, code: true } } } },
        },
        orderBy: { startDate: 'desc' },
      });
      res.json({ data: exams });
    } catch (e) { problem(res, 500, 'internal-error', 'Server Error', (e as Error).message); }
  });

  router.post('/examinations', async (req: Request, res: Response) => {
    try {
      const { branchId } = ctx(req);
      if (!branchId) { problem(res, 403, 'authorization-error', 'Forbidden', 'Account has no branch.'); return; }
      const data = examSchema.parse(req.body);
      if (data.endDate < data.startDate) { problem(res, 400, 'validation-error', 'Invalid Input', 'endDate must be on or after startDate.'); return; }
      const exam = await prisma.examination.create({
        data: {
          name: data.name,
          branchId,
          academicYearId: data.academicYearId,
          assessmentTypeId: data.assessmentTypeId ?? undefined,
          startDate: data.startDate,
          endDate: data.endDate,
          subjects: {
            create: data.subjects.map((s) => ({
              subjectId: s.subjectId,
              examDate: s.examDate,
              startTime: s.startTime,
              endTime: s.endTime,
              maxMarks: s.maxMarks,
              passingMarks: s.passingMarks,
            })),
          },
        },
        include: { subjects: true },
      });
      res.status(201).json(exam);
    } catch (e) {
      if (e instanceof z.ZodError) { problem(res, 400, 'validation-error', 'Invalid Input', e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')); return; }
      problem(res, 500, 'internal-error', 'Server Error', (e as Error).message);
    }
  });

  // ── Mark entry with audit (2.6.8) ──
  // Every change to an existing mark is appended to MarkEntryAudit with the
  // before value. Marks cannot be modified after the exam is PUBLISHED.
  router.post('/marks', async (req: Request, res: Response) => {
    try {
      const { branchId, userId } = ctx(req);
      if (!branchId) { problem(res, 403, 'authorization-error', 'Forbidden', 'Account has no branch.'); return; }
      const data = markEntrySchema.parse(req.body);

      const examSubject = await prisma.examSubject.findFirst({
        where: { id: data.examSubjectId, examination: { branchId } },
        include: { examination: { select: { status: true, id: true } } },
      });
      if (!examSubject) { problem(res, 404, 'not-found', 'Not Found', 'Exam subject not found.'); return; }
      if (examSubject.examination.status === 'PUBLISHED') {
        problem(res, 409, 'conflict', 'Conflict', 'Marks are published and can no longer be modified.');
        return;
      }

      let entered = 0;
      await prisma.$transaction(async (tx) => {
        for (const m of data.marks) {
          const existing = await tx.examResult.findUnique({
            where: { examSubjectId_studentId: { examSubjectId: examSubject.id, studentId: m.studentId } },
          });
          if (m.marksObtained != null && m.marksObtained > examSubject.maxMarks) {
            throw Object.assign(new Error(`Marks for student ${m.studentId} exceed maxMarks ${examSubject.maxMarks}.`), { status: 400 });
          }
          if (existing) {
            const changed = Number(existing.marksObtained) !== (m.marksObtained ?? -1)
              || existing.isAbsent !== m.isAbsent || existing.isExempt !== m.isExempt;
            if (changed) {
              await tx.examResult.update({
                where: { id: existing.id },
                data: {
                  marksObtained: m.marksObtained ?? existing.marksObtained,
                  isAbsent: m.isAbsent,
                  isExempt: m.isExempt,
                  remarks: m.remarks ?? existing.remarks,
                  enteredBy: userId,
                },
              });
              await tx.markEntryAudit.create({
                data: {
                  examResultId: existing.id,
                  beforeMarks: existing.marksObtained,
                  afterMarks: m.marksObtained ?? existing.marksObtained,
                  changedBy: userId,
                  reason: m.remarks ?? null,
                },
              });
            }
          } else {
            const created = await tx.examResult.create({
              data: {
                examSubjectId: examSubject.id,
                studentId: m.studentId,
                marksObtained: m.marksObtained ?? 0,
                isAbsent: m.isAbsent,
                isExempt: m.isExempt,
                remarks: m.remarks ?? null,
                enteredBy: userId,
              },
            });
            await tx.markEntryAudit.create({
              data: { examResultId: created.id, beforeMarks: null, afterMarks: m.marksObtained ?? 0, changedBy: userId, reason: m.remarks ?? null },
            });
          }
          entered++;
        }
      });

      res.status(201).json({ entered, examSubjectId: data.examSubjectId });
    } catch (e: unknown) {
      const status = (e as { status?: number }).status;
      if (status) { problem(res, status, 'validation-error', 'Invalid Input', (e as Error).message); return; }
      if (e instanceof z.ZodError) { problem(res, 400, 'validation-error', 'Invalid Input', e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')); return; }
      problem(res, 500, 'internal-error', 'Server Error', (e as Error).message);
    }
  });

  // ── Publication workflow (2.6.5): ENTRY → SUBMITTED → VERIFIED → PUBLISHED ──
  // Each transition records who decided it; PUBLISHED stamps publishedAt/by.
  router.post('/examinations/:id/status', async (req: Request, res: Response) => {
    try {
      const { branchId, userId } = ctx(req);
      if (!branchId) { problem(res, 403, 'authorization-error', 'Forbidden', 'Account has no branch.'); return; }
      const data = statusSchema.parse(req.body);

      const exam = await prisma.examination.findFirst({ where: { id: req.params.id, branchId } });
      if (!exam) { problem(res, 404, 'not-found', 'Not Found', 'Examination not found.'); return; }

      const allowed: Record<string, string> = { ENTRY: 'SUBMITTED', SUBMITTED: 'VERIFIED', VERIFIED: 'PUBLISHED' };
      if (allowed[exam.status] !== data.status) {
        problem(res, 409, 'conflict', 'Conflict', `Cannot move from ${exam.status} to ${data.status}.`);
        return;
      }
      if (data.status === 'PUBLISHED') {
        // Publishing without any entered marks is the classic scandal (2.6.5).
        const count = await prisma.examResult.count({ where: { examSubject: { examinationId: exam.id } } });
        if (count === 0) {
          problem(res, 409, 'conflict', 'Conflict', 'Cannot publish an examination with no entered marks.');
          return;
        }
      }

      const updated = await prisma.examination.update({
        where: { id: exam.id },
        data: {
          status: data.status,
          ...(data.status === 'PUBLISHED' && { publishedAt: new Date(), publishedBy: userId }),
        },
      });
      res.json(updated);
    } catch (e) {
      if (e instanceof z.ZodError) { problem(res, 400, 'validation-error', 'Invalid Input', e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')); return; }
      problem(res, 500, 'internal-error', 'Server Error', (e as Error).message);
    }
  });

  // ── Grading + report card aggregation ──
  // Published results are aggregated per student: subject marks → %, then the
  // branch's grading scheme maps % → grade. Unpublished data never leaves
  // this endpoint — 404 unless the exam is PUBLISHED.
  router.get('/report-card/:examinationId/:studentId', async (req: Request, res: Response) => {
    try {
      const { branchId } = ctx(req);
      if (!branchId) { problem(res, 403, 'authorization-error', 'Forbidden', 'Account has no branch.'); return; }

      const exam = await prisma.examination.findFirst({
        where: { id: req.params.examinationId, branchId },
        include: { subjects: { include: { subject: { select: { name: true, code: true } } } } },
      });
      if (!exam) { problem(res, 404, 'not-found', 'Not Found', 'Examination not found.'); return; }
      if (exam.status !== 'PUBLISHED') {
        // Deliberately 404, not 403: a 403 confirms the exam exists.
        problem(res, 404, 'not-found', 'Not Found', 'Report card is not available.');
        return;
      }

      const student = await prisma.student.findFirst({
        where: { id: req.params.studentId, branchId },
        include: { enrollments: { orderBy: { fromDate: 'desc' }, take: 1, include: { class: { select: { name: true } }, section: { select: { name: true } } } } },
      });
      if (!student) { problem(res, 404, 'not-found', 'Not Found', 'Student not found.'); return; }

      const results = await prisma.examResult.findMany({
        where: { studentId: student.id, examSubject: { examinationId: exam.id } },
        include: { examSubject: { include: { subject: { select: { name: true, code: true } } } } },
      });

      const scheme = await prisma.gradingScheme.findFirst({
        where: { branchId, academicYearId: exam.academicYearId, isActive: true, isDefault: true },
        include: { bands: { orderBy: { minPercent: 'desc' } } },
      });

      let totalMarks = 0, totalMax = 0;
      const subjects = exam.subjects.map((es) => {
        const result = results.find((r) => r.examSubjectId === es.id);
        const max = es.maxMarks;
        const obtained = result && !result.isAbsent && !result.isExempt ? Number(result.marksObtained) : null;
        if (obtained != null) { totalMarks += obtained; totalMax += max; }
        const percent = obtained != null && max > 0 ? (obtained / max) * 100 : null;
        const band = percent != null && scheme
          ? scheme.bands.find((b) => percent >= Number(b.minPercent) && percent <= Number(b.maxPercent))
          : undefined;
        return {
          subject: es.subject.name,
          code: es.subject.code,
          maxMarks: max,
          passingMarks: es.passingMarks,
          marksObtained: obtained,
          percent: percent != null ? Math.round(percent * 100) / 100 : null,
          grade: band?.grade ?? null,
          isAbsent: result?.isAbsent ?? false,
          isExempt: result?.isExempt ?? false,
        };
      });

      const overallPercent = totalMax > 0 ? Math.round((totalMarks / totalMax) * 10000) / 100 : null;
      const overallBand = overallPercent != null && scheme
        ? scheme.bands.find((b) => overallPercent >= Number(b.minPercent) && overallPercent <= Number(b.maxPercent))
        : undefined;

      res.json({
        data: {
          examination: { id: exam.id, name: exam.name, publishedAt: exam.publishedAt },
          student: {
            id: student.id,
            name: `${student.firstName} ${student.lastName}`,
            admissionNo: student.admissionNo,
            class: student.enrollments[0]?.class.name ?? null,
            section: student.enrollments[0]?.section.name ?? null,
          },
          subjects,
          total: { marks: totalMarks, maxMarks: totalMax, percent: overallPercent, grade: overallBand?.grade ?? null },
        },
      });
    } catch (e) { problem(res, 500, 'internal-error', 'Server Error', (e as Error).message); }
  });

  // Mark-entry audit trail for an exam subject.
  router.get('/marks/:examSubjectId/audit', async (req: Request, res: Response) => {
    try {
      const { branchId } = ctx(req);
      if (!branchId) { problem(res, 403, 'authorization-error', 'Forbidden', 'Account has no branch.'); return; }
      const audits = await prisma.markEntryAudit.findMany({
        where: { examResult: { examSubject: { id: req.params.examSubjectId, examination: { branchId } } } },
        orderBy: { createdAt: 'desc' },
        take: 500,
      });
      res.json({ data: audits });
    } catch (e) { problem(res, 500, 'internal-error', 'Server Error', (e as Error).message); }
  });

  const assertion = requireAssertion(env.INTERNAL_ASSERTION_PUBLIC_KEY, SERVICE_NAME);
  app.use('/', assertion, router);

  app.use((req, res) => {
    res.status(404).json({ type: 'not-found', title: 'Not Found', status: 404, detail: `No route matches ${req.method} ${req.path} on ${SERVICE_NAME}.` });
  });
  app.use((err: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = err.status ?? 500;
    res.status(status).json({ type: 'internal-error', title: status === 500 ? 'Internal Server Error' : 'Request Failed', status, detail: (err as Error).message });
  });

  return app;
}
