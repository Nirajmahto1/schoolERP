// ──────────────────────────────────────────────
// Payment-method routes (BUILD_PLAN 4.1.3 / 4.1.4 / 4.1.5 / 4.1.8)
//
//   POST /cheques                 receive a cheque (payment posts at once)
//   POST /cheques/:id/deposit     mark deposited (optionally into a slip)
//   POST /cheques/:id/credit      bank confirmed → risk window closed
//   POST /cheques/:id/bounce      reverse + penalty (4.1.8)
//   GET  /cheques                 list by status (deposit queue / follow-up)
//   POST /bank-deposits           prepare a slip; cheques → DEPOSITED
//   POST /bank-deposits/:id/credit  bank confirmed; cheques → CREDITED
//   POST /virtual-accounts        idempotent per-student NEFT VA
//   POST /carry-forward           re-demand closing dues into the new year
//   GET  /payments/:id/receipt    numbered receipt (PDF bytes when rendered)
// ──────────────────────────────────────────────

import { Router } from 'express';
import type { PrismaClient } from '@school-erp/database';
import { ctx } from '@school-erp/auth';
import {
  receiveCheque,
  markChequeDeposited,
  markChequeCredited,
  bounceCheque,
  createBankDeposit,
  markDepositCredited,
  ensureVirtualAccount,
  carryForwardDues,
} from '@school-erp/domain';
import { loadReceiptPayment, toReceiptData, renderReceiptBytes, renderReceiptDocument } from './receipts';

