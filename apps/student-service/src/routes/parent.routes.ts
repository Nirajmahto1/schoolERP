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
import { ctx, encryptField, decryptField, isEncryptedField } from '@school-erp/auth';

const OPEN_INVOICE_STATUSES: InvoiceStatus[] = ['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'];
/** What the app's fees screen shows: open dues PLUS settled ones (their
 * receipts are the point — a parent must be able to open REC-xxxxx). */
const VISIBLE_INVOICE_STATUSES: InvoiceStatus[] = [...OPEN_INVOICE_STATUSES, 'PAID'];

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
            class: { select: { id: true, name: true } },
            section: { select: { id: true, name: true } },
          },
        },
        examResults: {
          take: 20,
          orderBy: { createdAt: 'desc' as const },
          include: { examSubject: { include: { subject: { select: { name: true } } } } },
        },
        invoices: {
          where: { status: { in: VISIBLE_INVOICE_STATUSES }, deletedAt: null },
          take: 12,
          orderBy: { dueDate: 'desc' as const },
          // Successful payments ride along so the app can offer the numbered
          // receipt per invoice (the receipt PDF route keys off payment id).
          include: { payments: { where: { status: 'SUCCESS' as const }, select: { id: true, receiptNo: true, method: true, createdAt: true }, orderBy: { createdAt: 'desc' as const } } },
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
    enrollments: Array<{ class: { id: string; name: string }; section: { id: string; name: string } }>;
    examResults: unknown[];
    invoices: Array<{
      id: string;
      invoiceNo: string;
      status: string;
      dueDate: Date;
      totalAmount: unknown;
      paidAmount: unknown;
      lines?: Array<{ feeHead?: { name: string } | null }> | unknown[];
      payments?: Array<{ id: string; receiptNo: string | null; method: string; createdAt: Date }>;
    }>;
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

    let students = links
      .map((l) => l.student)
      .filter((s) => s.deletedAt === null);

    // Self-resolution (student portal): a STUDENT account has no guardian
    // links — the caller IS the child. Same summary shape, one row, so the
    // mobile student shell (dashboard, fees, chat) reuses the parent screens
    // untouched.
    if (students.length === 0 && ctx(req).roles.includes('STUDENT')) {
      const self = (await prisma.student.findFirst({
        where: { userId, deletedAt: null },
        include: childrenInclude().student.include,
      })) as unknown as StudentGuardianWithStudent['student'] | null;
      if (self) students = [self];
    }

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

    // Photos are scalar columns — fetched in one shot for the summary rows.
    const photoMap = new Map(
      (
        await prisma.student.findMany({
          where: { id: { in: students.map((s) => s.id) } },
          select: { id: true, photo: true },
        })
      ).map((p) => [p.id, p.photo]),
    );

    const pendingFees = students.reduce(
      (sum, s) =>
        sum +
        s.invoices
          .filter((inv) => (OPEN_INVOICE_STATUSES as string[]).includes(inv.status))
          .reduce(
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
        // Gateway-relative; the apps resolve it against /api/v1/photos (auth'd).
        photoUrl: photoMap.get(s.id) ?? null,
        className: s.enrollments[0]?.class.name ?? null,
        sectionName: s.enrollments[0]?.section.name ?? null,
        // Stable ids for the student shell: the fees checkout (studentId) and
        // the class chat room (classId + sectionId) both key off these.
        classId: s.enrollments[0]?.class.id ?? null,
        sectionId: s.enrollments[0]?.section.id ?? null,
        recentResults: s.examResults,
        // Open dues PER CHILD — the parent app's fees screen renders this
        // list; the aggregate stats.pendingFees alone cannot (it is summed
        // across children). PAID invoices are included so the app can offer
        // their receipts; `openInvoices` is the established wire name.
        // Shape matches the checkout client: totalAmount, paidAmount,
        // outstanding computed client-side for display only — the ORDER
        // amount is still computed server-side at /checkout/orders.
        dueAmount: s.invoices
          .filter((inv) => (OPEN_INVOICE_STATUSES as string[]).includes(inv.status))
          .reduce((a, inv) => a + Math.max(0, Number((inv as any).totalAmount) - Number((inv as any).paidAmount)), 0),
        openInvoices: s.invoices.map((inv) => ({
          id: inv.id,
          invoiceNo: inv.invoiceNo,
          type: (inv.lines as Array<{ feeHead?: { name: string } | null }> | undefined)?.[0]?.feeHead?.name ?? 'School Fee',
          status: inv.status,
          dueDate: inv.dueDate,
          totalAmount: Number(inv.totalAmount),
          paidAmount: Number(inv.paidAmount),
          outstanding: Math.max(0, Number(inv.totalAmount) - Number(inv.paidAmount)),
          // Newest successful payment first — the receipt viewer opens
          // `receipts[0].id`.
          receipts: (inv.payments ?? []).map((p) => ({ id: p.id, receiptNo: p.receiptNo, method: p.method, paidAt: p.createdAt })),
        })),
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
    // Decrypt phone for the response (encrypted at rest since Phase 12.5).
    for (const g of guardians) {
      (g as typeof g & { phone: string | null }).phone = decryptField(g.phone);
    }

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
    const guardian = await prisma.guardian.create({
      data: {
        ...data,
        // Column-level encryption (Phase 12.5): guardian phone is children's
        // contact data — stored as an AES-256-GCM envelope, decrypted on read.
        phone: encryptField(data.phone) ?? '',
      },
    });
    res.status(201).json({ ...guardian, phone: decryptField(guardian.phone) });
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
    // phone rides the same pass-through shape; encrypt if the caller sent one.
    if (typeof data.phone === 'string' && !isEncryptedField(data.phone)) {
      data.phone = encryptField(data.phone) ?? data.phone;
    }
    const guardian = await prisma.guardian.update({ where: { id: req.params.id }, data });
    res.json({ ...guardian, phone: decryptField(guardian.phone) });
  } catch (error) {
    res.status(500).json({ type: 'internal-error', title: 'Server Error', status: 500, detail: (error as Error).message });
  }
});

export { router as parentRoutes };
