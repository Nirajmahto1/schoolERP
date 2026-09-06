// ──────────────────────────────────────────────
// Student CRUD Routes
// ──────────────────────────────────────────────

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { PrismaClient } from '@school-erp/database';
import { ctx } from '@school-erp/auth';

const router = Router();

// ── Validation ──
const createStudentSchema = z.object({
  admissionNo: z.string().min(1),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  dateOfBirth: z.string().transform(s => new Date(s)),
  gender: z.enum(['MALE', 'FEMALE', 'OTHER']),
  bloodGroup: z.string().optional(),
  classId: z.string(),
  sectionId: z.string(),
  studentPassword: z.string().optional(),
  parentPassword: z.string().optional(),
  parentId: z.string().optional(),
  parent: z.object({
    fatherName: z.string().min(1),
    fatherPhone: z.string().min(1),
    dateOfBirth: z.string().optional().transform(s => s ? new Date(s) : null),
    address: z.string().min(1),
  }).optional(),
  address: z.string(),
  phone: z.string().optional(),
  previousSchool: z.string().optional(),
  admissionDate: z.string().transform(s => new Date(s)),
});

// ── GET /students ──
router.get('/', async (req: Request, res: Response) => {
  try {
    const prisma: PrismaClient = req.app.get('prisma');
    const { branchId } = ctx(req);
    const { cursor, limit = '20', classId, sectionId, search } = req.query;

    const take = Math.min(parseInt(limit as string), 100);

    const where: any = { branchId, isActive: true };
    if (classId) where.classId = classId;
    if (sectionId) where.sectionId = sectionId;
    if (search) {
      where.OR = [
        { firstName: { contains: search as string, mode: 'insensitive' } },
        { lastName: { contains: search as string, mode: 'insensitive' } },
        { admissionNo: { contains: search as string, mode: 'insensitive' } },
      ];
    }

    const students = await prisma.student.findMany({
      where,
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor as string }, skip: 1 } : {}),
      include: {
        class: { select: { name: true } },
        section: { select: { name: true } },
        parent: { select: { fatherName: true, fatherPhone: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const hasMore = students.length > take;
    const data = hasMore ? students.slice(0, take) : students;

    res.json({
      data,
      meta: {
        total: await prisma.student.count({ where }),
        limit: take,
        cursor: data.length > 0 ? data[data.length - 1].id : null,
        hasMore,
      },
    });
  } catch (error) {
    res.status(500).json({ type: 'internal-error', title: 'Server Error', status: 500, detail: (error as Error).message });
  }
});
// ── GET /dashboard ──
router.get('/dashboard', async (req: Request, res: Response) => {
  try {
    const prisma: PrismaClient = req.app.get('prisma');
    const { userId } = ctx(req);

    if (!userId) {
      res.status(401).json({ detail: 'Unauthorized' });
      return;
    }

    const student = await prisma.student.findUnique({
      where: { userId },
      include: {
        class: { select: { name: true } },
        section: { select: { name: true } },
        attendances: { take: 30, orderBy: { date: 'desc' } },
        feeInvoices: { where: { status: 'PENDING' } },
        bookIssues: { where: { status: 'ISSUED' }, include: { book: true } },
        examResults: { take: 5, orderBy: { createdAt: 'desc' }, include: { examSubject: { include: { subject: true } } } },
      },
    });

    if (!student) {
      res.status(404).json({ detail: 'Student profile not found.' });
      return;
    }

    // Calculate overall attendance percentage efficiently for the student
    const totalAttendances = await prisma.attendance.count({ where: { studentId: student.id } });
    const presentCount = await prisma.attendance.count({ where: { studentId: student.id, status: 'PRESENT' } });
    const attendancePercentage = totalAttendances > 0 ? Math.round((presentCount / totalAttendances) * 100) : 100;

    // Get today's timetable
    const days = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
    const today = days[new Date().getDay()];
    
    const timetable = await prisma.timetableSlot.findMany({
      where: { sectionId: student.sectionId, day: today },
      include: { subject: { include: { teachers: { include: { staff: true } } } } },
      orderBy: { startTime: 'asc' },
    });

    // Get recent announcements
    const announcements = await prisma.announcement.findMany({
      where: { targetRoles: { has: 'STUDENT' }, branchId: student.branchId, isActive: true },
      orderBy: { createdAt: 'desc' },
      take: 3,
    });

    res.json({
      student,
      stats: {
        attendancePercentage,
        pendingFeesCount: student.feeInvoices.length,
        pendingFeesTotal: student.feeInvoices.reduce((sum, inv) => sum + Number(inv.totalAmount) - Number(inv.paidAmount), 0),
        issuedBooksCount: student.bookIssues.length,
      },
      timetable,
      announcements,
      recentResults: student.examResults,
    });
  } catch (error) {
    res.status(500).json({ type: 'internal-error', title: 'Server Error', status: 500, detail: (error as Error).message });
  }
});

const updateProfileSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  phone: z.string().optional(),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(6),
});

