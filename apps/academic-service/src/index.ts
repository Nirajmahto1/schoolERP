// ──────────────────────────────────────────────
// School ERP — Academic Service
// ──────────────────────────────────────────────

import { Router } from 'express';
import { PrismaClient } from '@school-erp/database';
import { loadServiceEnv } from '@school-erp/config';
import { createServiceApp, listenWithGracefulShutdown, ctx } from '@school-erp/auth';
import { buildOpenApiDocument } from '@school-erp/http';
import { logger } from './utils/logger';

/** MUST equal the gateway route-table audience for this service. */
const SERVICE_NAME = 'academic-service';

export interface AcademicAppOptions {
  env: { INTERNAL_ASSERTION_PUBLIC_KEY: string };
  prisma: PrismaClient;
}

/**
 * App factory — split from the entrypoint so tests can inject a Prisma
 * client and an explicit env without booting the real process.
 */
export function createAcademicApp(options: AcademicAppOptions) {
  const { prisma } = options;
  const env = { INTERNAL_ASSERTION_PUBLIC_KEY: options.env.INTERNAL_ASSERTION_PUBLIC_KEY };

  const { app, mount, finalize } = createServiceApp({
    serviceName: SERVICE_NAME,
    assertionPublicKey: env.INTERNAL_ASSERTION_PUBLIC_KEY,
    onLog: (msg: string) => logger.info(msg),
    readinessCheck: async () => { await prisma.$queryRaw`SELECT 1`; },
  });

  app.set('prisma', prisma);

  // Published contract (GATE 3).
  const openapi = buildOpenApiDocument({
    title: 'Academic Service',
    description: 'Academic years, classes, sections, subjects, teacher allocation, timetable, and calendar.',
    version: '1.0.0',
    basePath: '/academics',
    paths: {
      '/academic-years': {
        get: { summary: 'List academic years', tags: ['years'], responses: { '200': { description: 'OK' } } },
        post: { summary: 'Create an academic year', tags: ['years'], responses: { '201': { description: 'Created' } } },
      },
      '/classes': {
        get: { summary: 'List classes with sections and enrollment counts', tags: ['classes'], responses: { '200': { description: 'OK' } } },
        post: { summary: 'Create a class (optionally with sections)', tags: ['classes'], responses: { '201': { description: 'Created' } } },
      },
      '/sections': {
        get: { summary: 'List sections (filter by classId)', tags: ['sections'], responses: { '200': { description: 'OK' } } },
        post: { summary: 'Create a section', tags: ['sections'], responses: { '201': { description: 'Created' } } },
      },
      '/subjects': {
        get: { summary: 'List subjects (filter by classId)', tags: ['subjects'], responses: { '200': { description: 'OK' } } },
        post: { summary: 'Create a subject', tags: ['subjects'], responses: { '201': { description: 'Created' } } },
      },
      '/subject-teachers': {
        post: { summary: 'Allocate a teacher to a subject', tags: ['allocation'], responses: { '201': { description: 'Created' } } },
        delete: { summary: 'Remove an allocation', tags: ['allocation'], responses: { '200': { description: 'Removed' } } },
      },
      '/timetable': { get: { summary: 'Timetable for a section', tags: ['timetable'], responses: { '200': { description: 'OK' } } } },
      '/timetable/slots': {
        post: { summary: 'Create a slot (409 on teacher clash)', tags: ['timetable'], responses: { '201': { description: 'Created' }, '409': { description: 'Teacher clash' } } },
        delete: { summary: 'Delete a slot', tags: ['timetable'], responses: { '200': { description: 'Deleted' } } },
      },
      '/calendar': {
        get: { summary: 'Academic calendar for a year', tags: ['calendar'], responses: { '200': { description: 'OK' } } },
        post: { summary: 'Add a calendar entry (holiday/exam/event)', tags: ['calendar'], responses: { '201': { description: 'Created' } } },
      },
      '/examinations': {
        get: { summary: 'List examinations (see exam-service for the full API)', tags: ['exams'], responses: { '200': { description: 'OK' } } },
        post: { summary: 'Create an examination', tags: ['exams'], responses: { '201': { description: 'Created' } } },
      },
      '/library/books': { get: { summary: 'Search library books', tags: ['library'], responses: { '200': { description: 'OK' } } } },
      '/library/issue': { post: { summary: 'Issue a book', tags: ['library'], responses: { '201': { description: 'Issued' } } } },
      '/library/return/{id}': { post: { summary: 'Return a book (fine computed)', tags: ['library'], responses: { '200': { description: 'Returned' } } } },
    },
  });
  app.get('/openapi.json', (_req, res) => { res.json(openapi); });

const r = Router();

// ── Academic Years ──
r.get('/academic-years', async (req, res) => {
  try {
    const { branchId } = ctx(req);
    if (!branchId) {
      res.status(403).json({ detail: 'Account has no branch — cannot list academic years.' });
      return;
    }
    const years = await prisma.academicYear.findMany({ where: { branchId }, orderBy: { startDate: 'desc' } });
    res.json({ data: years });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

r.post('/academic-years', async (req, res) => {
  try {
    const { branchId } = ctx(req);
    const year = await prisma.academicYear.create({ data: { ...req.body, branchId } });
    res.status(201).json(year);
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

// ── Classes ──
r.get('/classes', async (req, res) => {
  try {
    const { branchId } = ctx(req);
    if (!branchId) {
      res.status(403).json({ detail: 'Account has no branch — cannot list classes.' });
      return;
    }
    const classes = await prisma.class.findMany({
      where: { branchId },
      include: { sections: true, subjects: true, _count: { select: { enrollments: true } } },
      orderBy: { numericOrder: 'asc' },
    });
    res.json({ data: classes });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

r.post('/classes', async (req, res) => {
  try {
    const { branchId } = ctx(req);
    const { sections, ...classData } = req.body;
    const cls = await prisma.class.create({
      data: {
        ...classData,
        branchId,
        sections: sections?.length ? { create: sections.map((s: any) => ({ name: s.name, capacity: s.capacity || 40 })) } : undefined,
      },
      include: { sections: true },
    });
    res.status(201).json(cls);
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

r.delete('/classes/:id', async (req, res) => {
  try {
    await prisma.class.delete({ where: { id: req.params.id } });
    res.json({ message: 'Class deleted' });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

// ── Sections ──
r.get('/sections', async (req, res) => {
  try {
    const { classId } = req.query;
    const sections = await prisma.section.findMany({
      where: { ...(classId && { classId: classId as string }) },
      include: { _count: { select: { enrollments: true } } },
    });
    res.json({ data: sections });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

r.post('/sections', async (req, res) => {
  try {
    const section = await prisma.section.create({ data: req.body });
    res.status(201).json(section);
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

r.delete('/sections/:id', async (req, res) => {
  try {
    await prisma.section.delete({ where: { id: req.params.id } });
    res.json({ message: 'Section deleted' });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

// ── Subjects ──
r.get('/subjects', async (req, res) => {
  try {
    const { classId } = req.query;
    const subjects = await prisma.subject.findMany({
      where: { ...(classId && { classId: classId as string }) },
      include: { teachers: { include: { staff: { select: { firstName: true, lastName: true, id: true } } } }, class: { select: { name: true } } },
    });
    res.json({ data: subjects });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

r.post('/subjects', async (req, res) => {
  try {
    const { hodStaffId, ...subjectData } = req.body;
    const subject = await prisma.subject.create({ data: subjectData });
    // Auto assign HOD as a SubjectTeacher
    if (hodStaffId) {
      await prisma.subjectTeacher.create({ data: { subjectId: subject.id, staffId: hodStaffId } });
    }
    res.status(201).json(subject);
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

r.delete('/subjects/:id', async (req, res) => {
  try {
    await prisma.subject.delete({ where: { id: req.params.id } });
    res.json({ message: 'Subject deleted' });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

// ── Subject-Teacher Assignment ──
r.post('/subject-teachers', async (req, res) => {
  try {
    const assignment = await prisma.subjectTeacher.create({ data: req.body });
    res.status(201).json(assignment);
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

r.delete('/subject-teachers/:id', async (req, res) => {
  try {
    await prisma.subjectTeacher.delete({ where: { id: req.params.id } });
    res.json({ message: 'Assignment removed' });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

// ── Examinations ──
r.get('/examinations', async (req, res) => {
  try {
    const { branchId } = ctx(req);
    if (!branchId) {
      res.status(403).json({ detail: 'Account has no branch — cannot list examinations.' });
      return;
    }
    const exams = await prisma.examination.findMany({
      where: { branchId },
      include: { subjects: { include: { subject: true } } },
      orderBy: { startDate: 'desc' },
    });
    res.json({ data: exams });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

r.post('/examinations', async (req, res) => {
  try {
    const { branchId } = ctx(req);
    const { examSubjects, ...examData } = req.body;
    const exam = await prisma.examination.create({
      data: {
        ...examData,
        branchId,
        subjects: examSubjects?.length ? {
          create: examSubjects.map((es: any) => ({
            subjectId: es.subjectId,
            examDate: new Date(es.examDate),
            startTime: es.startTime || '09:00',
            endTime: es.endTime || '12:00',
            maxMarks: es.maxMarks || 100,
            passingMarks: es.passingMarks || 33,
          }))
        } : undefined,
      },
      include: { subjects: { include: { subject: true } } },
    });
    res.status(201).json(exam);
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

r.delete('/examinations/:id', async (req, res) => {
  try {
    await prisma.examination.delete({ where: { id: req.params.id } });
    res.json({ message: 'Examination deleted' });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

// ── Exam Results ──
r.post('/exam-results', async (req, res) => {
  try {
    const raw = req.body.results as any[];
    if (!Array.isArray(raw)) {
      res.status(400).json({ detail: 'results must be an array' });
      return;
    }
    const results = raw.map((r) => ({
      examSubjectId: r.examSubjectId,
      studentId: r.studentId,
      marksObtained: r.marksObtained ?? r.marks ?? 0,
      grade: r.grade ?? null,
      remarks: r.remarks ?? null,
    }));
    const created = await prisma.examResult.createMany({ data: results, skipDuplicates: true });
    res.status(201).json({ count: created.count });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

r.get('/exam-results/:examinationId', async (req, res) => {
  try {
    const results = await prisma.examResult.findMany({
      where: { examSubject: { examinationId: req.params.examinationId } },
      include: {
        student: { select: { firstName: true, lastName: true, admissionNo: true } },
        examSubject: { include: { subject: { select: { name: true } } } },
      },
    });
    res.json({ data: results });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

// ── Library ──
r.get('/library/books', async (req, res) => {
  try {
    const { branchId } = ctx(req);
    const { search, category } = req.query;
    const where: any = { branchId };
    if (category) where.category = category;
    if (search) {
      where.OR = [
        { title: { contains: search as string, mode: 'insensitive' } },
        { author: { contains: search as string, mode: 'insensitive' } },
      ];
    }
    const books = await prisma.book.findMany({
      where,
      orderBy: { title: 'asc' },
    });
    const data = books.map(b => ({
      ...b,
      total: b.totalCopies,
      issued: b.totalCopies - b.availableCopies,
      available: b.availableCopies,
    }));
    res.json({ data });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

r.post('/library/issue', async (req, res) => {
  try {
    const { bookId, studentId, staffId, dueDate } = req.body;
    // Check availability
    const book = await prisma.book.findUnique({ where: { id: bookId } });
    if (!book || book.availableCopies <= 0) {
      res.status(400).json({ detail: 'Book not available for issue' });
      return;
    }
    const issue = await prisma.bookIssue.create({
      data: { bookId, studentId, dueDate: new Date(dueDate) },
    });
    // Decrement available copies
    await prisma.book.update({
      where: { id: bookId },
      data: { availableCopies: { decrement: 1 } },
    });
    res.status(201).json(issue);
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

r.post('/library/return/:id', async (req, res) => {
  try {
    const issue = await prisma.bookIssue.findUnique({ where: { id: req.params.id } });
    if (!issue || issue.status === 'RETURNED') {
      res.status(400).json({ detail: 'Invalid issue or already returned' });
      return;
    }
    // Calculate fine if overdue (₹5 per day)
    const now = new Date();
    let fine = 0;
    if (now > issue.dueDate) {
      const overdueDays = Math.ceil((now.getTime() - issue.dueDate.getTime()) / 86400000);
      fine = overdueDays * 5;
    }
    await prisma.bookIssue.update({
      where: { id: req.params.id },
      data: { returnDate: now, status: 'RETURNED', fine },
    });
    // Increment available copies
    await prisma.book.update({
      where: { id: issue.bookId },
      data: { availableCopies: { increment: 1 } },
    });
    res.json({ message: 'Book returned successfully', fine });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

r.get('/library/issues', async (req, res) => {
  try {
    const { branchId } = ctx(req);
    const { bookId } = req.query;
    const issues = await prisma.bookIssue.findMany({
      where: {
        status: 'ISSUED',
        ...(bookId && { bookId: bookId as string }),
        ...(branchId && { book: { branchId } }),
      },
      include: {
        book: { select: { title: true } },
        student: { select: { firstName: true, lastName: true, admissionNo: true } },
      },
      orderBy: { dueDate: 'asc' },
      take: 200,
    });
    res.json({ data: issues });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

// ── Timetable (BUILD_PLAN 3.3 + 2.7.6) ──
// Slot create enforces the teacher-clash rule: a teacher cannot be in two
// places at once, and cannot teach two sections in the same period.
r.post('/timetable/slots', async (req, res) => {
  try {
    const { staffId, day, startTime, endTime, sectionId, subjectId, room } = req.body ?? {};
    // staffId is optional (schema: String?) — unassigned slots are useful for
    // placeholder periods; the clash check below only applies when a teacher
    // is named.
    if (!day || !startTime || !endTime || !sectionId || !subjectId) {
      res.status(400).json({ type: 'validation-error', title: 'Invalid Input', status: 400, detail: 'day, startTime, endTime, sectionId and subjectId are required.' });
      return;
    }
    const slotSection = await prisma.section.findFirst({
      where: { id: sectionId },
      select: { class: { select: { branchId: true } } },
    });
    if (!slotSection) { res.status(404).json({ type: 'not-found', title: 'Not Found', status: 404, detail: 'Section not found.' }); return; }
    const { branchId } = ctx(req);
    const sectionBranch = slotSection.class.branchId;
    if (branchId && branchId !== sectionBranch) { res.status(404).json({ type: 'not-found', title: 'Not Found', status: 404, detail: 'Section not found.' }); return; }

    if (staffId) {
      const clash = await prisma.timetableSlot.findFirst({
        where: { staffId, day, startTime, sectionId: { not: sectionId } },
        select: { id: true, sectionId: true },
      });
      if (clash) {
        res.status(409).json({ type: 'conflict', title: 'Teacher Clash', status: 409, detail: `Teacher already has a slot at ${day} ${startTime} for another section.` });
        return;
      }
    }
    const slot = await prisma.timetableSlot.create({
      data: { staffId: staffId || null, day, startTime, endTime, sectionId, subjectId, room },
    });
    res.status(201).json(slot);
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

r.get('/timetable', async (req, res) => {
  try {
    const { sectionId } = req.query;
    if (!sectionId) { res.status(400).json({ detail: 'sectionId is required' }); return; }
    const slots = await prisma.timetableSlot.findMany({
      where: { sectionId: sectionId as string },
      include: {
        subject: { select: { name: true, code: true } },
        staff: { select: { firstName: true, lastName: true, employeeId: true } },
      },
      orderBy: [{ day: 'asc' }, { startTime: 'asc' }],
    });
    res.json({ data: slots });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

r.delete('/timetable/slots/:id', async (req, res) => {
  try {
    await prisma.timetableSlot.delete({ where: { id: req.params.id } });
    res.json({ message: 'Slot deleted' });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

// ── Academic calendar (BUILD_PLAN 2.7.6 / 3.3) ──
r.get('/calendar', async (req, res) => {
  try {
    const { branchId } = ctx(req);
    if (!branchId) { res.status(403).json({ detail: 'Account has no branch.' }); return; }
    const { academicYearId } = req.query;
    const year = academicYearId
      ? await prisma.academicYear.findFirst({ where: { id: academicYearId as string, branchId } })
      : await prisma.academicYear.findFirst({ where: { branchId, isCurrent: true } });
    if (!year) { res.status(404).json({ detail: 'No academic year.' }); return; }
    const entries = await prisma.academicCalendar.findMany({
      where: { branchId, academicYearId: year.id },
      orderBy: { date: 'asc' },
    });
    res.json({ data: entries });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

r.post('/calendar', async (req, res) => {
  try {
    const { branchId, userId } = ctx(req);
    if (!branchId) { res.status(403).json({ detail: 'Account has no branch.' }); return; }
    const { date, type, title, description, isHoliday } = req.body ?? {};
    if (!date || !type || !title) {
      res.status(400).json({ type: 'validation-error', title: 'Invalid Input', status: 400, detail: 'date, type and title are required.' });
      return;
    }
    const year = await prisma.academicYear.findFirst({ where: { branchId, isCurrent: true } });
    if (!year) { res.status(400).json({ detail: 'Branch has no current academic year.' }); return; }
    const entry = await prisma.academicCalendar.create({
      data: {
        branchId,
        academicYearId: year.id,
        date: new Date(date),
        // The calendar distinguishes working days from holidays; an entry
        // created via this route is a holiday/exam/event marker.
        type: isHoliday ? 'HOLIDAY' : (type as never),
        title,
        description,
        isWorkingDay: !isHoliday,
      },
    });
    res.status(201).json(entry);
    void description; void userId;
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

  mount('/', r);
  finalize();

  return app;
}

// ── Entrypoint ──
const env = loadServiceEnv(SERVICE_NAME, 'PORT_ACADEMIC_SERVICE');
const prisma = new PrismaClient();
const app = createAcademicApp({ env, prisma });

// Only bind a port when run directly. Imported by tests or the e2e suite,
// the module must NOT listen — vitest would hit EADDRINUSE across suites.
if (process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js')) {
  listenWithGracefulShutdown(app, env.PORT, SERVICE_NAME, async () => { await prisma.$disconnect(); });
}

export { app, prisma };
