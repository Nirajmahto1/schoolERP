// ──────────────────────────────────────────────
// School ERP — Academic Service
// ──────────────────────────────────────────────

import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import dotenv from 'dotenv';
import { PrismaClient } from '@school-erp/database';
import { logger } from './utils/logger';
import { ctx } from '@school-erp/auth';

dotenv.config({ path: '../../.env' });

const app = express();
const prisma = new PrismaClient();
const PORT = process.env.PORT_ACADEMIC_SERVICE || 4003;

app.use(cors());
app.use(express.json());
app.use(morgan('combined', { stream: { write: (msg) => logger.info(msg.trim()) } }));
app.set('prisma', prisma);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'academic-service', timestamp: new Date().toISOString() });
});

// ── Academic Years ──
app.get('/academic-years', async (req, res) => {
  try {
    const { branchId } = ctx(req);
    const years = await prisma.academicYear.findMany({ where: { branchId }, orderBy: { startDate: 'desc' } });
    res.json({ data: years });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

app.post('/academic-years', async (req, res) => {
  try {
    const { branchId } = ctx(req);
    const year = await prisma.academicYear.create({ data: { ...req.body, branchId } });
    res.status(201).json(year);
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

// ── Classes ──
app.get('/classes', async (req, res) => {
  try {
    const { branchId } = ctx(req);
    const classes = await prisma.class.findMany({
      where: { branchId },
      include: { sections: true, subjects: true, _count: { select: { students: true } } },
      orderBy: { numericOrder: 'asc' },
    });
    res.json({ data: classes });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

app.post('/classes', async (req, res) => {
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

app.delete('/classes/:id', async (req, res) => {
  try {
    await prisma.class.delete({ where: { id: req.params.id } });
    res.json({ message: 'Class deleted' });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

// ── Sections ──
app.get('/sections', async (req, res) => {
  try {
    const { classId } = req.query;
    const sections = await prisma.section.findMany({
      where: { ...(classId && { classId: classId as string }) },
      include: { _count: { select: { students: true } } },
    });
    res.json({ data: sections });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

app.post('/sections', async (req, res) => {
  try {
    const section = await prisma.section.create({ data: req.body });
    res.status(201).json(section);
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

app.delete('/sections/:id', async (req, res) => {
  try {
    await prisma.section.delete({ where: { id: req.params.id } });
    res.json({ message: 'Section deleted' });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

// ── Subjects ──
app.get('/subjects', async (req, res) => {
  try {
    const { classId } = req.query;
    const subjects = await prisma.subject.findMany({
      where: { ...(classId && { classId: classId as string }) },
      include: { teachers: { include: { staff: { select: { firstName: true, lastName: true, id: true } } } }, class: { select: { name: true } } },
    });
    res.json({ data: subjects });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

app.post('/subjects', async (req, res) => {
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

app.delete('/subjects/:id', async (req, res) => {
  try {
    await prisma.subject.delete({ where: { id: req.params.id } });
    res.json({ message: 'Subject deleted' });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

// ── Subject-Teacher Assignment ──
app.post('/subject-teachers', async (req, res) => {
  try {
    const assignment = await prisma.subjectTeacher.create({ data: req.body });
    res.status(201).json(assignment);
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

app.delete('/subject-teachers/:id', async (req, res) => {
  try {
    await prisma.subjectTeacher.delete({ where: { id: req.params.id } });
    res.json({ message: 'Assignment removed' });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

// ── Examinations ──
app.get('/examinations', async (req, res) => {
  try {
    const { branchId } = ctx(req);
    const exams = await prisma.examination.findMany({
      where: { branchId },
      include: { subjects: { include: { subject: true } } },
      orderBy: { startDate: 'desc' },
    });
    res.json({ data: exams });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

app.post('/examinations', async (req, res) => {
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

app.delete('/examinations/:id', async (req, res) => {
  try {
    await prisma.examination.delete({ where: { id: req.params.id } });
    res.json({ message: 'Examination deleted' });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

// ── Exam Results ──
app.post('/exam-results', async (req, res) => {
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

app.get('/exam-results/:examinationId', async (req, res) => {
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
app.get('/library/books', async (req, res) => {
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

app.post('/library/issue', async (req, res) => {
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

app.post('/library/return/:id', async (req, res) => {
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

process.on('SIGTERM', async () => { await prisma.$disconnect(); process.exit(0); });
app.listen(PORT, () => console.log(`📖 Academic Service running on http://localhost:${PORT}`));
export { app, prisma };