// ── GET /profile ──
router.get('/profile', async (req: Request, res: Response) => {
  try {
    const prisma: PrismaClient = req.app.get('prisma');
    const { userId } = ctx(req);

    if (!userId) {
      res.status(401).json({ detail: 'Unauthorized' });
      return;
    }

    const student = await prisma.student.findUnique({
      where: { userId },
      include: {
        class: { select: { name: true } },
        section: { select: { name: true } },
      },
    });

    if (!student) {
      res.status(404).json({ detail: 'Student profile not found' });
      return;
    }

    res.json(student);
  } catch (error) {
    res.status(500).json({ type: 'internal-error', title: 'Server Error', status: 500, detail: (error as Error).message });
  }
});

// ── GET /my-classes ──
router.get('/my-classes', async (req: Request, res: Response) => {
  try {
    const prisma: PrismaClient = req.app.get('prisma');
    const { userId } = ctx(req);

    if (!userId) {
      res.status(401).json({ detail: 'Unauthorized' });
      return;
    }

    const student = await prisma.student.findUnique({
      where: { userId },
      select: { id: true, classId: true, sectionId: true, attendances: true },
    });

    if (!student) {
      res.status(404).json({ detail: 'Student not found' });
      return;
    }

    const subjects = await prisma.subject.findMany({
      where: { classId: student.classId },
      include: {
        teachers: { include: { staff: true } },
        timetableSlots: { where: { sectionId: student.sectionId } },
      },
    });

    const totalDays = student.attendances.length;
    const presentDays = student.attendances.filter(a => a.status === 'PRESENT' || a.status === 'LATE').length;
    const attendancePercentage = totalDays > 0 ? Math.round((presentDays / totalDays) * 100) : 100;

    const classesData = subjects.map(sub => {
      const teacherName = sub.teachers.length > 0 ? `${sub.teachers[0].staff.firstName} ${sub.teachers[0].staff.lastName}` : 'Unassigned';
      
      const slots = sub.timetableSlots;
      const schedStr = slots.length > 0 
        ? `${slots.map(s => s.day.substring(0, 3)).join(', ')} • ${slots[0].startTime}`
        : 'Not Scheduled';
      
      const roomStr = slots.length > 0 && slots[0].room ? slots[0].room : 'TBA';

      return {
        sub: sub.name,
        teacher: teacherName,
        sched: schedStr,
        room: roomStr,
        att: `${attendancePercentage}%`,
      };
    });

    res.json(classesData);
  } catch (error) {
    res.status(500).json({ type: 'internal-error', title: 'Server Error', status: 500, detail: (error as Error).message });
  }
});

// ── GET /my-attendance ──
router.get('/my-attendance', async (req: Request, res: Response) => {
  try {
    const prisma: PrismaClient = req.app.get('prisma');
    const { userId } = ctx(req);

    if (!userId) { return res.status(401).json({ detail: 'Unauthorized' }); }

    const student = await prisma.student.findUnique({
      where: { userId },
      include: { attendances: { orderBy: { date: 'asc' } } },
    });

    if (!student) { return res.status(404).json({ detail: 'Student not found' }); }

    const date = req.query.date ? new Date(req.query.date as string) : new Date();
    const targetMonth = date.getMonth();
    const targetYear = date.getFullYear();

    const currentMonthData = student.attendances.filter(a => {
      const d = new Date(a.date);
      return d.getMonth() === targetMonth && d.getFullYear() === targetYear;
    }).map(a => ({
      date: a.date,
      status: a.status.toLowerCase(),
    }));

    const monthlyGroups: Record<string, { w: number, p: number, a: number, l: number, sortKey: string }> = {};
    
    student.attendances.forEach(a => {
      const d = new Date(a.date);
      const monthName = d.toLocaleString('en-US', { month: 'long' });
      const year = d.getFullYear();
      const key = `${monthName}`;
      const sortKey = `${year}-${String(d.getMonth() + 1).padStart(2, '0')}`;

      if (!monthlyGroups[key]) {
        monthlyGroups[key] = { w: 0, p: 0, a: 0, l: 0, sortKey };
      }
      monthlyGroups[key].w += 1;
      
      if (a.status === 'PRESENT' || a.status === 'HALF_DAY') monthlyGroups[key].p += 1;
      if (a.status === 'ABSENT' || a.status === 'ON_LEAVE') monthlyGroups[key].a += 1;
      if (a.status === 'LATE') monthlyGroups[key].l += 1;
    });

    const monthlySummaryList = Object.keys(monthlyGroups).map(k => ({
      m: k,
      w: monthlyGroups[k].w,
      p: monthlyGroups[k].p,
      a: monthlyGroups[k].a,
      l: monthlyGroups[k].l,
      sortKey: monthlyGroups[k].sortKey,
    })).sort((a, b) => b.sortKey.localeCompare(a.sortKey)); // Sort descending

    res.json({
      currentMonth: currentMonthData,
      monthlySummary: monthlySummaryList,
    });
  } catch (error) {
    res.status(500).json({ type: 'internal-error', title: 'Server Error', status: 500, detail: (error as Error).message });
  }
});

