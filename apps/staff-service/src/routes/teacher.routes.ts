import { Router, Request, Response } from 'express';
import { PrismaClient } from '@school-erp/database';
import { ctx } from '@school-erp/auth';

export const teacherRoutes = Router();

// GET /my-classes
teacherRoutes.get('/my-classes', async (req: Request, res: Response) => {
  try {
    const prisma: PrismaClient = req.app.get('prisma');
    const { userId } = ctx(req);
    if (!userId) { return res.status(401).json({ detail: 'Unauthorized' }); }

    const staff = await prisma.staff.findUnique({ where: { userId } });
    if (!staff) { return res.status(404).json({ detail: 'Teacher profile not found' }); }

    const classes = await prisma.subjectTeacher.findMany({
      where: { staffId: staff.id },
      include: { subject: { include: { class: { include: { sections: true } } } } },
    });

    const formatted = classes.flatMap(c => 
      c.subject.class.sections.map(section => ({
        id: `${c.id}-${section.id}`,
        cls: `${c.subject.class.name}-${section.name}`,
        sub: c.subject.name,
        students: section.capacity,
        schedule: 'Mon, Wed, Fri — 09:00 AM',
        room: `Room ${Math.floor(Math.random() * 100) + 101}`,
        nextClass: 'Today, 09:00 AM',
        classId: c.subject.classId,
        sectionId: section.id,
        subjectId: c.subjectId
      }))
    );

    res.json(formatted);
  } catch (err: any) { res.status(500).json({ detail: err.message }); }
});

// GET /students?className=&sectionName=
teacherRoutes.get('/students', async (req: Request, res: Response) => {
  try {
    const prisma = req.app.get('prisma');
    const { className, sectionName } = req.query;
    if (!className || !sectionName) { return res.status(400).json({ detail: 'className and sectionName required' }); }

    const students = await prisma.student.findMany({
      where: { 
        class: { name: { contains: className as string, mode: 'insensitive' } }, 
        section: { name: sectionName as string }, 
        isActive: true 
      },
      orderBy: { firstName: 'asc' },
    });

    res.json({ data: students });
  } catch (err: any) { res.status(500).json({ detail: err.message }); }
});

// GET /leave-requests
teacherRoutes.get('/leave-requests', async (req: Request, res: Response) => {
  try {
    const prisma: PrismaClient = req.app.get('prisma');
    const { userId } = ctx(req);
    
    const staff = await prisma.staff.findUnique({ where: { userId } });
    if (!staff) { return res.status(404).json({ detail: 'Staff not found' }); }

    const requests = await prisma.leaveRequest.findMany({
      where: { staffId: staff.id },
      orderBy: { createdAt: 'desc' },
    });

    res.json(requests);
  } catch (err: any) { res.status(500).json({ detail: err.message }); }
});

// GET /attendance
teacherRoutes.get('/attendance', async (req: Request, res: Response) => {
  try {
    const prisma: PrismaClient = req.app.get('prisma');
    const { date, className, sectionName } = req.query;
    if (!date) { return res.status(400).json({ detail: 'date required' }); }

    const records = await prisma.attendance.findMany({
      where: { 
        date: new Date(date as string),
        student: { class: { name: { contains: className as string, mode: 'insensitive' } }, section: { name: sectionName as string } }
      }
    });
    res.json({ data: records });
  } catch (err: any) { res.status(500).json({ detail: err.message }); }
});

// POST /attendance
teacherRoutes.post('/attendance', async (req: Request, res: Response) => {
  try {
    const prisma: PrismaClient = req.app.get('prisma');
    const { date, records, markedBy } = req.body;
    const { branchId } = ctx(req);
    if (!branchId) {
      res.status(403).json({ detail: 'Account has no branch — cannot mark attendance.' });
      return;
    }
    
    const results = await Promise.all(records.map((r: any) => 
      prisma.attendance.upsert({
        where: { date_studentId: { date: new Date(date), studentId: r.studentId } },
        create: { date: new Date(date), status: r.status, studentId: r.studentId, markedBy, branchId },
        update: { status: r.status, markedBy }
      })
    ));

    res.json({ message: 'Saved successfully', count: results.length });
  } catch (err: any) { res.status(500).json({ detail: err.message }); }
});

// GET /marks
teacherRoutes.get('/marks', async (req: Request, res: Response) => {
  try {
    const prisma: PrismaClient = req.app.get('prisma');
    const { className, sectionName } = req.query;
    
    const records = await prisma.examResult.findMany({
      where: { student: { class: { name: { contains: className as string, mode: 'insensitive' } }, section: { name: sectionName as string } } }
    });
    res.json({ data: records });
  } catch (err: any) { res.status(500).json({ detail: err.message }); }
});

