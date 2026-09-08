// ──────────────────────────────────────────────
// School ERP — Fee & Finance Service
// ──────────────────────────────────────────────

import { Router } from 'express';
import { PrismaClient } from '@school-erp/database';
import { loadServiceEnv } from '@school-erp/config';
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
    const structures = await prisma.feeStructure.findMany({ where: { branchId, isActive: true } });
    res.json({ data: structures });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

r.post('/fee-structures', async (req, res) => {
  try {
    const { branchId } = ctx(req);
    const structure = await prisma.feeStructure.create({ data: { ...req.body, branchId } });
    res.status(201).json(structure);
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

// ── Fee Invoices ──
r.get('/invoices', async (req, res) => {
  try {
    const { studentId, status, cursor, limit = '20' } = req.query;
    const take = Math.min(parseInt(limit as string), 100);
    const where: any = {};
    if (studentId) where.studentId = studentId;
    if (status) where.status = status;

    const invoices = await prisma.feeInvoice.findMany({
      where,
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor as string }, skip: 1 } : {}),
      include: {
        student: { select: { firstName: true, lastName: true, admissionNo: true } },
        items: { include: { feeStructure: { select: { name: true } } } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const hasMore = invoices.length > take;
    const data = hasMore ? invoices.slice(0, take) : invoices;
    res.json({ data, meta: { limit: take, cursor: data.length ? data[data.length - 1].id : null, hasMore } });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

r.post('/invoices', async (req, res) => {
  try {
    const { studentId, items, dueDate } = req.body;
    const totalAmount = items.reduce((sum: number, item: any) => sum + item.amount - (item.discount || 0), 0);
    const invoiceNo = `INV-${Date.now()}`;
    const invoice = await prisma.feeInvoice.create({
      data: {
        invoiceNo,
        studentId,
        totalAmount,
        dueDate: new Date(dueDate),
        items: { create: items },
      },
      include: { items: true },
    });
    res.status(201).json(invoice);
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

// ── Payments ──
r.post('/payments', async (req, res) => {
  try {
    const { invoiceId, amount, method, transactionId } = req.body;
    const receiptNo = `REC-${Date.now()}`;
    const payment = await prisma.payment.create({ data: { invoiceId, amount, method, transactionId, receiptNo } });

    // Update invoice paid amount and status
    const invoice = await prisma.feeInvoice.findUnique({ where: { id: invoiceId } });
    if (invoice) {
      const newPaidAmount = Number(invoice.paidAmount) + amount;
      const status = newPaidAmount >= Number(invoice.totalAmount) ? 'PAID' : 'PARTIAL';
      await prisma.feeInvoice.update({ where: { id: invoiceId }, data: { paidAmount: newPaidAmount, status } });
    }

    res.status(201).json(payment);
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

// ── Defaulters ──
r.get('/defaulters', async (req, res) => {
  try {
    const defaulters = await prisma.feeInvoice.findMany({
      where: { status: { in: ['OVERDUE', 'PENDING'] }, dueDate: { lt: new Date() } },
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
    
    // Income
    const invoices = await prisma.feeInvoice.findMany({
      where: { status: { in: ['PAID', 'PARTIAL'] }, student: { branchId } }
    });
    const totalIncome = invoices.reduce((sum, inv) => sum + Number(inv.paidAmount || 0), 0);

    // Expenses (Payroll)
    const payrolls = await prisma.payroll.findMany({
      where: { status: 'PAID', staff: { branchId } }
    });
    const totalExpenses = payrolls.reduce((sum, p) => sum + Number(p.netSalary || 0), 0);
    const netProfit = totalIncome - totalExpenses;

    res.json({
      totalIncome,
      totalExpenses,
      netProfit,
      ytdRevenue: totalIncome,
      incomeBreakdown: [
        { cat: 'Collected Fees', amt: totalIncome, pct: 100 }
      ],
      expenseBreakdown: [
        { cat: 'Staff Salaries', amt: totalExpenses, pct: 100 }
      ],
      monthlyData: [
        { month: new Date().toLocaleString('default', { month: 'short', year: 'numeric' }), income: totalIncome, expense: totalExpenses, profit: netProfit }
      ]
    });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

mount('/', r);
finalize();

listenWithGracefulShutdown(app, env.PORT, SERVICE_NAME, async () => { await prisma.$disconnect(); });

export { app, prisma };
