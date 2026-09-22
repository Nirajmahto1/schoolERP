// ──────────────────────────────────────────────
// Payment history (BUILD_PLAN 4.1.4) — per-child receipt history for the
// parent/student apps.
//
// The branch-wide /payments feed is the accountant's view. A parent's phone
// must only ever see rows touching THEIR children, so this route scopes by
// the verified assertion: a PARENT gets every child linked to them
// (guardian → student), a STUDENT gets exactly one row — their own. Staff
// roles may pass ?studentId= for any child in their branch.
// ──────────────────────────────────────────────

import { Router } from 'express';
import type { PrismaClient } from '@school-erp/database';
import { ctx } from '@school-erp/auth';

export function createHistoryRoute(options: { prisma: PrismaClient }) {
  const { prisma } = options;
  const r = Router();

  r.get('/', async (req, res) => {
    try {
      const { branchId, userId, roles } = ctx(req);
      if (!branchId || !userId) { res.status(403).json({ detail: 'Account has no branch.' }); return; }

      const isStaff = roles.some((role) =>
        ['SUPER_ADMIN', 'BRANCH_ADMIN', 'PRINCIPAL', 'FINANCE', 'ACCOUNTANT'].includes(role),
      );

      // Resolve which children this caller may see. Staff may target any
      // child in the branch via ?studentId=; everyone else is pinned to
      // their own relationship rows.
      let studentIds: string[];
      const requested = req.query.studentId?.toString();
      if (isStaff) {
        studentIds = requested ? [requested] : [];
      } else {
        const links = await prisma.studentGuardian.findMany({
          where: { guardian: { userId } },
          select: { studentId: true },
        });
        studentIds = links.map((l) => l.studentId);
        // Student self-resolution: the caller IS the child.
        if (studentIds.length === 0 && roles.includes('STUDENT')) {
          const self = await prisma.student.findFirst({
            where: { userId, deletedAt: null },
            select: { id: true },
          });
          if (self) studentIds = [self.id];
        }
        if (requested && !studentIds.includes(requested)) {
          res.status(403).json({ type: 'forbidden', title: 'Forbidden', status: 403, detail: 'You are not linked to this student.' });
          return;
        }
      }

      // No linked children → an honest empty history (200), not an error.
      const where = {
        branchId,
        status: 'SUCCESS' as const,
        ...(studentIds.length ? { studentId: { in: studentIds } } : (isStaff && requested ? { studentId: requested } : {})),
      };

      const rows = await prisma.payment.findMany({
        where,
        orderBy: { paidAt: 'desc' },
        take: Math.min(Number(req.query.limit) || 100, 200),
        select: {
          id: true, receiptNo: true, amount: true, method: true, status: true,
          paidAt: true, studentId: true, gatewayProvider: true, gatewayPaymentId: true,
        },
      });

      const studentIdsInRows = [...new Set(rows.map((row) => row.studentId))];
      const students = studentIdsInRows.length
        ? await prisma.student.findMany({
            where: { id: { in: studentIdsInRows } },
            select: { id: true, firstName: true, lastName: true, admissionNo: true, photo: true },
          })
        : [];
      const byId = new Map(students.map((s) => [s.id, s]));

      // Group per child — the section headers the app renders.
      const groups = students.map((s) => ({
        student: s,
        payments: rows.filter((row) => row.studentId === s.id),
      }));

      res.json({
        data: rows.map((row) => ({ ...row, student: byId.get(row.studentId) ?? null })),
        groups,
        totals: {
          count: rows.length,
          amount: rows.reduce((sum, row) => sum + Number(row.amount), 0),
        },
      });
    } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
  });

  return r;
}
