// ──────────────────────────────────────────────
// Parent CRUD Routes
// ──────────────────────────────────────────────

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { PrismaClient } from '@school-erp/database';
import { ctx } from '@school-erp/auth';

const router = Router();

// GET /parents/me/children-summary — logged-in parent (must be before /:id)
router.get('/me/children-summary', async (req: Request, res: Response) => {
  try {
    const prisma: PrismaClient = req.app.get('prisma');
    const { userId } = ctx(req);
    const { email: userEmail } = ctx(req);
    if (!userId) {
      res.status(401).json({ detail: 'Unauthorized' });
      return;
    }

    let parent = await prisma.parent.findFirst({
      where: { userId },
      include: {
        students: {
          where: { isActive: true },
          include: {
            class: { select: { name: true } },
            section: { select: { name: true } },
            examResults: {
              take: 20,
              orderBy: { createdAt: 'desc' },
              include: { examSubject: { include: { subject: { select: { name: true } } } } },
            },
            feeInvoices: { where: { status: { in: ['PENDING', 'PARTIAL', 'OVERDUE'] } }, take: 5 },
            bookIssues: { where: { status: 'ISSUED' }, include: { book: { select: { title: true } } } },
          },
        },
      },
    });

    if (!parent && userEmail) {
      const usernamePart = userEmail.split('@')[0] || '';
      const inferredFatherName = usernamePart
        .replace(/[._-]+/g, ' ')
        .trim()
        .replace(/\b\w/g, (ch) => ch.toUpperCase());

      const fallback = await prisma.parent.findFirst({
        where: {
          OR: [
            { fatherEmail: { equals: userEmail, mode: 'insensitive' } },
            ...(inferredFatherName ? [{ fatherName: { equals: inferredFatherName, mode: 'insensitive' as const } }] : []),
          ],
          students: { some: { isActive: true } },
        },
        include: {
          students: {
            where: { isActive: true },
            include: {
              class: { select: { name: true } },
              section: { select: { name: true } },
              examResults: {
                take: 20,
                orderBy: { createdAt: 'desc' },
                include: { examSubject: { include: { subject: { select: { name: true } } } } },
              },
              feeInvoices: { where: { status: { in: ['PENDING', 'PARTIAL', 'OVERDUE'] } }, take: 5 },
              bookIssues: { where: { status: 'ISSUED' }, include: { book: { select: { title: true } } } },
            },
          },
        },
      });

      if (fallback) {
        if (!fallback.userId) {
          await prisma.parent.update({
            where: { id: fallback.id },
            data: { userId },
          });
        }
        parent = await prisma.parent.findFirst({
          where: { id: fallback.id },
          include: {
            students: {
              where: { isActive: true },
              include: {
                class: { select: { name: true } },
                section: { select: { name: true } },
                examResults: {
                  take: 20,
                  orderBy: { createdAt: 'desc' },
                  include: { examSubject: { include: { subject: { select: { name: true } } } } },
                },
                feeInvoices: { where: { status: { in: ['PENDING', 'PARTIAL', 'OVERDUE'] } }, take: 5 },
                bookIssues: { where: { status: 'ISSUED' }, include: { book: { select: { title: true } } } },
              },
            },
          },
        });
      }
    }

    if (!parent) {
      res.status(404).json({ detail: 'Parent profile not linked to this account.' });
      return;
    }

    const primary = parent.students[0];
    let attendancePct = 0;
    if (primary) {
      const total = await prisma.attendance.count({ where: { studentId: primary.id } });
      const present = await prisma.attendance.count({ where: { studentId: primary.id, status: { in: ['PRESENT', 'LATE'] } } });
      attendancePct = total > 0 ? Math.round((present / total) * 100) : 0;
    }

    const pendingFees = parent.students.reduce(
      (sum, s) => sum + s.feeInvoices.reduce((a, inv) => a + Math.max(0, Number(inv.totalAmount) - Number(inv.paidAmount)), 0),
      0,
    );

    res.json({
      parent: { id: parent.id, fatherName: parent.fatherName, motherName: parent.motherName },
      students: parent.students,
      stats: {
        attendancePct,
        pendingFees,
        booksIssued: parent.students.reduce((n, s) => n + s.bookIssues.length, 0),
      },
    });
  } catch (error) {
    res.status(500).json({ type: 'internal-error', title: 'Server Error', status: 500, detail: (error as Error).message });
  }
});

const createParentSchema = z.object({
  fatherName: z.string().min(1),
  fatherPhone: z.string().min(10),
  fatherEmail: z.string().email().optional(),
  fatherOccupation: z.string().optional(),
  motherName: z.string().min(1),
  motherPhone: z.string().optional(),
  motherEmail: z.string().email().optional(),
  motherOccupation: z.string().optional(),
  guardianName: z.string().optional(),
  guardianPhone: z.string().optional(),
  address: z.string().min(1),
});

// ── GET /parents ──
router.get('/', async (req: Request, res: Response) => {
  try {
    const prisma: PrismaClient = req.app.get('prisma');
    const { cursor, limit = '20', search } = req.query;
    const take = Math.min(parseInt(limit as string), 100);

    const where: any = {};
    if (search) {
      where.OR = [
        { fatherName: { contains: search as string, mode: 'insensitive' } },
        { motherName: { contains: search as string, mode: 'insensitive' } },
        { fatherPhone: { contains: search as string } },
      ];
    }

    const parents = await prisma.parent.findMany({
      where,
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor as string }, skip: 1 } : {}),
      include: { students: { select: { firstName: true, lastName: true, admissionNo: true } } },
      orderBy: { createdAt: 'desc' },
    });

    const hasMore = parents.length > take;
    const data = hasMore ? parents.slice(0, take) : parents;

    res.json({
      data,
      meta: { total: await prisma.parent.count({ where }), limit: take, cursor: data.length > 0 ? data[data.length - 1].id : null, hasMore },
    });
  } catch (error) {
    res.status(500).json({ type: 'internal-error', title: 'Server Error', status: 500, detail: (error as Error).message });
  }
});

// ── POST /parents ──
router.post('/', async (req: Request, res: Response) => {
  try {
    const data = createParentSchema.parse(req.body);
    const prisma: PrismaClient = req.app.get('prisma');
    const parent = await prisma.parent.create({ data });
    res.status(201).json(parent);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ type: 'validation-error', title: 'Invalid Input', status: 400, errors: error.flatten().fieldErrors });
      return;
    }
    res.status(500).json({ type: 'internal-error', title: 'Server Error', status: 500, detail: (error as Error).message });
  }
});

// ── GET /parents/:id ──
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const prisma: PrismaClient = req.app.get('prisma');
    const parent = await prisma.parent.findUnique({
      where: { id: req.params.id },
      include: { students: { include: { class: { select: { name: true } }, section: { select: { name: true } } } } },
    });
    if (!parent) { res.status(404).json({ type: 'not-found', title: 'Parent Not Found', status: 404 }); return; }
    res.json(parent);
  } catch (error) {
    res.status(500).json({ type: 'internal-error', title: 'Server Error', status: 500, detail: (error as Error).message });
  }
});

// ── PUT /parents/:id ──
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const prisma: PrismaClient = req.app.get('prisma');
    const parent = await prisma.parent.update({ where: { id: req.params.id }, data: req.body });
    res.json(parent);
  } catch (error) {
    res.status(500).json({ type: 'internal-error', title: 'Server Error', status: 500, detail: (error as Error).message });
  }
});

export { router as parentRoutes };