// ── GET /my-results ──
router.get('/my-results', async (req: Request, res: Response) => {
  try {
    const prisma: PrismaClient = req.app.get('prisma');
    const { userId } = ctx(req);

    if (!userId) { return res.status(401).json({ detail: 'Unauthorized' }); }

    const student = await prisma.student.findUnique({ where: { userId } });
    if (!student) { return res.status(404).json({ detail: 'Student not found' }); }

    const results = await prisma.examResult.findMany({
      where: { studentId: student.id },
      include: {
        examSubject: {
          include: {
            subject: true,
            examination: true,
          },
        },
      },
    });

    const examMap: Record<string, any> = {};

    results.forEach(r => {
      const examName = r.examSubject.examination.name;
      const date = r.examSubject.examination.startDate;
      const dateStr = date.toLocaleString('en-US', { month: 'short', year: 'numeric' });

      if (!examMap[examName]) {
        examMap[examName] = {
          exam: examName,
          date: dateStr,
          sortDate: date.getTime(),
          subjects: [],
        };
      }

      examMap[examName].subjects.push({
        s: r.examSubject.subject.name,
        m: Number(r.marksObtained),
        max: r.examSubject.maxMarks,
      });
    });

    const examsArray = Object.values(examMap).sort((a, b) => b.sortDate - a.sortDate);
    res.json(examsArray);
  } catch (error) {
    res.status(500).json({ type: 'internal-error', title: 'Server Error', status: 500, detail: (error as Error).message });
  }
});

// ── GET /my-fees ──
router.get('/my-fees', async (req: Request, res: Response) => {
  try {
    const prisma: PrismaClient = req.app.get('prisma');
    const { userId } = ctx(req);
    if (!userId) { return res.status(401).json({ detail: 'Unauthorized' }); }

    const student = await prisma.student.findUnique({ where: { userId } });
    if (!student) { return res.status(404).json({ detail: 'Student not found' }); }

    const invoices = await prisma.feeInvoice.findMany({
      where: { studentId: student.id },
      include: { items: { include: { feeStructure: true } } },
      orderBy: { dueDate: 'desc' },
    });

    const formattedInvoices = invoices.map(inv => ({
      id: inv.id,
      inv: inv.invoiceNo,
      type: inv.items.length > 0 ? inv.items[0].feeStructure.name : 'General Fee',
      amt: `₹${Number(inv.totalAmount).toLocaleString()}`,
      due: inv.dueDate.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      status: inv.status === 'PAID' ? 'Paid' : inv.status === 'PENDING' ? 'Pending' : inv.status === 'OVERDUE' ? 'Overdue' : inv.status,
    }));

    res.json(formattedInvoices);
  } catch (error) { res.status(500).json({ detail: (error as Error).message }); }
});

// ── GET /my-timetable ──
router.get('/my-timetable', async (req: Request, res: Response) => {
  try {
    const prisma: PrismaClient = req.app.get('prisma');
    const { userId } = ctx(req);
    if (!userId) { return res.status(401).json({ detail: 'Unauthorized' }); }

    const student = await prisma.student.findUnique({ where: { userId }, include: { section: true } });
    if (!student) { return res.status(404).json({ detail: 'Student not found' }); }

    const slots = await prisma.timetableSlot.findMany({
      where: { sectionId: student.sectionId },
      include: { subject: true },
      orderBy: { startTime: 'asc' },
    });
    
    // Group by time
    const timeGroups: Record<string, any> = {};
    slots.forEach(s => {
      const timeKey = `${s.startTime} - ${s.endTime}`;
      if (!timeGroups[timeKey]) timeGroups[timeKey] = { time: timeKey, mon: '-', tue: '-', wed: '-', thu: '-', fri: '-' };
      const day = s.day.toLowerCase().substring(0, 3);
      if (['mon', 'tue', 'wed', 'thu', 'fri'].includes(day)) {
        timeGroups[timeKey][day] = s.subject.name;
      }
    });

    res.json({ className: student.section.name, timetable: Object.values(timeGroups) });
  } catch (error) { res.status(500).json({ detail: (error as Error).message }); }
});

