// ──────────────────────────────────────────────
// Late fees + advance collection routes
//
//   POST /late-fees/rules        create a slab (ADMIN/PRINCIPAL/FINANCE/ACCOUNTANT)
//   GET  /late-fees/rules        list the branch's slabs
//   DELETE /late-fees/rules/:id  soft-delete
//   POST /late-fees/apply        apply slabs to overdue invoices (?dryRun=1)
//   GET  /late-fees/apply        dry-run preview (same engine, read-only)
//
//   GET  /advance/preview?studentId=&months=   what N months would cost
//   POST /advance/collect        generate months + ONE cash payment
//
// Every mutating route is staff-gated: the counter features are for
// accountant/finance/principal/admin, never parents or students.
// ──────────────────────────────────────────────

import { Router } from 'express';
import type { PrismaClient } from '@school-erp/database';
import { applyLateFees, previewAdvance, collectAdvance } from '@school-erp/domain';
import { ctx } from '@school-erp/auth';

const FEE_MANAGERS = ['SUPER_ADMIN', 'BRANCH_ADMIN', 'PRINCIPAL', 'FINANCE', 'ACCOUNTANT'];

function assertFeeManager(res: import('express').Response, roles: string[]): boolean {
  if (!roles.some((r) => FEE_MANAGERS.includes(r))) {
    res.status(403).json({ type: 'forbidden', title: 'Forbidden', status: 403, detail: 'Only accountant, finance, principal or admin accounts can manage late fees or collect advances.' });
    return false;
  }
  return true;
}

