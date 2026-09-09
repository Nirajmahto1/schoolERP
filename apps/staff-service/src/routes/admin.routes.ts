import { Router, Request, Response } from 'express';
import { PrismaClient } from '@school-erp/database';
import { ctx } from '@school-erp/auth';

export const adminRoutes = Router();

// GET /dashboard
adminRoutes.get('/dashboard', async (req: Request, res: Response) => {
  try {
    const prisma: PrismaClient = req.app.get('prisma');
    const { branchId } = ctx(req);

    if (!branchId) {
      return res.status(400).json({ detail: 'Branch ID required' });
    }

    const [totalStudents, totalStaff] = await Promise.all([
      prisma.student.count({ where: { branchId, deletedAt: null } }),
      prisma.staff.count({ where: { branchId, isActive: true } }),
    ]);

    // Today's attendance from the session/record model.
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const sessions = await prisma.attendanceSession.findMany({
      where: { branchId, date: today },
      include: { records: { select: { status: true } } },
    });

    let attendanceRate = 100;
    const records = sessions.flatMap((s) => s.records);
    if (records.length > 0) {
      const present = records.filter((a) => a.status === 'PRESENT' || a.status === 'LATE').length;
      attendanceRate = Math.round((present / records.length) * 100);
    }

    // Fee collection = payments collected in this branch.
    const payments = await prisma.payment.aggregate({
      where: { branchId, status: 'SUCCESS' },
      _sum: { amount: true },
    });
    const feeCollection = Number(payments._sum.amount ?? 0);

    res.json({
      totalStudents,
      totalStaff,
      attendanceRate,
      feeCollection,
    });
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});
