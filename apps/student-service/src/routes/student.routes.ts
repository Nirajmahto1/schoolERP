// ──────────────────────────────────────────────
// Student CRUD Routes
//
// Phase 2 shapes:
//   • A student's class/section comes from StudentEnrollment (history is a
//     feature, not a column) — every read resolves the CURRENT enrollment.
//   • Guardians are people (Guardian) linked via StudentGuardian; the old
//     embedded Parent row is gone.
//   • Attendance is session/record based; monthly percentages come from
//     AttendanceMonthlySummary.
//   • Invoices are Invoice + InvoiceLine + FeeHead (no FeeInvoice/FeeItem).
//   • User carries no role/branchId/schoolId — identity is User + roles.
// ──────────────────────────────────────────────

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { PrismaClient } from '@school-erp/database';
import { ctx } from '@school-erp/auth';

const router = Router();

/** The branch's current academic year — the anchor for "live" class/section. */
async function currentYear(prisma: PrismaClient, branchId: string) {
  return prisma.academicYear.findFirst({ where: { branchId, isCurrent: true } });
}

/** A student's enrollment for a year (defaults to the branch's current year). */
async function enrollmentFor(
  prisma: PrismaClient,
  studentId: string,
  branchId: string,
  academicYearId?: string | null,
) {
  const yearId =
    academicYearId ??
    (await currentYear(prisma, branchId))?.id ??
    null;
  return prisma.studentEnrollment.findFirst({
    where: { studentId, ...(yearId ? { academicYearId: yearId } : {}) },
    include: {
      class: { select: { id: true, name: true } },
      section: { select: { id: true, name: true } },
    },
    orderBy: { fromDate: 'desc' },
  });
}

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
  guardianId: z.string().optional(),
  guardian: z.object({
    fullName: z.string().min(1),
    phone: z.string().min(1),
    email: z.string().email().optional(),
    occupation: z.string().optional(),
    relation: z.enum(['FATHER', 'MOTHER', 'GUARDIAN', 'GRANDFATHER', 'GRANDMOTHER']).default('FATHER'),
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
    if (!branchId) {
      res.status(403).json({ type: 'authorization-error', title: 'Forbidden', status: 403, detail: 'Account has no branch.' });
      return;
    }
    const { cursor, limit = '20', classId, sectionId, search, academicYearId } = req.query;

    const take = Math.min(parseInt(limit as string), 100);

    const where: any = { branchId, deletedAt: null };
    const enrollmentWhere: any = { status: 'ENROLLED' };
    if (academicYearId) enrollmentWhere.academicYearId = academicYearId;
    if (classId) enrollmentWhere.classId = classId;
    if (sectionId) enrollmentWhere.sectionId = sectionId;
    where.enrollments = { some: enrollmentWhere };
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
        enrollments: {
          where: enrollmentWhere,
          include: {
            class: { select: { name: true } },
            section: { select: { name: true } },
          },
          take: 1,
        },
        guardians: {
          where: { isPrimary: true },
          include: { guardian: { select: { fullName: true, phone: true } } },
          take: 1,
        },
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
        branch: { select: { id: true, name: true } },
        enrollments: {
          orderBy: { fromDate: 'desc' },
          take: 1,
          include: {
            class: { select: { name: true } },
            section: { select: { name: true } },
          },
        },
        bookIssues: { where: { status: 'ISSUED' }, include: { book: true } },
        examResults: { take: 5, orderBy: { createdAt: 'desc' }, include: { examSubject: { include: { subject: true } } } },
      },
    });

    if (!student) {
      res.status(404).json({ detail: 'Student profile not found.' });
      return;
    }

    // Attendance percentage from the denormalised monthly summary (never
    // recomputed from raw rows per request).
    const summaries = await prisma.attendanceMonthlySummary.aggregate({
      where: { studentId: student.id },
      _sum: { workingDays: true, presentDays: true, lateDays: true, halfDays: true },
    });
    const workingDays = Number(summaries._sum.workingDays ?? 0);
    const attendedDays =
      Number(summaries._sum.presentDays ?? 0) +
      Number(summaries._sum.lateDays ?? 0) +
      Number(summaries._sum.halfDays ?? 0);
    const attendancePercentage = workingDays > 0 ? Math.round((attendedDays / workingDays) * 100) : 100;

    // Open dues: ISSUED / PARTIALLY_PAID / OVERDUE invoices.
    const openInvoices = await prisma.invoice.findMany({
      where: {
        studentId: student.id,
        status: { in: ['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'] },
        deletedAt: null,
      },
      select: { totalAmount: true, paidAmount: true },
    });
    const pendingFeesTotal = openInvoices.reduce(
      (sum, inv) => sum + Number(inv.totalAmount) - Number(inv.paidAmount), 0,
    );

    const enrollment = student.enrollments[0];

    // Get today's timetable
    const days = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
    const today = days[new Date().getDay()];

    const timetable = enrollment
      ? await prisma.timetableSlot.findMany({
          where: { sectionId: enrollment.sectionId, day: today },
          include: { subject: { include: { teachers: { include: { staff: true } } } } },
          orderBy: { startTime: 'asc' },
        })
      : [];

    // Get recent announcements
    const announcements = await prisma.announcement.findMany({
      where: { targetRoles: { has: 'STUDENT' }, branchId: student.branchId, isActive: true },
      orderBy: { createdAt: 'desc' },
      take: 3,
    });

    const { enrollments: _e, ...studentPlain } = student;
    res.json({
      student: { ...studentPlain, enrollment },
      stats: {
        attendancePercentage,
        pendingFeesCount: openInvoices.length,
        pendingFeesTotal,
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
      include: { branch: { select: { id: true, name: true } } },
    });

    if (!student) {
      res.status(404).json({ detail: 'Student profile not found' });
      return;
    }

    const enrollment = await enrollmentFor(prisma, student.id, student.branchId);
    res.json({ ...student, enrollment });
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
      select: { id: true, branchId: true },
    });

    if (!student) {
      res.status(404).json({ detail: 'Student not found' });
      return;
    }

    const enrollment = await enrollmentFor(prisma, student.id, student.branchId);
    if (!enrollment) {
      res.status(404).json({ detail: 'Student has no active enrollment' });
      return;
    }

    const subjects = await prisma.subject.findMany({
      where: { classId: enrollment.classId, deletedAt: null },
      include: {
        teachers: { include: { staff: true } },
        timetableSlots: { where: { sectionId: enrollment.sectionId } },
      },
    });

    // Attendance percentage from the monthly summaries.
    const summaries = await prisma.attendanceMonthlySummary.aggregate({
      where: { studentId: student.id },
      _sum: { workingDays: true, presentDays: true, lateDays: true, halfDays: true },
    });
    const workingDays = Number(summaries._sum.workingDays ?? 0);
    const attendedDays =
      Number(summaries._sum.presentDays ?? 0) +
      Number(summaries._sum.lateDays ?? 0) +
      Number(summaries._sum.halfDays ?? 0);
    const attendancePercentage = workingDays > 0 ? Math.round((attendedDays / workingDays) * 100) : 100;

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
      include: {
        attendanceRecords: {
          orderBy: { createdAt: 'asc' },
          include: { session: { select: { date: true } } },
        },
      },
    });

    if (!student) { return res.status(404).json({ detail: 'Student not found' }); }

    const date = req.query.date ? new Date(req.query.date as string) : new Date();
    const targetMonth = date.getMonth();
    const targetYear = date.getFullYear();

    const currentMonthData = student.attendanceRecords
      .filter(a => {
        const d = new Date(a.session.date);
        return d.getMonth() === targetMonth && d.getFullYear() === targetYear;
      })
      .map(a => ({
        date: a.session.date,
        status: a.status.toLowerCase(),
      }));

    const monthlyGroups: Record<string, { w: number, p: number, a: number, l: number, sortKey: string }> = {};

    student.attendanceRecords.forEach(a => {
      const d = new Date(a.session.date);
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

    const invoices = await prisma.invoice.findMany({
      where: { studentId: student.id, deletedAt: null },
      include: { lines: { include: { feeHead: true } } },
      orderBy: { dueDate: 'desc' },
    });

    const formattedInvoices = invoices.map(inv => ({
      id: inv.id,
      inv: inv.invoiceNo,
      type: inv.lines.length > 0 ? inv.lines[0].feeHead.name : 'General Fee',
      amt: `₹${Number(inv.totalAmount).toLocaleString()}`,
      due: inv.dueDate.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      status:
        inv.status === 'PAID' ? 'Paid'
        : inv.status === 'ISSUED' || inv.status === 'DRAFT' ? 'Pending'
        : inv.status === 'OVERDUE' ? 'Overdue'
        : inv.status,
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

    const student = await prisma.student.findUnique({ where: { userId } });
    if (!student) { return res.status(404).json({ detail: 'Student not found' }); }

    const enrollment = await enrollmentFor(prisma, student.id, student.branchId);
    if (!enrollment) { return res.status(404).json({ detail: 'Student has no active enrollment' }); }

    const slots = await prisma.timetableSlot.findMany({
      where: { sectionId: enrollment.sectionId },
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

    res.json({ className: enrollment.section.name, timetable: Object.values(timeGroups) });
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
// Scoped to the caller's branch: a request for another tenant's student id
// must 404, never 200 — a 404 does not confirm the resource exists.
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const prisma: PrismaClient = req.app.get('prisma');
    const { branchId } = ctx(req);
    if (!branchId) {
      res.status(403).json({ type: 'authorization-error', title: 'Forbidden', status: 403, detail: 'Account has no branch.' });
      return;
    }

    const student = await prisma.student.findFirst({
      where: { id: req.params.id, branchId },
      include: {
        user: { select: { email: true, roleAssignments: { include: { role: { select: { code: true } } } } } },
        enrollments: {
          orderBy: { fromDate: 'desc' },
          include: { class: true, section: true },
        },
        guardians: { include: { guardian: true } },
        attendanceRecords: {
          take: 30,
          orderBy: { createdAt: 'desc' },
          include: { session: { select: { date: true } } },
        },
        invoices: { take: 10, orderBy: { createdAt: 'desc' }, where: { deletedAt: null } },
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
    const { guardianId, guardian, studentPassword, parentPassword, classId, sectionId, ...studentData } = createStudentSchema.parse(req.body);
    const prisma: PrismaClient = req.app.get('prisma');
    const { branchId } = ctx(req);
    if (!branchId) {
      res.status(403).json({ type: 'authorization-error', title: 'Forbidden', status: 403, detail: 'Account has no branch.' });
      return;
    }
    const bcrypt = await import('bcryptjs');

    const year = await currentYear(prisma, branchId);
    if (!year) {
      res.status(400).json({ type: 'validation-error', title: 'Invalid Input', status: 400, detail: 'Branch has no current academic year.' });
      return;
    }

    // Section must belong to the class.
    const section = await prisma.section.findFirst({ where: { id: sectionId, classId } });
    if (!section) {
      res.status(400).json({ type: 'validation-error', title: 'Invalid Input', status: 400, detail: 'Section does not belong to the given class.' });
      return;
    }

    const student = await prisma.$transaction(async (tx) => {
      // Link (or create) the guardian. Guardians are people, shared across
      // siblings via StudentGuardian — never embedded per student.
      let finalGuardianId = guardianId;
      if (!finalGuardianId && guardian) {
        let guardianUserId: string | null = null;

        if (parentPassword) {
          const pHash = await bcrypt.hash(parentPassword, 12);
          const pUser = await tx.user.create({
            data: {
              email: guardian.email ?? `${guardian.phone}@parent.school-erp.local`,
              passwordHash: pHash,
              defaultBranchId: branchId,
              roleAssignments: { create: { roleId: 'sys_parent', branchId } },
            },
          });
          guardianUserId = pUser.id;
        }

        const newGuardian = await tx.guardian.create({
          data: {
            userId: guardianUserId,
            fullName: guardian.fullName,
            phone: guardian.phone,
            email: guardian.email ?? `${guardian.phone}@parent.school-erp.local`,
            occupation: guardian.occupation,
          },
        });
        finalGuardianId = newGuardian.id;
      }

      if (!finalGuardianId) {
        throw Object.assign(new Error('Either guardianId or guardian details must be provided.'), { status: 400 });
      }

      // User account for the student (identity: User + role assignment).
      const passwordHash = await bcrypt.hash(studentPassword || 'student123', 12);
      const user = await tx.user.create({
        data: {
          email: `${studentData.admissionNo}@student.school-erp.local`,
          passwordHash,
          defaultBranchId: branchId,
          roleAssignments: { create: { roleId: 'sys_student', branchId } },
        },
      });

      const created = await tx.student.create({
        data: {
          ...studentData,
          userId: user.id,
          branchId,
          guardians: {
            create: { guardianId: finalGuardianId, relation: guardian?.relation ?? 'FATHER', isPrimary: true },
          },
          enrollments: {
            create: {
              academicYearId: year.id,
              branchId,
              classId,
              sectionId,
              status: 'ENROLLED',
              fromDate: studentData.admissionDate,
              createdBy: ctx(req).userId,
            },
          },
        },
      });

      return created;
    });

    res.status(201).json(student);
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (error instanceof z.ZodError) {
      res.status(400).json({ type: 'validation-error', title: 'Invalid Input', status: 400, errors: error.flatten().fieldErrors });
      return;
    }
    if (status) {
      res.status(status).json({ type: 'validation-error', title: 'Invalid Input', status, detail: (error as Error).message });
      return;
    }
    res.status(500).json({ type: 'internal-error', title: 'Server Error', status: 500, detail: (error as Error).message });
  }
});

// ── PUT /students/:id ──
// updateMany with the branch scoping: cross-tenant ids update nothing and 404.
// Identity-bearing fields are stripped from the body — they come from the
// assertion, never from the client.
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const prisma: PrismaClient = req.app.get('prisma');
    const { branchId } = ctx(req);
    if (!branchId) {
      res.status(403).json({ type: 'authorization-error', title: 'Forbidden', status: 403, detail: 'Account has no branch.' });
      return;
    }

    const data = { ...req.body };
    delete data.id;
    delete data.branchId;
    delete data.userId;
    // Class/section changes go through enrollment/promotion, not a column.
    delete data.classId;
    delete data.sectionId;
    delete data.enrollments;
    delete data.guardians;

    const updated = await prisma.student.updateMany({
      where: { id: req.params.id, branchId },
      data,
    });

    if (updated.count === 0) {
      res.status(404).json({ type: 'not-found', title: 'Student Not Found', status: 404, detail: `Student ${req.params.id} not found.` });
      return;
    }

    const student = await prisma.student.findUnique({
      where: { id: req.params.id },
    });

    res.json(student);
  } catch (error) {
    res.status(500).json({ type: 'internal-error', title: 'Server Error', status: 500, detail: (error as Error).message });
  }
});

// ── DELETE /students/:id (soft delete) ──
// Scoped like the other by-id routes: cross-tenant ids soft-delete nothing and 404.
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const prisma: PrismaClient = req.app.get('prisma');
    const { branchId } = ctx(req);
    if (!branchId) {
      res.status(403).json({ type: 'authorization-error', title: 'Forbidden', status: 403, detail: 'Account has no branch.' });
      return;
    }

    const updated = await prisma.student.updateMany({
      where: { id: req.params.id, branchId },
      data: { isActive: false, deletedAt: new Date(), deletedBy: ctx(req).userId },
    });

    if (updated.count === 0) {
      res.status(404).json({ type: 'not-found', title: 'Student Not Found', status: 404, detail: `Student ${req.params.id} not found.` });
      return;
    }

    res.status(204).send();
  } catch (error) {
    res.status(500).json({ type: 'internal-error', title: 'Server Error', status: 500, detail: (error as Error).message });
  }
});

export { router as studentRoutes };