// ── GET /my-library ──
router.get('/my-library', async (req: Request, res: Response) => {
  try {
    const prisma: PrismaClient = req.app.get('prisma');
    const { userId } = ctx(req);
    if (!userId) { return res.status(401).json({ detail: 'Unauthorized' }); }

    const student = await prisma.student.findUnique({ where: { userId } });
    if (!student) { return res.status(404).json({ detail: 'Student not found' }); }

    // Aggregate library issues and total books for stats
    const issues = await prisma.bookIssue.findMany({
      where: { studentId: student.id },
      include: { book: true },
    });

    res.json(issues);
  } catch (error) { res.status(500).json({ detail: (error as Error).message }); }
});

// ── GET /my-announcements ──
router.get('/my-announcements', async (req: Request, res: Response) => {
  try {
    const prisma: PrismaClient = req.app.get('prisma');
    const { userId } = ctx(req);
    if (!userId) { return res.status(401).json({ detail: 'Unauthorized' }); }

    const student = await prisma.student.findUnique({ where: { userId } });
    if (!student) { return res.status(404).json({ detail: 'Student not found' }); }

    const announcements = await prisma.announcement.findMany({
      where: { 
        branchId: student.branchId,
        isActive: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    // Filter down to STUDENT target rules natively in memory (arrays in Prisma can be tricky depending on PG array handling)
    const valid = announcements.filter(a => a.targetRoles.length === 0 || a.targetRoles.includes('STUDENT'));

    res.json(valid);
  } catch (error) { res.status(500).json({ detail: (error as Error).message }); }
});

// ── GET /my-transport ──
router.get('/my-transport', async (req: Request, res: Response) => {
  try {
    const prisma: PrismaClient = req.app.get('prisma');
    const { userId } = ctx(req);
    if (!userId) { return res.status(401).json({ detail: 'Unauthorized' }); }

    const student = await prisma.student.findUnique({ where: { userId } });
    if (!student) { return res.status(404).json({ detail: 'Student not found' }); }

    const routes = await prisma.transportRoute.findMany({
      where: { branchId: student.branchId, isActive: true },
      include: { vehicle: true, stops: true },
    });

    const formatted = routes.map(r => ({
      id: r.id,
      name: r.name,
      status: r.isActive ? 'Active' : 'Maintenance',
      bus: r.vehicle.vehicleNo,
      driver: r.vehicle.driverName,
      phone: r.vehicle.driverPhone,
      time: r.stops.length > 0 ? r.stops[0].pickupTime : 'N/A',
      stops: r.stops.length,
      students: Math.floor(r.vehicle.capacity * 0.8), // mock assignment
    }));

    res.json(formatted);
  } catch (error) { res.status(500).json({ detail: (error as Error).message }); }
});

// ── PUT /profile ──
router.put('/profile', async (req: Request, res: Response) => {
  try {
    const data = updateProfileSchema.parse(req.body);
    const prisma: PrismaClient = req.app.get('prisma');
    const { userId } = ctx(req);

    if (!userId) {
      res.status(401).json({ detail: 'Unauthorized' });
      return;
    }

    const student = await prisma.student.update({
      where: { userId },
      data: {
        firstName: data.firstName,
        lastName: data.lastName,
        phone: data.phone,
      },
      include: { class: { select: { name: true } }, section: { select: { name: true } } }
    });

    res.json(student);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ type: 'validation-error', title: 'Invalid Input', status: 400, errors: error.flatten().fieldErrors });
      return;
    }
    res.status(500).json({ type: 'internal-error', title: 'Server Error', status: 500, detail: (error as Error).message });
  }
});

