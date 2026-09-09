// ──────────────────────────────────────────────
// Parent/Guardian Routes
//
// Phase 2 shape: guardians are people (Guardian), linked to students through
// StudentGuardian (relation, isPrimary, portal access). One guardian row per
// person — shared across siblings — and a guardian may or may not have a
// portal login (User).
// ──────────────────────────────────────────────

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { PrismaClient } from '@school-erp/database';
import type { InvoiceStatus } from '@prisma/client';
import { ctx } from '@school-erp/auth';

const OPEN_INVOICE_STATUSES: InvoiceStatus[] = ['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'];

const router = Router();

/** Include tree used by every children-summary response. */
function childrenInclude() {
  return {
    student: {
      include: {
        enrollments: {
          orderBy: { fromDate: 'desc' as const },
          take: 1,
          include: {
            class: { select: { name: true } },
            section: { select: { name: true } },
          },
        },
        examResults: {
          take: 20,
          orderBy: { createdAt: 'desc' as const },
          include: { examSubject: { include: { subject: { select: { name: true } } } } },
        },
        invoices: {
          where: { status: { in: OPEN_INVOICE_STATUSES }, deletedAt: null },
          take: 5,
        },
        bookIssues: { where: { status: 'ISSUED' }, include: { book: { select: { title: true } } } },
      },
    },
  };
}

type StudentGuardianWithStudent = {
  student: {
    id: string;
    firstName: string;
    lastName: string;
    admissionNo: string;
    deletedAt: Date | null;
    enrollments: Array<{ class: { name: string }; section: { name: string } }>;
    examResults: unknown[];
    invoices: Array<{ totalAmount: unknown; paidAmount: unknown }>;
    bookIssues: unknown[];
  };
};

// GET /parents/me/children-summary — logged-in guardian (must be before /:id)
router.get('/me/children-summary', async (req: Request, res: Response) => {
  try {
    const prisma: PrismaClient = req.app.get('prisma');
    const { userId } = ctx(req);
    if (!userId) {
      res.status(401).json({ detail: 'Unauthorized' });
      return;
    }

    const links = (await prisma.studentGuardian.findMany({
      where: { guardian: { userId } },
      include: childrenInclude(),
    })) as unknown as StudentGuardianWithStudent[];

    const students = links
      .map((l) => l.student)
      .filter((s) => s.deletedAt === null);

    if (students.length === 0) {
      res.status(404).json({ detail: 'No children are linked to this account.' });
      return;
    }

    const primary = students[0];
    let attendancePct = 0;
    if (primary) {
      const agg = await prisma.attendanceMonthlySummary.aggregate({
        where: { studentId: primary.id },
        _sum: { workingDays: true, presentDays: true, lateDays: true, halfDays: true },
      });
      const workingDays = Number(agg._sum.workingDays ?? 0);
      const attended =
        Number(agg._sum.presentDays ?? 0) +
        Number(agg._sum.lateDays ?? 0) +
        Number(agg._sum.halfDays ?? 0);
      attendancePct = workingDays > 0 ? Math.round((attended / workingDays) * 100) : 0;
    }

    const pendingFees = students.reduce(
      (sum, s) =>
        sum +
        s.invoices.reduce(
          (a, inv) => a + Math.max(0, Number(inv.totalAmount) - Number(inv.paidAmount)),
          0,
        ),
      0,
    );

    res.json({
      students: students.map((s) => ({
        id: s.id,
        firstName: s.firstName,
        lastName: s.lastName,
        admissionNo: s.admissionNo,
        className: s.enrollments[0]?.class.name ?? null,
        sectionName: s.enrollments[0]?.section.name ?? null,
        recentResults: s.examResults,
        bookIssues: s.bookIssues,
      })),
      stats: {
        attendancePct,
        pendingFees,
        booksIssued: students.reduce((n, s) => n + s.bookIssues.length, 0),
      },
    });
  } catch (error) {
    res.status(500).json({ type: 'internal-error', title: 'Server Error', status: 500, detail: (error as Error).message });
  }
});

const createGuardianSchema = z.object({
  fullName: z.string().min(1),
  phone: z.string().min(10),
  email: z.string().email().optional(),
  occupation: z.string().optional(),
});

// ── GET /parents ── (guardian directory)
router.get('/', async (req: Request, res: Response) => {
  try {
    const prisma: PrismaClient = req.app.get('prisma');
    const { cursor, limit = '20', search } = req.query;
    const take = Math.min(parseInt(limit as string), 100);

    const where: any = {};
    if (search) {
      where.OR = [
        { fullName: { contains: search as string, mode: 'insensitive' } },
        { phone: { contains: search as string } },
        { email: { contains: search as string } },
      ];
    }

    const guardians = await prisma.guardian.findMany({
      where,
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor as string }, skip: 1 } : {}),
      include: {
        students: { include: { student: { select: { firstName: true, lastName: true, admissionNo: true } } } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const hasMore = guardians.length > take;
    const data = hasMore ? guardians.slice(0, take) : guardians;

    res.json({
      data,
      meta: {
        total: await prisma.guardian.count({ where }),
        limit: take,
        cursor: data.length > 0 ? data[data.length - 1].id : null,
        hasMore,
      },
    });
  } catch (error) {
    res.status(500).json({ type: 'internal-error', title: 'Server Error', status: 500, detail: (error as Error).message });
  }
});

// ── POST /parents ──
router.post('/', async (req: Request, res: Response) => {
  try {
    const data = createGuardianSchema.parse(req.body);
    const prisma: PrismaClient = req.app.get('prisma');
    const guardian = await prisma.guardian.create({ data });
    res.status(201).json(guardian);
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
    const guardian = await prisma.guardian.findUnique({
      where: { id: req.params.id },
      include: {
        students: {
          include: {
            student: {
              include: {
                enrollments: {
                  orderBy: { fromDate: 'desc' },
                  take: 1,
                  include: { class: { select: { name: true } }, section: { select: { name: true } } },
                },
              },
            },
          },
        },
      },
    });
    if (!guardian) { res.status(404).json({ type: 'not-found', title: 'Guardian Not Found', status: 404 }); return; }
    res.json(guardian);
  } catch (error) {
    res.status(500).json({ type: 'internal-error', title: 'Server Error', status: 500, detail: (error as Error).message });
  }
});

// ── PUT /parents/:id ──
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const prisma: PrismaClient = req.app.get('prisma');
    // Only Guardian columns are writable through this route; the link table
    // (StudentGuardian) is managed by student admission flows.
    const { student, students, userId, id, createdAt, ...data } = req.body ?? {};
    void student; void students; void userId; void id; void createdAt;
    const guardian = await prisma.guardian.update({ where: { id: req.params.id }, data });
    res.json(guardian);
  } catch (error) {
    res.status(500).json({ type: 'internal-error', title: 'Server Error', status: 500, detail: (error as Error).message });
  }
});

export { router as parentRoutes };
