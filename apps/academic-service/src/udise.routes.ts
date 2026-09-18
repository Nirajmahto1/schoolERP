// ──────────────────────────────────────────────
// UDISE+ routes (BUILD_PLAN 10.2 #1)
//
//   GET /udise/export?academicYearId=…  → the full DCF-shaped JSON
//   GET /udise/export.csv?academicYearId=… → a flat CSV for the portal's
//     paste/import fields
//
// Admin-gated (this is a government filing). The current academic year is
// the default so the common January–March filing flow is one call.
// ──────────────────────────────────────────────

import { Router, type Request, type Response } from 'express';
import type { PrismaClient } from '@school-erp/database';
import { ctx, requireRole } from '@school-erp/auth';
import { buildUdiseExport } from './udise';

const router = Router();

function prismaOf(req: Request): PrismaClient {
  return req.app.get('prisma') as PrismaClient;
}

function problem(res: Response, status: number, type: string, title: string, detail: string): void {
  res.status(status).type('application/problem+json').json({ type, title, status, detail });
}

async function resolveYear(req: Request, res: Response): Promise<{ branchId: string; academicYearId: string } | null> {
  const { branchId } = ctx(req);
  if (!branchId) { problem(res, 403, 'authorization-error', 'Forbidden', 'Account has no branch.'); return null; }
  const prisma = prismaOf(req);
  const academicYearId = (req.query.academicYearId as string | undefined) ??
    (await prisma.academicYear.findFirst({ where: { branchId, isCurrent: true }, select: { id: true } }))?.id;
  if (!academicYearId) { problem(res, 409, 'conflict', 'Conflict', 'No academic year specified and no current year set.'); return null; }
  return { branchId, academicYearId };
}

router.get('/export', requireRole('SUPER_ADMIN', 'BRANCH_ADMIN', 'PRINCIPAL'), async (req: Request, res: Response) => {
  try {
    const scope = await resolveYear(req, res);
    if (!scope) return;
    const exp = await buildUdiseExport(prismaOf(req), scope.branchId, scope.academicYearId);
    res.json(exp);
  } catch (e) { problem(res, 500, 'internal-error', 'Server Error', (e as Error).message); }
});

router.get('/export.csv', requireRole('SUPER_ADMIN', 'BRANCH_ADMIN', 'PRINCIPAL'), async (req: Request, res: Response) => {
  try {
    const scope = await resolveYear(req, res);
    if (!scope) return;
    const exp = await buildUdiseExport(prismaOf(req), scope.branchId, scope.academicYearId);

    const esc = (v: unknown) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines: string[] = [];
    lines.push(`# UDISE+ export, ${exp.meta.academicYear}, completeness=${exp.meta.completeness}`);
    if (exp.meta.missingManualFields.length) lines.push(`# manual fields required: ${exp.meta.missingManualFields.join('; ')}`);
    lines.push('');
    lines.push('SECTION,grade,ageBand,male,female,other,total,sc,st,obc,general,minority,repeaters');
    for (const r of exp.enrolment.byGradeAge) {
      lines.push(['ENROLMENT', r.grade, r.ageBand, r.male, r.female, r.other, r.total, r.sc, r.st, r.obc, r.general, r.minority, r.repeaters].map(esc).join(','));
    }
    lines.push('');
    lines.push('SECTION,grade,sections,averageEnrolmentPerSection');
    for (const s of exp.sections) lines.push(['SECTIONS', s.grade, s.sections, s.averageEnrolmentPerSection].map(esc).join(','));
    lines.push('');
    lines.push('SECTION,qualification,male,female,total');
    for (const q of exp.teachers.byQualification) lines.push(['TEACHERS', q.qualification, q.male, q.female, q.total].map(esc).join(','));
    lines.push('');
    lines.push(`TEACHER_TOTAL,${exp.teachers.total}`);
    lines.push(`GRAND_TOTAL,${exp.enrolment.grandTotal}`);
    lines.push(`PUPIL_TEACHER_RATIO,${exp.teachers.pupilTeacherRatio ?? ''}`);
    lines.push('');
    lines.push('VALIDATION,rule,status,detail');
    for (const v of exp.validation) lines.push(['VALIDATION', v.rule, v.status, v.detail].map(esc).join(','));

    res
      .status(200)
      .type('text/csv')
      .set('content-disposition', `attachment; filename="udise-export-${exp.meta.academicYear}.csv"`)
      .send(lines.join('\n'));
  } catch (e) { problem(res, 500, 'internal-error', 'Server Error', (e as Error).message); }
});

export { router as udiseRoutes };