export function createLateFeeRoutes(prisma: PrismaClient): Router {
  const r = Router();

  // ── Rules CRUD ──
  r.post('/rules', async (req, res) => {
    try {
      const { branchId, roles, userId } = ctx(req);
      if (!branchId) { res.status(403).json({ detail: 'Account has no branch.' }); return; }
      if (!assertFeeManager(res, roles)) return;
      const { label, minDays, maxDays, amount, isPercent, feeHeadId } = req.body ?? {};
      if (!label || minDays == null || amount == null) {
        res.status(400).json({ type: 'validation-error', title: 'Invalid Input', status: 400, detail: 'label, minDays and amount are required.' });
        return;
      }
      if (Number(minDays) < 1) {
        res.status(400).json({ type: 'validation-error', title: 'Invalid Input', status: 400, detail: 'minDays must be at least 1.' });
        return;
      }
      if (maxDays != null && Number(maxDays) < Number(minDays)) {
        res.status(400).json({ type: 'validation-error', title: 'Invalid Input', status: 400, detail: 'maxDays must be ≥ minDays.' });
        return;
      }
      const rule = await prisma.lateFeeRule.create({
        data: {
          branchId,
          label,
          minDays: Number(minDays),
          maxDays: maxDays != null ? Number(maxDays) : null,
          amount: Number(amount),
          isPercent: Boolean(isPercent),
          feeHeadId: feeHeadId ?? null,
        },
      });
      res.status(201).json(rule);
    } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
  });

  r.get('/rules', async (req, res) => {
    try {
      const { branchId } = ctx(req);
      if (!branchId) { res.status(403).json({ detail: 'Account has no branch.' }); return; }
      const rules = await prisma.lateFeeRule.findMany({
        where: { branchId, deletedAt: null },
        orderBy: { minDays: 'asc' },
      });
      res.json({ data: rules });
    } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
  });

  r.delete('/rules/:id', async (req, res) => {
    try {
      const { branchId, roles, userId } = ctx(req);
      if (!branchId) { res.status(403).json({ detail: 'Account has no branch.' }); return; }
      if (!assertFeeManager(res, roles)) return;
      await prisma.lateFeeRule.updateMany({
        where: { id: req.params.id, branchId },
        data: { deletedAt: new Date(), deletedBy: userId, isActive: false },
      });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
  });

  // ── Apply (POST) / preview (GET) ──
  const runApply = async (req: import('express').Request, res: import('express').Response, dryRun: boolean) => {
    const { branchId, roles, userId } = ctx(req);
    if (!branchId) { res.status(403).json({ detail: 'Account has no branch.' }); return; }
    if (!assertFeeManager(res, roles)) return;

    const current = await prisma.academicYear.findFirst({ where: { branchId, isCurrent: true }, select: { id: true } });
    if (!current) { res.status(409).json({ detail: 'The branch has no current academic year set.' }); return; }

    const rules = await prisma.lateFeeRule.findMany({
      where: { branchId, deletedAt: null, isActive: true },
      orderBy: { minDays: 'asc' },
    });
    if (rules.length === 0) {
      res.status(409).json({ detail: 'No late-fee rules configured for this branch yet — add slabs first.' });
      return;
    }

    const result = await applyLateFees(prisma, {
      branchId,
      academicYearId: current.id,
      rules: rules.map((rule) => ({
        id: rule.id, label: rule.label, minDays: rule.minDays, maxDays: rule.maxDays,
        amount: Number(rule.amount), isPercent: rule.isPercent, feeHeadId: rule.feeHeadId, isActive: rule.isActive,
      })),
      createdBy: userId,
      dryRun,
    });
    res.json({ ...result, dryRun });
  };

  r.post('/apply', async (req, res) => {
    try { await runApply(req, res, false); }
    catch (e) { res.status(500).json({ detail: (e as Error).message }); }
  });

  r.get('/apply', async (req, res) => {
    try { await runApply(req, res, true); }
    catch (e) { res.status(500).json({ detail: (e as Error).message }); }
  });

  return r;
}

export function createAdvanceRoutes(prisma: PrismaClient): Router {
  const r = Router();

  const resolveYear = async (branchId: string) =>
    prisma.academicYear.findFirst({ where: { branchId, isCurrent: true }, select: { id: true } });

  r.get('/preview', async (req, res) => {
    try {
      const { branchId, roles } = ctx(req);
      if (!branchId) { res.status(403).json({ detail: 'Account has no branch.' }); return; }
      if (!assertFeeManager(res, roles)) return;
      const studentId = req.query.studentId as string | undefined;
      const months = Number(req.query.months ?? 3);
      if (!studentId) { res.status(400).json({ detail: 'studentId is required.' }); return; }
      if (!Number.isFinite(months) || months < 1 || months > 12) {
        res.status(400).json({ detail: 'months must be between 1 and 12.' });
        return;
      }
      const year = await resolveYear(branchId);
      if (!year) { res.status(409).json({ detail: 'The branch has no current academic year set.' }); return; }
      const student = await prisma.student.findFirst({ where: { id: studentId, branchId, deletedAt: null }, select: { id: true } });
      if (!student) { res.status(404).json({ detail: 'Student not found in this branch.' }); return; }
      const preview = await previewAdvance(prisma, { branchId, studentId, academicYearId: year.id, months });
      res.json(preview);
    } catch (e) { res.status(400).json({ detail: (e as Error).message }); }
  });

  r.post('/collect', async (req, res) => {
    try {
      const { branchId, roles, userId } = ctx(req);
      if (!branchId) { res.status(403).json({ detail: 'Account has no branch.' }); return; }
      if (!assertFeeManager(res, roles)) return;
      const { studentId, months, monthKeys } = req.body ?? {};
      if (!studentId) { res.status(400).json({ detail: 'studentId is required.' }); return; }
      const n = Number(months);
      if ((!Number.isFinite(n) || n < 1 || n > 12) && !(Array.isArray(monthKeys) && monthKeys.length)) {
        res.status(400).json({ detail: 'months (1–12) or explicit monthKeys are required.' });
        return;
      }
      const year = await resolveYear(branchId);
      if (!year) { res.status(409).json({ detail: 'The branch has no current academic year set.' }); return; }
      const student = await prisma.student.findFirst({ where: { id: studentId, branchId, deletedAt: null }, select: { id: true } });
      if (!student) { res.status(404).json({ detail: 'Student not found in this branch.' }); return; }

      const result = await collectAdvance(prisma, {
        branchId,
        studentId,
        academicYearId: year.id,
        months: Number.isFinite(n) && n >= 1 ? Math.min(n, 12) : monthKeys.length,
        monthKeys: Array.isArray(monthKeys) ? monthKeys : undefined,
        createdBy: userId,
      });
      res.status(201).json(result);
    } catch (e) { res.status(400).json({ detail: (e as Error).message }); }
  });

  return r;
}