// POST /marks
teacherRoutes.post('/marks', async (req: Request, res: Response) => {
  try {
    const prisma: PrismaClient = req.app.get('prisma');
    const { marks, examSubjectId: bodyExamSubjectId, className, sectionName, subjectName } = req.body;
    if (!Array.isArray(marks) || marks.length === 0) {
      return res.status(400).json({ detail: 'marks array required' });
    }

    let examSubjectId = bodyExamSubjectId as string | undefined;
    if (!examSubjectId && className && sectionName) {
      const student = await prisma.student.findFirst({
        where: {
          isActive: true,
          class: { name: { contains: className as string, mode: 'insensitive' } },
          section: { name: sectionName as string },
        },
        select: { classId: true },
      });
      if (!student) return res.status(400).json({ detail: 'No students found for class/section' });

      const subjectWhere: any = { classId: student.classId };
      if (subjectName) subjectWhere.name = { contains: subjectName as string, mode: 'insensitive' };
      const subject = await prisma.subject.findFirst({ where: subjectWhere, orderBy: { name: 'asc' } });
      if (!subject) return res.status(400).json({ detail: 'No subject found for this class' });

      const examSubject = await prisma.examSubject.findFirst({
        where: { subjectId: subject.id },
        orderBy: { createdAt: 'desc' },
      });
      examSubjectId = examSubject?.id;
    }

    if (!examSubjectId) {
      return res.status(400).json({ detail: 'Could not resolve exam paper. Pass examSubjectId or className, sectionName (and optional subjectName).' });
    }

    const results = await Promise.all(marks.map((m: any) => {
      const val = m.marksObtained ?? m.marks;
      return prisma.examResult.upsert({
        where: { examSubjectId_studentId: { examSubjectId, studentId: m.studentId } },
        create: { examSubjectId, studentId: m.studentId, marksObtained: val },
        update: { marksObtained: val, ...(m.remarks !== undefined ? { remarks: m.remarks } : {}) },
      });
    }));

    res.json({ message: 'Saved successfully', count: results.length });
  } catch (err: any) { res.status(500).json({ detail: err.message }); }
});

// POST /leave-requests
teacherRoutes.post('/leave-requests', async (req: Request, res: Response) => {
  try {
    const prisma: PrismaClient = req.app.get('prisma');
    const { userId } = ctx(req);
    
    const staff = await prisma.staff.findUnique({ where: { userId } });
    if (!staff) { return res.status(404).json({ detail: 'Staff not found' }); }

    const newReq = await prisma.leaveRequest.create({
      data: {
        staffId: staff.id,
        leaveType: req.body.leaveType,
        startDate: new Date(req.body.startDate),
        endDate: new Date(req.body.endDate),
        reason: req.body.reason,
        status: 'PENDING',
      }
    });

    res.status(201).json(newReq);
  } catch (err: any) { res.status(500).json({ detail: err.message }); }
});

// GET /my-library
teacherRoutes.get('/my-library', async (req: Request, res: Response) => {
  try {
    const prisma: PrismaClient = req.app.get('prisma');
    const { userId } = ctx(req);
    const staff = await prisma.staff.findUnique({ where: { userId } });
    if (!staff) { return res.status(404).json({ detail: 'Staff not found' }); }

    // Teachers are not supported in BookIssue schema - return empty
    res.json([]);
  } catch (error) { res.status(500).json({ detail: (error as Error).message }); }
});

// GET /my-announcements
teacherRoutes.get('/my-announcements', async (req: Request, res: Response) => {
  try {
    const prisma: PrismaClient = req.app.get('prisma');
    const { userId } = ctx(req);
    const staff = await prisma.staff.findUnique({ where: { userId } });
    if (!staff) { return res.status(404).json({ detail: 'Staff not found' }); }

    const announcements = await prisma.announcement.findMany({
      where: { branchId: staff.branchId, isActive: true },
      orderBy: { createdAt: 'desc' },
    });

    const valid = announcements.filter(a => a.targetRoles.length === 0 || a.targetRoles.includes('TEACHER'));
    res.json(valid);
  } catch (error) { res.status(500).json({ detail: (error as Error).message }); }
});

// GET /my-transport
teacherRoutes.get('/my-transport', async (req: Request, res: Response) => {
  try {
    const prisma: PrismaClient = req.app.get('prisma');
    const { userId } = ctx(req);
    const staff = await prisma.staff.findUnique({ where: { userId } });
    if (!staff) { return res.status(404).json({ detail: 'Staff not found' }); }

    const routes = await prisma.transportRoute.findMany({
      where: { branchId: staff.branchId, isActive: true },
      include: { vehicle: true, stops: true },
    });

    const formatted = routes.map(r => ({
      id: r.id, name: r.name, status: r.isActive ? 'Active' : 'Maintenance',
      bus: r.vehicle.vehicleNo, driver: r.vehicle.driverName, phone: r.vehicle.driverPhone,
      time: r.stops.length > 0 ? r.stops[0].pickupTime : 'N/A', stops: r.stops.length,
      students: Math.floor(r.vehicle.capacity * 0.8), 
    }));
    res.json(formatted);
  } catch (error) { res.status(500).json({ detail: (error as Error).message }); }
});

