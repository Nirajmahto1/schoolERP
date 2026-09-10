// ──────────────────────────────────────────────
// School ERP — Staff & HR Service
// ──────────────────────────────────────────────

import { Router, Request, Response } from 'express';
import { PrismaClient } from '@school-erp/database';
import { loadServiceEnv } from '@school-erp/config';
import { createServiceApp, listenWithGracefulShutdown, ctx } from '@school-erp/auth';
import { teacherRoutes } from './routes/teacher.routes';
import { adminRoutes } from './routes/admin.routes';
import { hrRoutes } from './routes/hr.routes';

const SERVICE_NAME = 'staff-service';
const env = loadServiceEnv(SERVICE_NAME, 'PORT_STAFF_SERVICE');
const prisma = new PrismaClient();

// No CORS, no dotenv, no per-service port fallback. Configuration comes from
// @school-erp/config (missing var = crash at boot), and every non-health route
// is gated behind a gateway-signed, audience-bound assertion (GATE 0).
const { app, mount, finalize } = createServiceApp({
  serviceName: SERVICE_NAME,
  assertionPublicKey: env.INTERNAL_ASSERTION_PUBLIC_KEY,
  readinessCheck: async () => { await prisma.$queryRaw`SELECT 1`; },
});

mount('/teacher', teacherRoutes);
mount('/admin', adminRoutes);

const r = Router();

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

r.get('/staff', async (req, res) => {
  try {
    const { branchId } = ctx(req);
    if (!branchId) {
      res.status(403).json({ detail: 'Account has no branch — cannot list staff.' });
      return;
    }
    const staff = await prisma.staff.findMany({
      where: { branchId, isActive: true },
      include: {
        user: {
          select: {
            email: true,
            roleAssignments: {
              where: { isActive: true },
              select: { role: { select: { code: true } } },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ data: staff });
  } catch (error) { res.status(500).json({ detail: (error as Error).message }); }
});

r.get('/staff/payroll', listPayrollsHandler);
r.post('/staff/payroll/generate', generatePayrollsHandler);

r.get('/staff/:id', async (req, res) => {
  try {
    const staff = await prisma.staff.findUnique({
      where: { id: req.params.id },
      include: {
        user: {
          select: {
            email: true,
            roleAssignments: {
              where: { isActive: true },
              select: { role: { select: { code: true } } },
            },
          },
        },
        staffAttendances: { take: 30, orderBy: { date: 'desc' } },
        leaveRequests: { take: 10, orderBy: { createdAt: 'desc' } },
        payrolls: { take: 12, orderBy: [{ year: 'desc' }, { month: 'desc' }] },
      },
    });
    if (!staff) { res.status(404).json({ detail: 'Staff not found' }); return; }
    res.json(staff);
  } catch (error) { res.status(500).json({ detail: (error as Error).message }); }
});

r.post('/staff', async (req, res) => {
  try {
    const { branchId } = ctx(req);
    if (!branchId) {
      res.status(403).json({ detail: 'Account has no branch — cannot create staff.' });
      return;
    }
    const bcrypt = await import('bcryptjs');
    const passwordHash = await bcrypt.hash('staff123', 12);
    // Identity = User + role assignment (Phase 2); no role/schoolId columns.
    const user = await prisma.user.create({
      data: {
        email: req.body.email,
        passwordHash,
        defaultBranchId: branchId,
        roleAssignments: { create: { roleId: 'sys_teacher', branchId } },
      },
    });
    const { email, role, ...staffFields } = req.body;
    void email; void role;
    const staff = await prisma.staff.create({ data: { ...staffFields, userId: user.id, branchId } });
    res.status(201).json(staff);
  } catch (error) { res.status(500).json({ detail: (error as Error).message }); }
});

r.put('/staff/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { email, role, userId, user, payrolls, leaveRequests, attendances, subjectTeachers, ...staffFields } = req.body;
    const staff = await prisma.staff.update({
      where: { id },
      data: staffFields,
      include: {
        user: {
          select: {
            email: true,
            roleAssignments: {
              where: { isActive: true },
              select: { role: { select: { code: true } } },
            },
          },
        },
      },
    });
    if (email) {
      await prisma.user.update({ where: { id: staff.userId }, data: { email } });
    }
    // Role changes swap the active role assignment (roles are rows, not enums).
    if (role) {
      const target = await prisma.role.findUnique({ where: { code: role } });
      if (!target) {
        res.status(400).json({ detail: `Unknown role code ${role}.` });
        return;
      }
      await prisma.userRoleAssignment.updateMany({
        where: { userId: staff.userId, isActive: true },
        data: { isActive: false },
      });
      await prisma.userRoleAssignment.create({
        data: { userId: staff.userId, roleId: target.id, branchId: staff.branchId },
      });
    }
    res.json(staff);
  } catch (error) { res.status(500).json({ detail: (error as Error).message }); }
});

r.delete('/staff/:id', async (req, res) => {
  try {
    const staff = await prisma.staff.findUnique({ where: { id: req.params.id } });
    if (!staff) { res.status(404).json({ detail: 'Not found' }); return; }
    await prisma.staff.update({ where: { id: req.params.id }, data: { isActive: false } });
    await prisma.user.update({ where: { id: staff.userId }, data: { isActive: false } });
    res.status(204).send();
  } catch (error) { res.status(500).json({ detail: (error as Error).message }); }
});

// ── Leave Requests ──
r.get('/leave-requests', async (req, res) => {
  try {
    const requests = await prisma.leaveRequest.findMany({
      include: { staff: { select: { firstName: true, lastName: true, employeeId: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ data: requests });
  } catch (error) { res.status(500).json({ detail: (error as Error).message }); }
});

r.post('/leave-requests', async (req, res) => {
  try {
    const request = await prisma.leaveRequest.create({ data: req.body });
    res.status(201).json(request);
  } catch (error) { res.status(500).json({ detail: (error as Error).message }); }
});

r.patch('/leave-requests/:id', async (req, res) => {
  try {
    const request = await prisma.leaveRequest.update({ where: { id: req.params.id }, data: req.body });
    res.json(request);
  } catch (error) { res.status(500).json({ detail: (error as Error).message }); }
});

// ── Payroll (root paths for direct service calls) ──
r.get('/payroll', listPayrollsHandler);
r.post('/payroll/generate', generatePayrollsHandler);

// ── Transport ──
r.get('/transport/routes', async (req, res) => {
  try {
    const { branchId } = ctx(req);
    if (!branchId) {
      res.status(403).json({ detail: 'Account has no branch — cannot list routes.' });
      return;
    }
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

r.get('/transport/vehicles', async (req, res) => {
  try {
    const { branchId } = ctx(req);
    if (!branchId) {
      res.status(403).json({ detail: 'Account has no branch — cannot list vehicles.' });
      return;
    }
    const vehicles = await prisma.vehicle.findMany({
      where: { branchId },
      orderBy: { vehicleNo: 'asc' },
    });
    res.json({ data: vehicles });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

mount('/', r);
mount('/hr', hrRoutes);
finalize();

listenWithGracefulShutdown(app, env.PORT, SERVICE_NAME, async () => { await prisma.$disconnect(); });

export { app, prisma };
