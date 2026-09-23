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
import { applyLateFees, previewAdvance, collectAdvance, reverseLateFeeRun } from '@school-erp/domain';
import type { LateFeeRule } from '@prisma/client';
import { ctx } from '@school-erp/auth';

const FEE_MANAGERS = ['SUPER_ADMIN', 'BRANCH_ADMIN', 'PRINCIPAL', 'FINANCE', 'ACCOUNTANT'];

function assertFeeManager(res: import('express').Response, roles: string[]): boolean {
  if (!roles.some((r) => FEE_MANAGERS.includes(r))) {
    res.status(403).json({ type: 'forbidden', title: 'Forbidden', status: 403, detail: 'Only accountant, finance, principal or admin accounts can manage late fees or collect advances.' });
    return false;
  }
  return true;
}

/** Shared by the manual route and the nightly sweep — one audit row per pass. */
export async function runLateFeeApply(
  prisma: PrismaClient,
  branch: { id: string; name?: string },
  source: 'NIGHTLY' | 'MANUAL',
  createdBy: string | null,
): Promise<import('@school-erp/domain').ApplyLateFeesResult & { runId?: string }> {
  const started = Date.now();
  const year = await prisma.academicYear.findFirst({ where: { branchId: branch.id, isCurrent: true }, select: { id: true } });
  if (!year) throw new Error('The branch has no current academic year set.');
  const rules: LateFeeRule[] = await prisma.lateFeeRule.findMany({
    where: { branchId: branch.id, deletedAt: null, isActive: true },
    orderBy: { minDays: 'asc' },
  });
  if (rules.length === 0) throw new Error('No late-fee rules configured for this branch yet — add slabs first.');

  try {
    const result = await applyLateFees(prisma, {
      branchId: branch.id,
      academicYearId: year.id,
      rules: rules.map((rule) => ({
        id: rule.id, label: rule.label, minDays: rule.minDays, maxDays: rule.maxDays,
        amount: Number(rule.amount), isPercent: rule.isPercent, feeHeadId: rule.feeHeadId, isActive: rule.isActive,
      })),
      createdBy,
    });
    const totalAmount = result.applied.reduce((s, a) => s + a.amount, 0);
    const run = await prisma.lateFeeSweepRun.create({
      data: {
        branchId: branch.id,
        source,
        status: 'SUCCESS',
        scanned: result.scanned,
        appliedCount: result.applied.length,
        skipped: result.skipped,
        totalAmount,
        details: result.applied,
        durationMs: Date.now() - started,
        createdBy,
      },
      select: { id: true },
    });
    return { ...result, runId: run.id };
  } catch (err) {
    // A failed pass is itself an audit event — record it, then rethrow so
    // the caller's error path (route 500 / sweep log) still happens.
    await prisma.lateFeeSweepRun.create({
      data: {
        branchId: branch.id,
        source,
        status: 'FAILED',
        errorMessage: (err as Error).message.slice(0, 1000),
        durationMs: Date.now() - started,
        createdBy,
      },
    }).catch(() => { /* never mask the original error with an audit failure */ });
    throw err;
  }
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

    if (dryRun) {
      // Read-only — no run row: nothing was fined, nothing to audit.
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
        dryRun: true,
      });
      res.json({ ...result, dryRun });
      return;
    }

    // Real apply — audited as a MANUAL run row.
    const result = await runLateFeeApply(prisma, { id: branchId }, 'MANUAL', userId);
    res.json({ ...result, dryRun });
  };

  // Audit trail: recent apply passes (nightly + manual), newest first.
  r.get('/runs', async (req, res) => {
    try {
      const { branchId, roles } = ctx(req);
      if (!branchId) { res.status(403).json({ detail: 'Account has no branch.' }); return; }
      if (!assertFeeManager(res, roles)) return;
      const runs = await prisma.lateFeeSweepRun.findMany({
        where: { branchId },
        orderBy: { createdAt: 'desc' },
        take: 30,
      });
      res.json({ data: runs });
    } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
  });

  // Undo every fine a run created (mistaken applies). Blocked fines come
  // back listed; the run flips to REVERSED and cannot be reversed twice.
  r.post('/runs/:id/reverse', async (req, res) => {
    try {
      const { branchId, roles, userId } = ctx(req);
      if (!branchId) { res.status(403).json({ detail: 'Account has no branch.' }); return; }
      if (!assertFeeManager(res, roles)) return;
      const reason = (req.body as { reason?: string } | undefined)?.reason?.trim();
      if (!reason) {
        res.status(400).json({ type: 'validation-error', title: 'Invalid Input', status: 400, detail: 'A reversal reason is required.' });
        return;
      }
      const result = await reverseLateFeeRun(prisma, { runId: req.params.id, branchId, reason, createdBy: userId });
      res.json(result);
    } catch (e) {
      const msg = (e as Error).message;
      const status = /not found|different branch|already been reversed|failed run/i.test(msg) ? 409 : 400;
      res.status(status).json({ detail: msg });
    }
  });

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