export function createMethodsRoutes(prisma: PrismaClient): Router {
  const r = Router();

  // ── Cheques ──
  r.post('/cheques', async (req, res) => {
    try {
      const { branchId, userId } = ctx(req);
      if (!branchId) { res.status(403).json({ detail: 'Account has no branch.' }); return; }
      const { studentId, academicYearId, amount, chequeNumber, bankName, branchName, drawerName, chequeDate, invoiceIds } = req.body ?? {};
      if (!studentId || !academicYearId || !amount || !chequeNumber || !bankName || !chequeDate) {
        res.status(400).json({ type: 'validation-error', title: 'Invalid Input', status: 400, detail: 'studentId, academicYearId, amount, chequeNumber, bankName and chequeDate are required.' });
        return;
      }
      const result = await receiveCheque(prisma, {
        branchId, studentId, academicYearId,
        amount: Number(amount),
        chequeNumber, bankName,
        branchName, drawerName,
        chequeDate: new Date(chequeDate),
        invoiceIds: invoiceIds?.length ? invoiceIds : undefined,
        createdBy: userId,
      });
      res.status(201).json(result);
    } catch (e) { res.status(400).json({ detail: (e as Error).message }); }
  });

  r.get('/cheques', async (req, res) => {
    try {
      const { branchId } = ctx(req);
      if (!branchId) { res.status(403).json({ detail: 'Account has no branch.' }); return; }
      const { status } = req.query;
      const cheques = await prisma.chequePayment.findMany({
        where: { branchId, ...(status ? { status: status as never } : {}) },
        include: { payment: { select: { amount: true, studentId: true, paidAt: true } } },
        orderBy: { createdAt: 'desc' },
        take: 200,
      });
      res.json({ data: cheques });
    } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
  });

  r.post('/cheques/:id/deposit', async (req, res) => {
    try {
      const result = await markChequeDeposited(prisma, req.params.id, req.body ?? {});
      res.json(result);
    } catch (e) { res.status(409).json({ detail: (e as Error).message }); }
  });

  r.post('/cheques/:id/credit', async (req, res) => {
    try {
      const result = await markChequeCredited(prisma, req.params.id);
      res.json(result);
    } catch (e) { res.status(409).json({ detail: (e as Error).message }); }
  });

  r.post('/cheques/:id/bounce', async (req, res) => {
    try {
      const { userId } = ctx(req);
      const { reason, penaltyAmount } = req.body ?? {};
      if (!reason) {
        res.status(400).json({ type: 'validation-error', title: 'Invalid Input', status: 400, detail: 'reason is required.' });
        return;
      }
      const result = await bounceCheque(prisma, req.params.id, { reason, penaltyAmount: penaltyAmount !== undefined ? Number(penaltyAmount) : undefined, createdBy: userId });
      res.json(result);
    } catch (e) { res.status(409).json({ detail: (e as Error).message }); }
  });

  // ── Bank deposits ──
  r.post('/bank-deposits', async (req, res) => {
    try {
      const { branchId, userId } = ctx(req);
      if (!branchId) { res.status(403).json({ detail: 'Account has no branch.' }); return; }
      const { depositedAt, bankName, chequeIds, notes } = req.body ?? {};
      if (!depositedAt) {
        res.status(400).json({ type: 'validation-error', title: 'Invalid Input', status: 400, detail: 'depositedAt is required.' });
        return;
      }
      const deposit = await createBankDeposit(prisma, { branchId, depositedAt: new Date(depositedAt), bankName, chequeIds, notes, createdBy: userId });
      res.status(201).json(deposit);
    } catch (e) { res.status(400).json({ detail: (e as Error).message }); }
  });

  r.post('/bank-deposits/:id/credit', async (req, res) => {
    try {
      const result = await markDepositCredited(prisma, { depositId: req.params.id, ...(req.body ?? {}) });
      res.json(result);
    } catch (e) { res.status(409).json({ detail: (e as Error).message }); }
  });

  // ── Virtual accounts (4.1.3: NEFT with a virtual account per student) ──
  r.post('/virtual-accounts', async (req, res) => {
    try {
      const { branchId } = ctx(req);
      if (!branchId) { res.status(403).json({ detail: 'Account has no branch.' }); return; }
      const { studentId, accountNumber, ifsc, beneficiaryName, provider } = req.body ?? {};
      if (!studentId || !accountNumber || !ifsc || !beneficiaryName) {
        res.status(400).json({ type: 'validation-error', title: 'Invalid Input', status: 400, detail: 'studentId, accountNumber, ifsc and beneficiaryName are required.' });
        return;
      }
      const student = await prisma.student.findFirst({ where: { id: studentId, branchId }, select: { id: true } });
      if (!student) { res.status(404).json({ type: 'not-found', title: 'Not Found', status: 404, detail: 'Student not found.' }); return; }
      const result = await ensureVirtualAccount(prisma, { branchId, studentId, accountNumber, ifsc, beneficiaryName, provider });
      res.status(result.created ? 201 : 200).json(result);
    } catch (e) { res.status(400).json({ detail: (e as Error).message }); }
  });

  r.get('/virtual-accounts', async (req, res) => {
    try {
      const { branchId } = ctx(req);
      if (!branchId) { res.status(403).json({ detail: 'Account has no branch.' }); return; }
      const { studentId } = req.query;
      const vas = await prisma.virtualAccount.findMany({
        where: { branchId, ...(studentId ? { studentId: studentId as string } : {}) },
        include: { student: { select: { admissionNo: true, firstName: true, lastName: true } } },
        orderBy: { createdAt: 'desc' },
        take: 200,
      });
      res.json({ data: vas });
    } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
  });

  // ── Dues carry-forward (4.1.5) ──
  r.post('/carry-forward', async (req, res) => {
    try {
      const { branchId, userId } = ctx(req);
      if (!branchId) { res.status(403).json({ detail: 'Account has no branch.' }); return; }
      const { fromAcademicYearId, toAcademicYearId, dryRun } = req.body ?? {};
      if (!fromAcademicYearId || !toAcademicYearId) {
        res.status(400).json({ type: 'validation-error', title: 'Invalid Input', status: 400, detail: 'fromAcademicYearId and toAcademicYearId are required.' });
        return;
      }
      if (fromAcademicYearId === toAcademicYearId) {
        res.status(400).json({ type: 'validation-error', title: 'Invalid Input', status: 400, detail: 'Source and target academic years must differ.' });
        return;
      }
      const results = await carryForwardDues(prisma, { branchId, fromAcademicYearId, toAcademicYearId, dryRun: Boolean(dryRun), createdBy: userId });
      res.json({
        dryRun: Boolean(dryRun),
        carried: results.filter((x) => !x.skipped).length,
        skipped: results.filter((x) => x.skipped).length,
        details: results,
      });
    } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
  });

  // ── Receipt (4.1.4) — numbered, rendered on demand, cached ──
  r.get('/payments/:id/receipt', async (req, res) => {
    try {
      const { branchId } = ctx(req);
      if (!branchId) { res.status(403).json({ detail: 'Account has no branch.' }); return; }
      const loaded = await loadReceiptPayment(prisma, req.params.id, branchId);
      if (!loaded) { res.status(404).json({ type: 'not-found', title: 'Not Found', status: 404, detail: 'Payment not found.' }); return; }
      const data = toReceiptData(loaded.payment as never);
      (data as { student: unknown }).student = loaded.student;
      (data as { branch: unknown }).branch = loaded.branch;
      res.json({
        ...data,
        documentHtml: renderReceiptDocument(data),
        pdfAvailable: true,
      });
    } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
  });

  r.get('/payments/:id/receipt.pdf', async (req, res) => {
    try {
      const { branchId } = ctx(req);
      if (!branchId) { res.status(403).json({ detail: 'Account has no branch.' }); return; }
      const loaded = await loadReceiptPayment(prisma, req.params.id, branchId);
      if (!loaded) { res.status(404).json({ type: 'not-found', title: 'Not Found', status: 404, detail: 'Payment not found.' }); return; }
      const data = toReceiptData(loaded.payment as never);
      (data as { student: unknown }).student = loaded.student;
      (data as { branch: unknown }).branch = loaded.branch;
      const pdf = renderReceiptBytes(data);
      // Cache the rendered bytes (base64) so batch downloads / the parent
      // portal hit the DB, not the renderer. Fresh wins on re-render.
      await prisma.payment.update({
        where: { id: req.params.id },
        data: { receiptPdf: pdf.toString('base64') },
      });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="receipt-${data.receiptNo}.pdf"`);
      res.send(pdf);
    } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
  });

  // ── Send receipt to guardians (4.1.4: "emailed + WhatsApp") ──
  // Queues EMAIL + WHATSAPP NotificationLog rows; the delivery worker owns
  // provider transport, exactly like every other communication.
  r.post('/payments/:id/receipt/send', async (req, res) => {
    try {
      const { branchId } = ctx(req);
      if (!branchId) { res.status(403).json({ detail: 'Account has no branch.' }); return; }
      const channels: Array<'EMAIL' | 'WHATSAPP'> = Array.isArray(req.body?.channels) && req.body.channels.length
        ? (req.body.channels as string[]).filter((c): c is 'EMAIL' | 'WHATSAPP' => c === 'EMAIL' || c === 'WHATSAPP')
        : ['EMAIL', 'WHATSAPP'];
      const loaded = await loadReceiptPayment(prisma, req.params.id, branchId);
      if (!loaded) { res.status(404).json({ type: 'not-found', title: 'Not Found', status: 404, detail: 'Payment not found.' }); return; }
      const data = toReceiptData(loaded.payment as never);
      (data as { student: unknown }).student = loaded.student;
      (data as { branch: unknown }).branch = loaded.branch;
      if (data.status !== 'SUCCESS') {
        res.status(409).json({ type: 'conflict', title: 'Not Paid', status: 409, detail: 'Receipts can only be sent for captured payments.' });
        return;
      }

      const guardians = await prisma.studentGuardian.findMany({
        where: { studentId: loaded.payment.studentId, receivesComms: true, guardian: { userId: { not: null } } },
        include: { guardian: { select: { fullName: true, phone: true, email: true } } },
        distinct: ['guardianId'],
      });
      if (!guardians.length) {
        res.status(409).json({ type: 'conflict', title: 'No Recipients', status: 409, detail: 'This student has no communication-opted guardians on file.' });
        return;
      }

      const html = renderReceiptDocument(data);
      const summary = `Receipt ${data.receiptNo} — ₹${data.amount.toLocaleString('en-IN')} received for ${loaded.student ? `${loaded.student.firstName} ${loaded.student.lastName}` : 'your ward'}. Thank you.`;
      const logs: Array<{ branchId: string; channel: 'EMAIL' | 'WHATSAPP'; recipientType: 'GUARDIAN'; recipientId: string; recipient?: string; subject?: string; body: string; status: 'QUEUED' }> = [];
      for (const g of guardians) {
        for (const channel of channels) {
          const recipient = channel === 'EMAIL' ? g.guardian.email ?? undefined : g.guardian.phone ?? undefined;
          if (!recipient) continue;
          logs.push({
            branchId: branchId,
            channel,
            recipientType: 'GUARDIAN',
            recipientId: g.guardianId,
            recipient,
            ...(channel === 'EMAIL' ? { subject: `Fee receipt ${data.receiptNo}` } : {}),
            body: channel === 'EMAIL' ? html : summary,
            status: 'QUEUED',
          });
        }
      }
      if (!logs.length) {
        res.status(409).json({ type: 'conflict', title: 'No Reachable Channel', status: 409, detail: 'Guardians have no email or phone on file for the requested channels.' });
        return;
      }
      await prisma.notificationLog.createMany({ data: logs });
      res.status(201).json({ queued: logs.length, channels, guardians: guardians.length });
    } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
  });

  return r;
}
