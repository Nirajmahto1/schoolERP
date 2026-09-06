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
      prisma.student.count({ where: { branchId, isActive: true } }),
      prisma.staff.count({ where: { branchId, isActive: true } })
    ]);

    // Calculate approximate attendance rate for today
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const attendances = await prisma.attendance.findMany({
      where: { date: today, branchId }
    });
    
    let attendanceRate = 100;
    if (attendances.length > 0) {
      const present = attendances.filter(a => a.status === 'PRESENT' || a.status === 'LATE').length;
      attendanceRate = Math.round((present / attendances.length) * 100);
    }

    // Fee collection
    const invoices = await prisma.feeInvoice.findMany({
      where: { student: { branchId } }
    });
    const feeCollection = invoices.reduce((sum, inv) => sum + Number(inv.paidAmount || 0), 0);

    res.json({
      totalStudents,
      totalStaff,
      attendanceRate,
      feeCollection
    });
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});
