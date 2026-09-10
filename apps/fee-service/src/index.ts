// ──────────────────────────────────────────────
// School ERP — Fee & Finance Service
//
// Phase 2 shapes: Invoice + InvoiceLine + FeeHead (no FeeInvoice/FeeItem),
// PaymentAllocation, and the append-only FeeLedger. Demands and payments go
// through the domain engine so the ledger always ties out with the invoices.
// ──────────────────────────────────────────────

import { Router } from 'express';
import { PrismaClient } from '@school-erp/database';
import { loadServiceEnv } from '@school-erp/config';
import { postDemand, postPayment, ledgerBalance } from '@school-erp/domain';
import { createServiceApp, listenWithGracefulShutdown, ctx } from '@school-erp/auth';
import { buildOpenApiDocument } from '@school-erp/http';

/** MUST equal the gateway route-table audience for this service. */
const SERVICE_NAME = 'fee-service';

export interface FeeAppOptions {
  env: { INTERNAL_ASSERTION_PUBLIC_KEY: string };
  prisma: PrismaClient;
}

/**
 * App factory — split from the entrypoint so tests can inject a Prisma
 * client and an explicit env without booting the real process.
 */
export function createFeeApp(options: FeeAppOptions) {
  const { prisma } = options;
  const env = { INTERNAL_ASSERTION_PUBLIC_KEY: options.env.INTERNAL_ASSERTION_PUBLIC_KEY };

  const { app, mount, finalize } = createServiceApp({
    serviceName: SERVICE_NAME,
    assertionPublicKey: env.INTERNAL_ASSERTION_PUBLIC_KEY,
    readinessCheck: async () => { await prisma.$queryRaw`SELECT 1`; },
  });

  app.set('prisma', prisma);

  // Published contract (GATE 3).
  const openapi = buildOpenApiDocument({
    title: 'Fee Service',
    description: 'Fee structures, demands, payments with deterministic allocation, the append-only ledger, and collection reports.',
    version: '1.0.0',
    basePath: '/fees',
    paths: {
      '/fee-heads': { get: { summary: 'List fee heads', tags: ['structures'], responses: { '200': { description: 'OK' } } } },
      '/fee-structures': {
        get: { summary: 'List fee structures', tags: ['structures'], responses: { '200': { description: 'OK' } } },
        post: { summary: 'Create a fee structure with lines and classes', tags: ['structures'], responses: { '201': { description: 'Created' } } },
      },
      '/invoices': {
        get: { summary: 'List invoices (cursor-paginated)', tags: ['invoices'], responses: { '200': { description: 'OK' } } },
        post: { summary: 'Post a demand via the domain engine (invoice + ledger)', tags: ['invoices'], responses: { '201': { description: 'Created' } } },
      },
      '/generate-invoices': {
        post: { summary: 'Generate invoices for a structure × class × year with concessions (idempotent)', tags: ['invoices'], responses: { '201': { description: 'Generation report' } } },
      },
      '/payments': {
        post: { summary: 'Record a payment (oldest-dues-first allocation, idempotencyKey supported)', tags: ['payments'], responses: { '201': { description: 'Payment + allocations' } } },
      },
      '/ledger': { get: { summary: 'Append-only ledger + balance for one student', tags: ['ledger'], responses: { '200': { description: 'OK' } } } },
      '/concessions': {
        get: { summary: 'List concessions', tags: ['concessions'], responses: { '200': { description: 'OK' } } },
        post: { summary: 'Create a concession (PENDING until approved)', tags: ['concessions'], responses: { '201': { description: 'Created' } } },
      },
      '/concessions/{id}/approve': { post: { summary: 'Approve a concession', tags: ['concessions'], responses: { '200': { description: 'Approved' } } } },
      '/refunds': { post: { summary: 'Refund a credit balance (REFUND ledger entry)', tags: ['adjustments'], responses: { '201': { description: 'Created' }, '409': { description: 'Exceeds credit balance' } } } },
      '/write-offs': { post: { summary: 'Write off dues (WRITE_OFF ledger entry, never a delete)', tags: ['adjustments'], responses: { '201': { description: 'Created' } } } },
      '/defaulters': { get: { summary: 'Defaulters by overdue invoices', tags: ['reports'], responses: { '200': { description: 'OK' } } } },
      '/reports': { get: { summary: 'Income/expense summary for dashboards', tags: ['reports'], responses: { '200': { description: 'OK' } } } },
    },
  });
  app.get('/openapi.json', (_req, res) => { res.json(openapi); });

const r = Router();

// ── Fee Structures ──
r.get('/fee-structures', async (req, res) => {
  try {
    const { branchId } = ctx(req);
    if (!branchId) {
      res.status(403).json({ detail: 'Account has no branch — cannot list fee structures.' });
      return;
    }
    const structures = await prisma.feeStructure.findMany({
      where: { branchId, isActive: true, deletedAt: null },
      include: { lines: { include: { feeHead: true } }, classes: true },
    });
    res.json({ data: structures });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

r.post('/fee-structures', async (req, res) => {
  try {
    const { branchId } = ctx(req);
    const { lines, classes, ...data } = req.body ?? {};
    void lines; void classes;
    const structure = await prisma.feeStructure.create({
      data: {
        ...data,
        branchId,
        academicYearId: data.academicYearId,
        lines: lines ? { create: lines } : undefined,
        classes: classes ? { create: classes } : undefined,
      },
      include: { lines: true, classes: true },
    });
    res.status(201).json(structure);
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

// ── Fee Heads ──
r.get('/fee-heads', async (req, res) => {
  try {
    const { branchId } = ctx(req);
    if (!branchId) {
      res.status(403).json({ detail: 'Account has no branch — cannot list fee heads.' });
      return;
    }
    const heads = await prisma.feeHead.findMany({ where: { branchId, deletedAt: null } });
    res.json({ data: heads });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

// ── Invoices ──
r.get('/invoices', async (req, res) => {
  try {
    const { branchId } = ctx(req);
    if (!branchId) {
      res.status(403).json({ detail: 'Account has no branch — cannot list invoices.' });
      return;
    }
    const { studentId, status, cursor, limit = '20' } = req.query;
    const take = Math.min(parseInt(limit as string), 100);
    const where: any = { branchId, deletedAt: null };
    if (studentId) where.studentId = studentId;
    if (status) where.status = status;

    const invoices = await prisma.invoice.findMany({
      where,
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor as string }, skip: 1 } : {}),
      include: {
        student: { select: { firstName: true, lastName: true, admissionNo: true } },
        lines: { include: { feeHead: { select: { name: true } } } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const hasMore = invoices.length > take;
    const data = hasMore ? invoices.slice(0, take) : invoices;
    res.json({ data, meta: { limit: take, cursor: data.length ? data[data.length - 1].id : null, hasMore } });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

// Post a demand (invoice + one ledger entry per line) via the domain engine.
r.post('/invoices', async (req, res) => {
  try {
    const { branchId } = ctx(req);
    if (!branchId) {
      res.status(403).json({ detail: 'Account has no branch — cannot post a demand.' });
      return;
    }
    const { studentId, academicYearId, lines, dueDate, periodStart, periodEnd, createdBy } = req.body;
    if (!academicYearId || !Array.isArray(lines) || lines.length === 0) {
      res.status(400).json({ type: 'validation-error', title: 'Invalid Input', status: 400, detail: 'academicYearId and at least one line are required.' });
      return;
    }
    const invoice = await postDemand(prisma, {
      branchId,
      academicYearId,
      studentId,
      lines,
      dueDate: new Date(dueDate),
      periodStart: periodStart ? new Date(periodStart) : null,
      periodEnd: periodEnd ? new Date(periodEnd) : null,
      createdBy: createdBy ?? ctx(req).userId,
    });
    res.status(201).json(invoice);
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

// ── Payments ──
// Allocates oldest-due-first, updates invoice totals, posts the PAYMENT ledger
// entry and honours the idempotency key (duplicate webhooks never double-credit).
r.post('/payments', async (req, res) => {
  try {
    const { branchId } = ctx(req);
    if (!branchId) {
      res.status(403).json({ detail: 'Account has no branch — cannot record a payment.' });
      return;
    }
    const { studentId, academicYearId, amount, method, invoiceIds, idempotencyKey, createdBy } = req.body;
    if (!studentId || !academicYearId || !amount || !method) {
      res.status(400).json({ type: 'validation-error', title: 'Invalid Input', status: 400, detail: 'studentId, academicYearId, amount and method are required.' });
      return;
    }
    const result = await postPayment(prisma, {
      branchId,
      academicYearId,
      studentId,
      amount,
      method,
      invoiceIds,
      idempotencyKey: idempotencyKey ?? null,
      createdBy: createdBy ?? ctx(req).userId,
    });
    res.status(201).json(result);
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

// ── Ledger ──
r.get('/ledger', async (req, res) => {
  try {
    const { branchId } = ctx(req);
    if (!branchId) {
      res.status(403).json({ detail: 'Account has no branch — cannot read a ledger.' });
      return;
    }
    const { studentId, academicYearId } = req.query;
    if (!studentId) {
      res.status(400).json({ type: 'validation-error', title: 'Invalid Input', status: 400, detail: 'studentId is required.' });
      return;
    }
    // Tenant scoping: the student must belong to the caller's branch, or the
    // ledger reads as empty — never another school's data.
    const student = await prisma.student.findFirst({
      where: { id: studentId as string, branchId },
      select: { id: true },
    });
    if (!student) {
      res.json({ data: [], balance: 0 });
      return;
    }
    const entries = await prisma.feeLedger.findMany({
      where: { branchId, studentId: studentId as string, ...(academicYearId ? { academicYearId: academicYearId as string } : {}) },
      orderBy: { createdAt: 'asc' },
    });
    const balance = await ledgerBalance(prisma, {
      studentId: studentId as string,
      ...(academicYearId ? { academicYearId: academicYearId as string } : {}),
    });
    res.json({ data: entries, balance });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

// ── Defaulters ──
r.get('/defaulters', async (req, res) => {
  try {
    const { branchId } = ctx(req);
    if (!branchId) {
      res.status(403).json({ detail: 'Account has no branch — cannot list defaulters.' });
      return;
    }
    const defaulters = await prisma.invoice.findMany({
      where: {
        branchId,
        status: { in: ['OVERDUE', 'ISSUED', 'PARTIALLY_PAID'] },
        dueDate: { lt: new Date() },
        deletedAt: null,
      },
      include: { student: { select: { firstName: true, lastName: true, admissionNo: true, phone: true } } },
      orderBy: { dueDate: 'asc' },
    });
    res.json({ data: defaulters });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

// ── Financial Reports ──
r.get('/reports', async (req, res) => {
  try {
    const { branchId } = ctx(req);
    if (!branchId) {
      res.status(403).json({ detail: 'Account has no branch — cannot compute reports.' });
      return;
    }

    // Income = payments actually collected (ledger is the source of truth).
    const payments = await prisma.payment.findMany({
      where: { branchId, status: 'SUCCESS' },
      select: { amount: true },
    });
    const totalIncome = payments.reduce((sum, p) => sum + Number(p.amount), 0);

    // Expenses (Payroll)
    const payrolls = await prisma.payroll.findMany({
      where: { status: 'PAID', staff: { branchId } },
    });
    const totalExpenses = payrolls.reduce((sum, p) => sum + Number(p.netSalary || 0), 0);
    const netProfit = totalIncome - totalExpenses;

    res.json({
      totalIncome,
      totalExpenses,
      netProfit,
      ytdRevenue: totalIncome,
      incomeBreakdown: [
        { cat: 'Collected Fees', amt: totalIncome, pct: 100 },
      ],
      expenseBreakdown: [
        { cat: 'Staff Salaries', amt: totalExpenses, pct: 100 },
      ],
      monthlyData: [
        { month: new Date().toLocaleString('default', { month: 'short', year: 'numeric' }), income: totalIncome, expense: totalExpenses, profit: netProfit },
      ],
    });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

// ── Concessions (BUILD_PLAN 2.5.3) ──

r.get('/concessions', async (req, res) => {
  try {
    const { branchId } = ctx(req);
    if (!branchId) { res.status(403).json({ detail: 'Account has no branch.' }); return; }
    const { studentId, status } = req.query;
    const concessions = await prisma.concession.findMany({
      where: { student: { branchId }, ...(studentId && { studentId: studentId as string }), ...(status && { status: status as never }) },
      include: { student: { select: { admissionNo: true, firstName: true, lastName: true } }, feeHead: { select: { name: true, code: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    res.json({ data: concessions });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

r.post('/concessions', async (req, res) => {
  try {
    const { branchId } = ctx(req);
    if (!branchId) { res.status(403).json({ detail: 'Account has no branch.' }); return; }
    const { studentId, academicYearId, feeHeadId, category, type, value, reason, validFrom, validTo } = req.body ?? {};
    if (!studentId || !academicYearId || type === undefined || value === undefined) {
      res.status(400).json({ type: 'validation-error', title: 'Invalid Input', status: 400, detail: 'studentId, academicYearId, type and value are required.' });
      return;
    }
    if (type === 'PERCENTAGE' && (Number(value) <= 0 || Number(value) > 100)) {
      res.status(400).json({ type: 'validation-error', title: 'Invalid Input', status: 400, detail: 'PERCENTAGE value must be 1-100.' });
      return;
    }
    const student = await prisma.student.findFirst({ where: { id: studentId, branchId }, select: { id: true } });
    if (!student) { res.status(404).json({ type: 'not-found', title: 'Not Found', status: 404, detail: 'Student not found.' }); return; }
    const concession = await prisma.concession.create({
      data: {
        studentId, academicYearId,
        feeHeadId: feeHeadId ?? null,
        category: category ?? 'OTHER',
        type, value,
        reason: reason ?? null,
        validFrom: validFrom ? new Date(validFrom) : null,
        validTo: validTo ? new Date(validTo) : null,
      },
    });
    res.status(201).json(concession);
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

r.post('/concessions/:id/approve', async (req, res) => {
  try {
    const { branchId, userId } = ctx(req);
    if (!branchId) { res.status(403).json({ detail: 'Account has no branch.' }); return; }
    const concession = await prisma.concession.findFirst({ where: { id: req.params.id, student: { branchId } } });
    if (!concession) { res.status(404).json({ type: 'not-found', title: 'Not Found', status: 404, detail: 'Concession not found.' }); return; }
    if (concession.status !== 'PENDING') { res.status(409).json({ type: 'conflict', title: 'Conflict', status: 409, detail: 'Concession was already decided.' }); return; }
    const updated = await prisma.concession.update({
      where: { id: concession.id },
      data: { status: 'APPROVED', approvedBy: userId, approvedAt: new Date() },
    });
    res.json(updated);
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

// ── Invoice generation from FeeStructure × Enrollment × Concessions (2.5.5) ──
// Idempotent per (student, structure, period): re-running the same generation
// finds the existing invoice by invoiceNo instead of double-billing.

r.post('/generate-invoices', async (req, res) => {
  try {
    const { branchId } = ctx(req);
    if (!branchId) { res.status(403).json({ detail: 'Account has no branch.' }); return; }
    const { feeStructureId, academicYearId, classId, dueDate, periodStart, periodEnd } = req.body ?? {};
    if (!feeStructureId || !academicYearId || !dueDate) {
      res.status(400).json({ type: 'validation-error', title: 'Invalid Input', status: 400, detail: 'feeStructureId, academicYearId and dueDate are required.' });
      return;
    }

    const structure = await prisma.feeStructure.findFirst({
      where: { id: feeStructureId, branchId },
      include: { lines: { include: { feeHead: true } }, classes: true },
    });
    if (!structure) { res.status(404).json({ type: 'not-found', title: 'Not Found', status: 404, detail: 'Fee structure not found.' }); return; }

    // Target class set: structure's classes, or the requested classId.
    const targetClassIds = classId ? [classId as string] : structure.classes.map((c) => c.classId);
    if (targetClassIds.length === 0) {
      res.status(400).json({ type: 'validation-error', title: 'Invalid Input', status: 400, detail: 'Fee structure has no classes assigned and no classId given.' });
      return;
    }

    const enrollments = await prisma.studentEnrollment.findMany({
      where: { branchId, academicYearId, classId: { in: targetClassIds }, status: 'ENROLLED', toDate: null },
      select: { studentId: true },
    });
    const studentIds = [...new Set(enrollments.map((e) => e.studentId))];

    // Approved concessions per student, applied per fee head or overall.
    const concessions = await prisma.concession.findMany({
      where: { studentId: { in: studentIds }, academicYearId, status: 'APPROVED' },
    });
    const concessionsByStudent = new Map<string, typeof concessions>();
    for (const c of concessions) {
      const list = concessionsByStudent.get(c.studentId) ?? [];
      list.push(c);
      concessionsByStudent.set(c.studentId, list);
    }

    const generated: Array<{ studentId: string; invoiceNo: string; total: number; discount: number }> = [];
    const skipped: Array<{ studentId: string; reason: string }> = [];

    for (const studentId of studentIds) {
      // Compute lines with per-student concession application.
      const studentConcessions = concessionsByStudent.get(studentId) ?? [];
      const lines = structure.lines.map((line) => {
        const concession = studentConcessions.find((c) => !c.feeHeadId || c.feeHeadId === line.feeHeadId);
        let discount = 0;
        if (concession) {
          discount = concession.type === 'PERCENTAGE'
            ? Math.round(Number(line.amount) * Number(concession.value)) / 100
            : Number(concession.value);
          discount = Math.min(discount, Number(line.amount));
        }
        return {
          feeHeadId: line.feeHeadId,
          amount: Number(line.amount),
          discount,
          description: line.feeHead.name,
          concessionId: concession?.id ?? null,
        };
      });

      const total = lines.reduce((s, l) => s + l.amount - l.discount, 0);
      if (total <= 0) { skipped.push({ studentId, reason: 'total is zero after concessions' }); continue; }

      try {
        const result = await postDemand(prisma, {
          branchId,
          studentId,
          academicYearId,
          lines,
          dueDate: new Date(dueDate),
          periodStart: periodStart ? new Date(periodStart) : null,
          periodEnd: periodEnd ? new Date(periodEnd) : null,
          // Deterministic idempotency key: same student+structure+period →
          // the same invoice number, so re-running never double-bills.
          invoiceNo: `INV-${feeStructureId.slice(-6)}-${studentId.slice(-6)}-${periodStart ?? 'ALL'}`.replace(/[^A-Za-z0-9-]/g, ''),
          status: 'ISSUED',
        });
        generated.push({ studentId, invoiceNo: result.invoiceNo, total, discount: total && lines.reduce((s, l) => s + l.discount, 0) });
      } catch (e) {
        skipped.push({ studentId, reason: (e as Error).message });
      }
    }

    res.status(201).json({ generated: generated.length, skipped: skipped.length, details: { generated, skipped } });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

// ── Refunds / write-offs (2.5.8: reversal entries, never delete) ──

r.post('/refunds', async (req, res) => {
  try {
    const { branchId, userId } = ctx(req);
    if (!branchId) { res.status(403).json({ detail: 'Account has no branch.' }); return; }
    const { studentId, academicYearId, amount, reason } = req.body ?? {};
    if (!studentId || !academicYearId || !amount || !reason) {
      res.status(400).json({ type: 'validation-error', title: 'Invalid Input', status: 400, detail: 'studentId, academicYearId, amount and reason are required.' });
      return;
    }
    const balance = await ledgerBalance(prisma, { studentId, academicYearId });
    if (amount > -balance) {
      res.status(409).json({ type: 'conflict', title: 'Conflict', status: 409, detail: `Refund of ₹${amount} exceeds credit balance of ₹${-balance}.` });
      return;
    }
    // REFUND is a positive ledger entry (money back to the parent = new due).
    const entry = await prisma.feeLedger.create({
      data: {
        branchId,
        studentId,
        academicYearId,
        type: 'REFUND',
        amount,
        description: reason,
        createdBy: userId,
      },
    });
    res.status(201).json(entry);
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

r.post('/write-offs', async (req, res) => {
  try {
    const { branchId, userId } = ctx(req);
    if (!branchId) { res.status(403).json({ detail: 'Account has no branch.' }); return; }
    const { studentId, academicYearId, amount, reason } = req.body ?? {};
    if (!studentId || !academicYearId || !amount || !reason) {
      res.status(400).json({ type: 'validation-error', title: 'Invalid Input', status: 400, detail: 'studentId, academicYearId, amount and reason are required.' });
      return;
    }
    // WRITE_OFF is a negative entry closing part of the dues — an audit trail
    // row with approver identity, not a deletion.
    const entry = await prisma.feeLedger.create({
      data: {
        branchId,
        studentId,
        academicYearId,
        type: 'WRITE_OFF',
        amount: -Math.abs(amount),
        description: reason,
        createdBy: userId,
      },
    });
    res.status(201).json(entry);
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

  mount('/', r);
  finalize();

  return app;
}

// ── Entrypoint ──
const env = loadServiceEnv(SERVICE_NAME, 'PORT_FEE_SERVICE');
const prisma = new PrismaClient();
const app = createFeeApp({ env, prisma });

// Only bind a port when run directly. Imported by tests or the e2e suite,
// the module must NOT listen — vitest would hit EADDRINUSE across suites.
if (process.argv[1]?.endsWith('index.ts')) {
  listenWithGracefulShutdown(app, env.PORT, SERVICE_NAME, async () => { await prisma.$disconnect(); });
}

export { app, prisma };
