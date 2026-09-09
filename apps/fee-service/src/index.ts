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

const SERVICE_NAME = 'fee-service';
const env = loadServiceEnv(SERVICE_NAME, 'PORT_FEE_SERVICE');
const prisma = new PrismaClient();

// No CORS, no dotenv, no per-service port fallback. Configuration comes from
// @school-erp/config (missing var = crash at boot), and every non-health route
// is gated behind a gateway-signed, audience-bound assertion (GATE 0).
const { app, mount, finalize } = createServiceApp({
  serviceName: SERVICE_NAME,
  assertionPublicKey: env.INTERNAL_ASSERTION_PUBLIC_KEY,
  readinessCheck: async () => { await prisma.$queryRaw`SELECT 1`; },
});

app.set('prisma', prisma);

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
    const { studentId, academicYearId } = req.query;
    if (!studentId) {
      res.status(400).json({ type: 'validation-error', title: 'Invalid Input', status: 400, detail: 'studentId is required.' });
      return;
    }
    const entries = await prisma.feeLedger.findMany({
      where: { studentId: studentId as string, ...(academicYearId ? { academicYearId: academicYearId as string } : {}) },
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

mount('/', r);
finalize();

listenWithGracefulShutdown(app, env.PORT, SERVICE_NAME, async () => { await prisma.$disconnect(); });

export { app, prisma };