// GET /profile
teacherRoutes.get('/profile', async (req: Request, res: Response) => {
  try {
    const prisma: PrismaClient = req.app.get('prisma');
    const { userId } = ctx(req);
    const staff = await prisma.staff.findUnique({ where: { userId } });
    if (!staff) return res.status(404).json({ detail: 'Profile not found' });
    res.json(staff);
  } catch (err: any) { res.status(500).json({ detail: err.message }); }
});

// PUT /profile
teacherRoutes.put('/profile', async (req: Request, res: Response) => {
  try {
    const prisma = req.app.get('prisma');
    const { userId } = ctx(req);
    const { firstName, lastName, phone } = req.body;
    const staff = await prisma.staff.update({
      where: { userId },
      data: { firstName, lastName, phone }
    });
    res.json(staff);
  } catch (err: any) { res.status(500).json({ detail: err.message }); }
});

// GET /timetable
teacherRoutes.get('/timetable', async (req: Request, res: Response) => {
  try {
    const prisma = req.app.get('prisma');
    const { userId } = ctx(req);
    const staff = await prisma.staff.findUnique({ 
      where: { userId }, 
      include: { subjectTeachers: { include: { subject: { include: { class: { include: { sections: true } } } } } } } 
    });
    
    // Map subjects into a simple schedule grid structure
    const st = staff?.subjectTeachers || [];
    const timetable = [
      { time: '09:00 - 09:45', mon: st[0]?.subject.name || 'Planning', tue: st[1]?.subject.name || 'Admin', wed: st[0]?.subject.name || '-', thu: st[1]?.subject.name || '-', fri: st[0]?.subject.name || '-' },
      { time: '09:45 - 10:30', mon: st[1]?.subject.name || '-', tue: st[0]?.subject.name || '-', wed: st[1]?.subject.name || '-', thu: st[0]?.subject.name || '-', fri: st[1]?.subject.name || '-' },
      { time: '10:30 - 10:45', mon: 'Break', tue: 'Break', wed: 'Break', thu: 'Break', fri: 'Break' },
      { time: '10:45 - 11:30', mon: st[0]?.subject.name || '-', tue: st[1]?.subject.name || '-', wed: st[0]?.subject.name || '-', thu: st[1]?.subject.name || '-', fri: st[0]?.subject.name || '-' },
    ];
    res.json({ className: 'Assigned Classes', timetable });
  } catch (err: any) { res.status(500).json({ detail: err.message }); }
});

// GET /dashboard
teacherRoutes.get('/dashboard', async (req: Request, res: Response) => {
  try {
    const prisma = req.app.get('prisma');
    const { userId } = ctx(req);
    const staff = await prisma.staff.findUnique({ 
      where: { userId }, 
      include: { subjectTeachers: { include: { subject: { include: { class: { include: { sections: true } } } } } } } 
    });
    
    if (!staff) return res.json({ totalClasses: 0, totalStudents: 0, attendanceToday: '0/0', examsPending: 0, schedule: [], tasks: [], classOverview: [] });

    // Flatten subject->class->sections
    const assignedSections = staff.subjectTeachers.flatMap((s: any) => 
      s.subject.class.sections.map((sec: any) => ({
        clsName: s.subject.class.name,
        secName: sec.name,
        subject: s.subject.name,
        cap: sec.capacity
      }))
    );

    const uniqueClasses = new Set(assignedSections.map((s: any) => `${s.clsName}-${s.secName}`)).size;
    const totalStudents = assignedSections.reduce((acc: number, curr: any) => acc + curr.cap, 0);

    const schedule = assignedSections.slice(0, 4).map((s: any, i: number) => ({
      time: ['9:00-9:45', '9:45-10:30', '11:00-11:45', '12:00-12:45'][i],
      cls: `${s.clsName}-${s.secName}`,
      sub: s.subject,
      room: `Room 10${i}`
    }));

    const classOverview = assignedSections.slice(0, 3).map((s: any) => ({
      cls: `${s.clsName}-${s.secName}`,
      students: s.cap,
      att: '95%',
      avg: 80
    }));

    res.json({
      totalClasses: uniqueClasses,
      totalStudents,
      attendanceToday: `${Math.floor(totalStudents * 0.95)}/${totalStudents}`,
      examsPending: uniqueClasses > 0 ? 1 : 0,
      schedule,
      tasks: [ { t: 'Update Gradebook', due: 'Tomorrow', p: 'High' } ],
      classOverview
    });
  } catch (err: any) { res.status(500).json({ detail: err.message }); }
});

// POST /change-password
teacherRoutes.post('/change-password', async (req: Request, res: Response) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const prisma = req.app.get('prisma');
    const { userId } = ctx(req);

    if (!userId) return res.status(401).json({ detail: 'Unauthorized' });

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ detail: 'User not found' });

    const bcrypt = await import('bcryptjs');
    const isValid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!isValid) return res.status(400).json({ detail: 'Current password is incorrect.' });

    const newPasswordHash = await bcrypt.hash(newPassword, 12);
    await prisma.user.update({
      where: { id: userId },
      data: { passwordHash: newPasswordHash },
    });

    res.json({ success: true, message: 'Password updated successfully.' });
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});
