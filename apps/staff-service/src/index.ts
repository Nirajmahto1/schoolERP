// ──────────────────────────────────────────────
// School ERP — Staff & HR Service
// ──────────────────────────────────────────────

import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { PrismaClient } from '@school-erp/database';

dotenv.config({ path: '../../.env' });

const app = express();
const prisma = new PrismaClient();
const PORT = process.env.PORT_STAFF_SERVICE || 4002;

app.use(cors());
app.use(express.json());
app.set('prisma', prisma);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'staff-service', timestamp: new Date().toISOString() });
});

import { teacherRoutes } from './routes/teacher.routes';
app.use('/teacher', teacherRoutes);

import { adminRoutes } from './routes/admin.routes';
import { ctx } from '@school-erp/auth';
app.use('/admin', adminRoutes);

// ── Staff CRUD (static /staff/* paths MUST be registered before /staff/:id) ──
const listPayrollsHandler = async (req: Request, res: Response) => {
  try {
    const { month, year } = req.query;
    const payrolls = await prisma.payroll.findMany({
      where: { ...(month && { month: parseInt(month as string) }), ...(year && { year: parseInt(year as string) }) },
      include: { staff: { select: { firstName: true, lastName: true, employeeId: true } } },
    });
    res.json({ data: payrolls });
  } catch (error) { res.status(500).json({ detail: (error as Error).message }); }
};

const generatePayrollsHandler = async (req: Request, res: Response) => {
  try {
    const { month, year, branchId } = req.body;
    const staffList = await prisma.staff.findMany({ where: { branchId, isActive: true } });
    const payrolls = await Promise.all(
      staffList.map(s => prisma.payroll.upsert({
        where: { staffId_month_year: { staffId: s.id, month, year } },
        create: { staffId: s.id, month, year, basicSalary: s.salary, allowances: 0, deductions: 0, netSalary: s.salary },
        update: {},
      }))
    );
    res.json({ data: payrolls, count: payrolls.length });
  } catch (error) { res.status(500).json({ detail: (error as Error).message }); }
};

app.get('/staff', async (req, res) => {
  try {
    const { branchId } = ctx(req);
    const staff = await prisma.staff.findMany({
      where: { branchId, isActive: true },
      include: { user: { select: { email: true, role: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ data: staff });
  } catch (error) { res.status(500).json({ detail: (error as Error).message }); }
});

app.get('/staff/payroll', listPayrollsHandler);
app.post('/staff/payroll/generate', generatePayrollsHandler);

app.get('/staff/:id', async (req, res) => {
  try {
    const staff = await prisma.staff.findUnique({
      where: { id: req.params.id },
      include: {
        user: { select: { email: true, role: true } },
        attendances: { take: 30, orderBy: { date: 'desc' } },
        leaveRequests: { take: 10, orderBy: { createdAt: 'desc' } },
        payrolls: { take: 12, orderBy: [{ year: 'desc' }, { month: 'desc' }] },
      },
    });
    if (!staff) { res.status(404).json({ detail: 'Staff not found' }); return; }
    res.json(staff);
  } catch (error) { res.status(500).json({ detail: (error as Error).message }); }
});

app.post('/staff', async (req, res) => {
  try {
    const { branchId } = ctx(req);
    const { tenantId: schoolId } = ctx(req);
    const bcrypt = await import('bcryptjs');
    const passwordHash = await bcrypt.hash('staff123', 12);
    const user = await prisma.user.create({
      data: { email: req.body.email, passwordHash, role: req.body.role || 'TEACHER', branchId, schoolId },
    });
    const staff = await prisma.staff.create({ data: { ...req.body, userId: user.id, branchId } });
    res.status(201).json(staff);
  } catch (error) { res.status(500).json({ detail: (error as Error).message }); }
});

app.put('/staff/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { email, role, userId, user, payrolls, leaveRequests, attendances, subjectTeachers, ...staffFields } = req.body;
    const staff = await prisma.staff.update({
      where: { id },
      data: staffFields,
      include: { user: { select: { email: true, role: true } } },
    });
    if (email || role) {
      await prisma.user.update({
        where: { id: staff.userId },
        data: { ...(email && { email }), ...(role && { role }) },
      });
    }
    res.json(staff);
  } catch (error) { res.status(500).json({ detail: (error as Error).message }); }
});

app.delete('/staff/:id', async (req, res) => {
  try {
    const staff = await prisma.staff.findUnique({ where: { id: req.params.id } });
    if (!staff) { res.status(404).json({ detail: 'Not found' }); return; }
    await prisma.staff.update({ where: { id: req.params.id }, data: { isActive: false } });
    await prisma.user.update({ where: { id: staff.userId }, data: { isActive: false } });
    res.status(204).send();
  } catch (error) { res.status(500).json({ detail: (error as Error).message }); }
});

// ── Leave Requests ──
app.get('/leave-requests', async (req, res) => {
  try {
    const requests = await prisma.leaveRequest.findMany({
      include: { staff: { select: { firstName: true, lastName: true, employeeId: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ data: requests });
  } catch (error) { res.status(500).json({ detail: (error as Error).message }); }
});

app.post('/leave-requests', async (req, res) => {
  try {
    const request = await prisma.leaveRequest.create({ data: req.body });
    res.status(201).json(request);
  } catch (error) { res.status(500).json({ detail: (error as Error).message }); }
});

app.patch('/leave-requests/:id', async (req, res) => {
  try {
    const request = await prisma.leaveRequest.update({ where: { id: req.params.id }, data: req.body });
    res.json(request);
  } catch (error) { res.status(500).json({ detail: (error as Error).message }); }
});

// ── Payroll (root paths for direct service calls) ──
app.get('/payroll', listPayrollsHandler);
app.post('/payroll/generate', generatePayrollsHandler);

// ── Transport ──
app.get('/transport/routes', async (req, res) => {
  try {
    const { branchId } = ctx(req);
    const routes = await prisma.transportRoute.findMany({
      where: { branchId, isActive: true },
      include: {
        vehicle: true,
        stops: { orderBy: { order: 'asc' } },
      },
    });
    const data = routes.map(r => ({
      id: r.id,
      name: r.name,
      bus: r.vehicle.vehicleNo,
      driver: r.vehicle.driverName,
      phone: r.vehicle.driverPhone,
      students: 0, // Would need a join through student-transport mapping
      stops: r.stops.length,
      status: r.vehicle.isActive ? 'Active' : 'Maintenance',
      time: r.stops.length > 0 ? r.stops[0].pickupTime : '—',
      fare: r.fare,
    }));
    res.json({ data });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

app.get('/transport/vehicles', async (req, res) => {
  try {
    const { branchId } = ctx(req);
    const vehicles = await prisma.vehicle.findMany({
      where: { branchId },
      orderBy: { vehicleNo: 'asc' },
    });
    res.json({ data: vehicles });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

process.on('SIGTERM', async () => { await prisma.$disconnect(); process.exit(0); });
app.listen(PORT, () => console.log(`👨‍💼 Staff Service running on http://localhost:${PORT}`));
export { app, prisma };