// ── POST /change-password ──
router.post('/change-password', async (req: Request, res: Response) => {
  try {
    const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);
    const prisma: PrismaClient = req.app.get('prisma');
    const { userId } = ctx(req);

    if (!userId) {
      res.status(401).json({ detail: 'Unauthorized' });
      return;
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      res.status(404).json({ detail: 'User not found' });
      return;
    }

    const bcrypt = await import('bcryptjs');
    const isValid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!isValid) {
      res.status(400).json({ type: 'validation-error', detail: 'Current password is incorrect.' });
      return;
    }

    const newPasswordHash = await bcrypt.hash(newPassword, 12);
    await prisma.user.update({
      where: { id: userId },
      data: { passwordHash: newPasswordHash },
    });

    res.json({ success: true, message: 'Password updated successfully.' });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ type: 'validation-error', title: 'Invalid Input', status: 400, errors: error.flatten().fieldErrors });
      return;
    }
    res.status(500).json({ type: 'internal-error', title: 'Server Error', status: 500, detail: (error as Error).message });
  }
});

// ── GET /students/:id ──
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const prisma: PrismaClient = req.app.get('prisma');

    const student = await prisma.student.findUnique({
      where: { id: req.params.id },
      include: {
        user: { select: { email: true, role: true } },
        class: true,
        section: true,
        parent: true,
        attendances: { take: 30, orderBy: { date: 'desc' } },
        feeInvoices: { take: 10, orderBy: { createdAt: 'desc' } },
      },
    });

    if (!student) {
      res.status(404).json({ type: 'not-found', title: 'Student Not Found', status: 404, detail: `Student ${req.params.id} not found.` });
      return;
    }

    res.json(student);
  } catch (error) {
    res.status(500).json({ type: 'internal-error', title: 'Server Error', status: 500, detail: (error as Error).message });
  }
});

// ── POST /students ──
router.post('/', async (req: Request, res: Response) => {
  try {
    const { parentId, parent, studentPassword, parentPassword, ...studentData } = createStudentSchema.parse(req.body);
    const prisma: PrismaClient = req.app.get('prisma');
    const { branchId } = ctx(req);
    const { tenantId: schoolId } = ctx(req);
    const bcrypt = await import('bcryptjs');

    let finalParentId = parentId;
    if (!finalParentId && parent) {
      let parentUserId = null;

      if (parentPassword && parent.fatherPhone) {
        const pHash = await bcrypt.hash(parentPassword, 12);
        const pUser = await prisma.user.create({
          data: {
            email: `${parent.fatherPhone}@parent.school-erp.local`,
            passwordHash: pHash,
            role: 'PARENT',
            branchId,
            schoolId,
          }
        });
        parentUserId = pUser.id;
      }

      const newParent = await prisma.parent.create({
        data: {
          userId: parentUserId,
          fatherName: parent.fatherName,
          fatherPhone: parent.fatherPhone,
          dateOfBirth: parent.dateOfBirth || null,
          motherName: '',
          address: parent.address
        }
      });
      finalParentId = newParent.id;
    }

    if (!finalParentId) {
      res.status(400).json({ type: 'validation-error', title: 'Invalid Input', status: 400, detail: 'Either parentId or parent details must be provided.' });
      return;
    }

    // Create user account for the student
    const passwordHash = await bcrypt.hash(studentPassword || 'student123', 12);

    const user = await prisma.user.create({
      data: {
        email: `${studentData.admissionNo}@student.school-erp.local`,
        passwordHash,
        role: 'STUDENT',
        branchId,
        schoolId,
      },
    });

    const student = await prisma.student.create({
      data: {
        ...studentData,
        parentId: finalParentId,
        userId: user.id,
        branchId,
      },
      include: {
        class: { select: { name: true } },
        section: { select: { name: true } },
      },
    });

    res.status(201).json(student);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ type: 'validation-error', title: 'Invalid Input', status: 400, errors: error.flatten().fieldErrors });
      return;
    }
    res.status(500).json({ type: 'internal-error', title: 'Server Error', status: 500, detail: (error as Error).message });
  }
});

// ── PUT /students/:id ──
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const prisma: PrismaClient = req.app.get('prisma');

    const student = await prisma.student.update({
      where: { id: req.params.id },
      data: req.body,
      include: {
        class: { select: { name: true } },
        section: { select: { name: true } },
      },
    });

    res.json(student);
  } catch (error) {
    res.status(500).json({ type: 'internal-error', title: 'Server Error', status: 500, detail: (error as Error).message });
  }
});

// ── DELETE /students/:id (soft delete) ──
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const prisma: PrismaClient = req.app.get('prisma');

    await prisma.student.update({
      where: { id: req.params.id },
      data: { isActive: false },
    });

    res.status(204).send();
  } catch (error) {
    res.status(500).json({ type: 'internal-error', title: 'Server Error', status: 500, detail: (error as Error).message });
  }
});

export { router as studentRoutes };
