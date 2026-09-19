import { Router, Request, Response } from 'express';
import multer from 'multer';
import { PrismaClient } from '@school-erp/database';
import { ctx } from '@school-erp/auth';
import { notifyStaffUser } from '@school-erp/notify';
import { MAX_PHOTO_BYTES, PhotoError, deletePhotoByUrl, readPhotoByName, savePhoto } from '../photos';

// Peer-notification endpoints, injected by the entrypoint (app.set) so the
// route file stays free of env plumbing. Undefined = peer call skipped.
let internalAssertionPrivateKey: string | undefined;
let communicationBaseUrl: string | undefined;
let notificationEngineUrl: string | undefined;

/** The verified request identity (the approver), when the assertion carries it.
 *  tenantId may be '' — single-DB deployments mint assertions with an empty
 *  tenant, and the peer routes key on branchId, not tenant. */
const identityOf = (req: Request): { userId: string; email: string; tenantId: string; branchId: string | null } | null => {
  const c = ctx(req);
  return c.userId ? { userId: c.userId, email: c.email, tenantId: c.tenantId, branchId: c.branchId } : null;
};

export function configureTeacherNotifications(cfg: {
  internalAssertionPrivateKey?: string;
  communicationBaseUrl?: string;
  notificationEngineUrl?: string;
}): void {
  internalAssertionPrivateKey = cfg.internalAssertionPrivateKey;
  communicationBaseUrl = cfg.communicationBaseUrl;
  notificationEngineUrl = cfg.notificationEngineUrl;
}

export const teacherRoutes = Router();

const prismaOf = (req: Request): PrismaClient => req.app.get('prisma') as PrismaClient;

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

// GET /students?className=&sectionName=&search=
// className/sectionName are OPTIONAL now — the teacher mobile directory opens
// with a whole-branch search and no picker, so requiring them 400s the first
// load ("className and sectionName required"). Both, when given, narrow the
// CURRENT enrollment; `search` matches name or admission number.
teacherRoutes.get('/students', async (req: Request, res: Response) => {
  try {
    const prisma = req.app.get('prisma');
    const { className, sectionName, search } = req.query;

    const students = await prisma.student.findMany({
      where: {
        deletedAt: null,
        ...(search
          ? {
              OR: [
                { firstName: { contains: search as string, mode: 'insensitive' as const } },
                { lastName: { contains: search as string, mode: 'insensitive' as const } },
                { admissionNo: { contains: search as string, mode: 'insensitive' as const } },
              ],
            }
          : {}),
        enrollments: {
          some: {
            status: 'ENROLLED',
            ...(className
              ? { class: { name: { contains: className as string, mode: 'insensitive' } } }
              : {}),
            ...(sectionName ? { section: { name: sectionName as string } } : {}),
          },
        },
      },
      orderBy: { firstName: 'asc' },
      take: 300,
      include: {
        enrollments: {
          where: { status: 'ENROLLED' },
          take: 1,
          select: { rollNo: true, class: { select: { name: true } }, section: { select: { name: true } } },
        },
      },
    });

    // Flatten the current enrollment onto the row so the mobile directory
    // can show "ADM-01 · LKG-A" without extra round-trips.
    res.json({
      data: students.map((s: (typeof students)[number]) => {
        const e = s.enrollments[0];
        return {
          id: s.id,
          admissionNo: s.admissionNo,
          firstName: s.firstName,
          lastName: s.lastName,
          name: `${s.firstName} ${s.lastName}`.trim(),
          className: e?.class?.name ?? null,
          sectionName: e?.section?.name ?? null,
          rollNo: e?.rollNo ?? null,
          photoUrl: s.photo ?? null,
        };
      }),
    });
  } catch (err: any) { res.status(500).json({ detail: err.message }); }
});

// ── Profile photos ──
// Multipart 'photo' (JPG/PNG ≤ 5MB). Bytes are sniffed, not trusted; the old
// file is unlinked only after the DB row is safely on the new one.
const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PHOTO_BYTES, files: 1 },
});

/** POST /teacher/me/photo — a staff member sets their OWN photo. */
teacherRoutes.post('/me/photo', photoUpload.single('photo'), async (req: Request, res: Response) => {
  try {
    const { userId, branchId } = ctx(req);
    if (!userId) { res.status(401).json({ detail: 'Unauthorized' }); return; }
    if (!req.file) { res.status(400).json({ detail: 'Attach the photo as multipart field "photo".' }); return; }

    const staff = await prismaOf(req).staff.findFirst({ where: { userId, deletedAt: null } });
    if (!staff) { res.status(404).json({ detail: 'No staff record for this account.' }); return; }

    const saved = await savePhoto(req.file.buffer);
    const updated = await prismaOf(req).staff.update({
      where: { id: staff.id },
      data: { photo: saved.url },
      select: { photo: true },
    });
    await deletePhotoByUrl(staff.photo); // old bytes out, row already moved
    res.json({ photoUrl: updated.photo, ...saved });
  } catch (e) {
    if (e instanceof PhotoError) { res.status(e.status).json({ detail: e.message }); return; }
    if ((e as any)?.code === 'LIMIT_FILE_SIZE') { res.status(413).json({ detail: 'Photo must be 5 MB or smaller.' }); return; }
    res.status(500).json({ detail: (e as Error).message });
  }
});

/** POST /teacher/students/:id/photo — staff sets a student's photo.
 *  Branch-checked: only students with an ENROLLED enrollment in the caller's
 *  branch can be touched. */
teacherRoutes.post('/students/:id/photo', photoUpload.single('photo'), async (req: Request, res: Response) => {
  try {
    const { branchId } = ctx(req);
    if (!branchId) { res.status(403).json({ detail: 'Account has no branch.' }); return; }
    if (!req.file) { res.status(400).json({ detail: 'Attach the photo as multipart field "photo".' }); return; }

    const student = await prismaOf(req).student.findFirst({
      where: { id: req.params.id, deletedAt: null, enrollments: { some: { status: 'ENROLLED', branchId } } },
    });
    if (!student) { res.status(404).json({ detail: 'Student not found in your branch.' }); return; }

    const saved = await savePhoto(req.file.buffer);
    const updated = await prismaOf(req).student.update({
      where: { id: student.id },
      data: { photo: saved.url },
      select: { photo: true },
    });
    await deletePhotoByUrl(student.photo);
    res.json({ photoUrl: updated.photo, ...saved });
  } catch (e) {
    if (e instanceof PhotoError) { res.status(e.status).json({ detail: e.message }); return; }
    if ((e as any)?.code === 'LIMIT_FILE_SIZE') { res.status(413).json({ detail: 'Photo must be 5 MB or smaller.' }); return; }
    res.status(500).json({ detail: (e as Error).message });
  }
});

// GET /leave-requests
// Decision details ride along: who decided it, their optional note (stored
// appended to `reason` — split back out here, never shown as the teacher's
// own words), and when (updatedAt doubles as the decision timestamp once the
// row leaves PENDING).
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

    res.json(requests.map((r) => {
      const { reason, decisionNote } = splitDecisionNote(r.reason);
      return {
        id: r.id,
        leaveType: r.leaveType,
        startDate: r.startDate,
        endDate: r.endDate,
        reason,
        decisionNote,
        status: r.status,
        approvedBy: r.status === 'PENDING' ? null : r.approvedBy,
        decidedAt: r.status === 'PENDING' ? null : r.updatedAt,
        createdAt: r.createdAt,
      };
    }));
  } catch (err: any) { res.status(500).json({ detail: err.message }); }
});

// GET /attendance
teacherRoutes.get('/attendance', async (req: Request, res: Response) => {
  try {
    const prisma: PrismaClient = req.app.get('prisma');
    const { date, className, sectionName } = req.query;
    if (!date) { return res.status(400).json({ detail: 'date required' }); }

    const sessions = await prisma.attendanceSession.findMany({
      where: {
        date: new Date(date as string),
        ...(className || sectionName
          ? {
              class: {
                name: className ? { contains: className as string, mode: 'insensitive' } : undefined,
                ...(sectionName ? { sections: { some: { name: sectionName as string } } } : {}),
              },
            }
          : {}),
      },
      include: { records: true },
    });
    res.json({ data: sessions.flatMap((s) => s.records) });
  } catch (err: any) { res.status(500).json({ detail: err.message }); }
});

// POST /attendance
teacherRoutes.post('/attendance', async (req: Request, res: Response) => {
  try {
    const prisma: PrismaClient = req.app.get('prisma');
    const { date, records, markedBy, classId, sectionId } = req.body;
    const { branchId, userId } = ctx(req);
    if (!branchId) {
      res.status(403).json({ detail: 'Account has no branch — cannot mark attendance.' });
      return;
    }
    if (!classId || !sectionId) {
      return res.status(400).json({ detail: 'classId and sectionId required' });
    }

    const day = new Date(date);
    const academicYear = await prisma.academicYear.findFirst({
      where: { branchId, startDate: { lte: day }, endDate: { gte: day } },
    });
    if (!academicYear) {
      return res.status(400).json({ detail: 'Date falls outside any academic year.' });
    }

    const session = await prisma.attendanceSession.upsert({
      where: {
        branchId_date_classId_sectionId_subjectId_period: {
          branchId, date: day, classId, sectionId, subjectId: null as unknown as string, period: null as unknown as number,
        },
      },
      create: { branchId, date: day, classId, sectionId, academicYearId: academicYear.id, markedBy: markedBy ?? userId },
      update: { markedBy: markedBy ?? userId },
    });

    const results = await Promise.all(records.map((r: any) =>
      prisma.attendanceRecord.upsert({
        where: { sessionId_studentId: { sessionId: session.id, studentId: r.studentId } },
        create: { sessionId: session.id, studentId: r.studentId, status: r.status, reason: r.remarks ?? null },
        update: { status: r.status, reason: r.remarks ?? null },
      }),
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
      where: {
        student: {
          deletedAt: null,
          enrollments: {
            some: {
              status: 'ENROLLED',
              class: { name: { contains: className as string, mode: 'insensitive' } },
              ...(sectionName ? { section: { name: sectionName as string } } : {}),
            },
          },
        },
      },
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
      const enrollment = await prisma.studentEnrollment.findFirst({
        where: {
          status: 'ENROLLED',
          class: { name: { contains: className as string, mode: 'insensitive' } },
          section: { name: sectionName as string },
        },
        select: { classId: true },
      });
      if (!enrollment) return res.status(400).json({ detail: 'No students found for class/section' });
      const classId = enrollment.classId;

      const subjectWhere: any = { classId };
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

// ── Leave approvals (HOD / Principal / admins) ──
// HODs see only their own department's requests; Principal and above see the
// whole branch. Decision is final — the updateMany is scoped to PENDING rows,
// so a second decision 404s (count 0) instead of overriding the first.
const APPROVER_ROLES = ['SUPER_ADMIN', 'BRANCH_ADMIN', 'PRINCIPAL', 'HOD', 'ACADEMIC_HEAD'];

// The decision POST appends the approver's note to `reason` with this exact
// marker (there is no dedicated column). Splitting it back out here keeps the
// teacher's original words and the approver's note separate on every read.
const APPROVER_NOTE_MARK = '\n— Approver note: ';
function splitDecisionNote(reason: string): { reason: string; decisionNote: string | null } {
  const idx = reason.indexOf(APPROVER_NOTE_MARK);
  if (idx === -1) return { reason, decisionNote: null };
  return { reason: reason.slice(0, idx), decisionNote: reason.slice(idx + APPROVER_NOTE_MARK.length) || null };
}

// GET /leave-approvals?status=PENDING|APPROVED|REJECTED
// Returns PENDING first when no status filter is passed — the inbox is what
// an approver opens this screen for.
teacherRoutes.get('/leave-approvals', async (req: Request, res: Response) => {
  try {
    const prisma = req.app.get('prisma');
    const { userId, roles, branchId } = ctx(req);
    if (!userId || !branchId) { return res.status(403).json({ detail: 'Account has no branch — cannot list leave approvals.' }); }
    if (!roles.some((r) => APPROVER_ROLES.includes(r))) {
      return res.status(403).json({ type: 'forbidden', title: 'Forbidden', status: 403, detail: 'Only HODs, principals, and admins can review leave requests.' });
    }

    const staff = await prisma.staff.findUnique({ where: { userId }, select: { department: true } });
    const isHodOnly = roles.includes('HOD') && !roles.some((r) => ['SUPER_ADMIN', 'BRANCH_ADMIN', 'PRINCIPAL', 'ACADEMIC_HEAD'].includes(r));

    // Soft guard for a HOD without a staff row (or blank department): they
    // would see nothing — tell the client why instead of an empty inbox.
    if (isHodOnly && (!staff || !staff.department)) {
      return res.status(409).json({ type: 'config-error', title: 'No Department', status: 409, detail: 'Your account is a HOD but has no department on its staff record. Ask an admin to set it.' });
    }

    const statusFilter = typeof req.query.status === 'string' && ['PENDING', 'APPROVED', 'REJECTED'].includes(req.query.status)
      ? req.query.status
      : undefined;

    const rows = await prisma.leaveRequest.findMany({
      where: {
        staff: { branchId, ...(isHodOnly ? { department: staff!.department } : {}) },
        ...(statusFilter ? { status: statusFilter as never } : {}),
      },
      orderBy: [{ status: 'desc' }, { createdAt: 'desc' }],
      take: 200,
      include: {
        staff: { select: { firstName: true, lastName: true, employeeId: true, department: true, designation: true } },
      },
    });

    res.json({
      data: rows.map((r: (typeof rows)[number]) => {
        const { reason, decisionNote } = splitDecisionNote(r.reason);
        return {
          id: r.id,
          teacherName: `${r.staff.firstName} ${r.staff.lastName}`,
          employeeId: r.staff.employeeId,
          department: r.staff.department,
          designation: r.staff.designation,
          leaveType: r.leaveType,
          startDate: r.startDate,
          endDate: r.endDate,
          reason,
          decisionNote,
          status: r.status,
          approvedBy: r.status === 'PENDING' ? null : r.approvedBy,
          decidedAt: r.status === 'PENDING' ? null : r.updatedAt,
          createdAt: r.createdAt,
        };
      }),
      scope: isHodOnly ? 'department' : 'branch',
    });
  } catch (err: any) { res.status(500).json({ detail: err.message }); }
});

// POST /leave-requests/:id/decision  { decision: 'APPROVED' | 'REJECTED', note? }
// Same role gate as the list. Note is accepted for the audit string but there
// is no dedicated column — it is appended to the stored reason.
teacherRoutes.post('/leave-requests/:id/decision', async (req: Request, res: Response) => {
  try {
    const prisma = req.app.get('prisma');
    const { userId, roles, branchId } = ctx(req);
    if (!userId || !branchId) { return res.status(403).json({ detail: 'Account has no branch — cannot decide leave requests.' }); }
    if (!roles.some((r) => APPROVER_ROLES.includes(r))) {
      return res.status(403).json({ type: 'forbidden', title: 'Forbidden', status: 403, detail: 'Only HODs, principals, and admins can decide leave requests.' });
    }
    const decision = req.body?.decision;
    if (decision !== 'APPROVED' && decision !== 'REJECTED') {
      return res.status(400).json({ type: 'validation-error', title: 'Invalid Input', status: 400, detail: "decision must be 'APPROVED' or 'REJECTED'." });
    }

    const approver = await prisma.staff.findUnique({ where: { userId }, select: { firstName: true, lastName: true, department: true } });
    const isHodOnly = roles.includes('HOD') && !roles.some((r) => ['SUPER_ADMIN', 'BRANCH_ADMIN', 'PRINCIPAL', 'ACADEMIC_HEAD'].includes(r));

    const row = await prisma.leaveRequest.findFirst({
      where: { id: req.params.id, staff: { branchId } },
      include: { staff: { select: { department: true } } },
    });
    if (!row) { return res.status(404).json({ type: 'not-found', title: 'Not Found', status: 404, detail: 'Leave request not found in your branch.' }); }
    if (isHodOnly && row.staff.department !== approver?.department) {
      return res.status(403).json({ type: 'forbidden', title: 'Forbidden', status: 403, detail: 'This request belongs to another department.' });
    }

    // updateMany scoped to PENDING: a re-decision updates 0 rows — surfaced
    // as 409, so the first decision always stands.
    const approverName = `${approver?.firstName ?? 'Approver'} ${approver?.lastName ?? ''}`.trim();
    const note = req.body?.note ? String(req.body.note).slice(0, 300) : null;
    const claimed = await prisma.leaveRequest.updateMany({
      where: { id: row.id, status: 'PENDING' },
      data: {
        status: decision,
        approvedBy: approverName,
        ...(note ? { reason: `${row.reason}${APPROVER_NOTE_MARK}${note}` } : {}),
      },
    });
    if (claimed.count === 0) {
      return res.status(409).json({ type: 'conflict', title: 'Already Decided', status: 409, detail: 'This request has already been approved or rejected.' });
    }

    // Notify the requesting teacher: FCM push (works with the app closed) +
    // live WebSocket (instant when the app is open). Fire-and-forget behind
    // the response — the decision is already committed; delivery problems
    // are logged, never surfaced as an error to the approver.
    const staffRow = await prisma.staff.findUnique({ where: { id: row.staffId }, select: { userId: true } });
    if (staffRow && identityOf(req)) {
      const approverIdentity = identityOf(req)!;
      void notifyStaffUser(
        approverIdentity,
        {
          targetUserId: staffRow.userId,
          title: `Leave ${decision === 'APPROVED' ? 'approved' : 'rejected'}`,
          body: `${decision === 'APPROVED' ? 'Approved' : 'Rejected'} by ${approverName}${note ? ` — ${note}` : ''}`.slice(0, 200),
          deepLink: 'erp://leaves',
        },
        {
          internalAssertionPrivateKey: internalAssertionPrivateKey,
          communicationBaseUrl: communicationBaseUrl,
          notificationEngineUrl: notificationEngineUrl,
        },
      );
    }

    res.json({ id: row.id, status: decision, approvedBy: approverName, decisionNote: note, decidedAt: new Date().toISOString() });
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
// Identity-first: User row always exists, Staff row may not (the setup
// wizard's owner is SUPER_ADMIN + PRINCIPAL with no staff record unless the
// bootstrap created one). A missing Staff row is NOT a 404 — the profile
// page renders from the user identity, staff extras degrade to placeholders.
teacherRoutes.get('/profile', async (req: Request, res: Response) => {
  try {
    const prisma: PrismaClient = req.app.get('prisma');
    const { userId } = ctx(req);
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, isActive: true, defaultBranchId: true, lastLogin: true },
    });
    if (!user) return res.status(404).json({ detail: 'Profile not found' });
    const staff = await prisma.staff.findUnique({ where: { userId } });
    if (!staff) {
      return res.json({
        userOnly: true,
        firstName: user.email.split('@')[0],
        lastName: '',
        email: user.email,
        phone: '',
        isActive: user.isActive,
        lastLogin: user.lastLogin,
        designation: null,
        department: null,
      });
    }
    res.json({ ...staff, email: user.email, lastLogin: user.lastLogin });
  } catch (err: any) { res.status(500).json({ detail: err.message }); }
});

// PUT /profile
// With no Staff row there is nothing staff-scoped to edit — say so plainly
// (400 with guidance) instead of Prisma's opaque P2025 → 500.
teacherRoutes.put('/profile', async (req: Request, res: Response) => {
  try {
    const prisma = req.app.get('prisma');
    const { userId } = ctx(req);
    const { firstName, lastName, phone } = req.body;
    const staff = await prisma.staff.findUnique({ where: { userId }, select: { id: true } });
    if (!staff) {
      return res.status(400).json({
        detail: 'This account has no staff record to edit. Ask an admin to create one from Staff & HR.',
      });
    }
    const updated = await prisma.staff.update({
      where: { userId },
      data: { firstName, lastName, phone }
    });
    res.json(updated);
  } catch (err: any) { res.status(500).json({ detail: err.message }); }
});

// GET /timetable
// Real week grid from timetable_slots where this staff member takes the
// slot (2.7.6): day → ordered periods with subject, class-section and room.
teacherRoutes.get('/timetable', async (req: Request, res: Response) => {
  try {
    const prisma = req.app.get('prisma');
    const { userId } = ctx(req);
    const staff = await prisma.staff.findUnique({ where: { userId }, select: { id: true, branchId: true } });
    if (!staff) return res.json({ days: [] });

    const slots = await prisma.timetableSlot.findMany({
      where: { staffId: staff.id, section: { class: { branchId: staff.branchId } } },
      include: {
        subject: { select: { name: true } },
        section: { select: { name: true, class: { select: { name: true } } } },
      },
      orderBy: { startTime: 'asc' },
    });

    const DAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];
    const days = DAYS
      .map((day) => ({
        day,
        slots: slots
          .filter((s: (typeof slots)[number]) => s.day.toUpperCase() === day)
          .map((s: (typeof slots)[number]) => ({
            id: s.id,
            startTime: s.startTime,
            endTime: s.endTime,
            subject: s.subject.name,
            classSection: `${s.section.class.name}-${s.section.name}`,
            room: s.room,
          })),
      }))
      .filter((d) => d.slots.length > 0);

    res.json({ days });
  } catch (err: any) { res.status(500).json({ detail: err.message }); }
});

// GET /dashboard
// Real numbers: assigned class-sections from subjectTeacher rows, student
// counts from LIVE enrollments (not section capacity), today's attendance
// from attendance records, today's teaching schedule from timetable_slots.
teacherRoutes.get('/dashboard', async (req: Request, res: Response) => {
  try {
    const prisma = req.app.get('prisma');
    const { userId } = ctx(req);
    const staff = await prisma.staff.findUnique({
      where: { userId },
      include: { subjectTeachers: { include: { subject: { include: { class: { include: { sections: true } } } } } } },
    });

    if (!staff) return res.json({ totalClasses: 0, totalStudents: 0, attendanceToday: '0/0', attendanceRate: null, examsPending: 0, schedule: [], tasks: [], classOverview: [] });

    // Distinct sections this teacher teaches.
    const sectionMap = new Map<string, { classId: string; sectionId: string; cls: string; sec: string; subject: string }>();
    for (const st of staff.subjectTeachers) {
      for (const sec of st.subject.class.sections) {
        const key = sec.id;
        if (!sectionMap.has(key)) {
          sectionMap.set(key, { classId: st.subject.classId, sectionId: sec.id, cls: st.subject.class.name, sec: sec.name, subject: st.subject.name });
        }
      }
    }
    const sections: Array<{ classId: string; sectionId: string; cls: string; sec: string; subject: string }> = [...sectionMap.values()];

    // Live enrolled counts per section.
    const classIds = [...new Set(sections.map((s) => s.classId))];
    const sectionIds = sections.map((s) => s.sectionId);
    const enrollments = classIds.length
      ? await prisma.studentEnrollment.findMany({
          where: { status: 'ENROLLED', classId: { in: classIds }, sectionId: { in: sectionIds }, student: { deletedAt: null } },
          select: { classId: true, sectionId: true },
        })
      : [];
    const countBy = (cid: string, sid: string) => enrollments.filter((e: { classId: string; sectionId: string }) => e.classId === cid && e.sectionId === sid).length;
    const totalStudents = enrollments.length;

    // Today's attendance across this teacher's sections (their sections only).
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today.getTime() + 86_400_000);
    const sessions = sectionIds.length
      ? await prisma.attendanceSession.findMany({
          where: { date: { gte: today, lt: tomorrow }, classId: { in: classIds }, sectionId: { in: sectionIds } },
          include: { records: { select: { status: true } } },
        })
      : [];
    const records = sessions.flatMap((s: { records: Array<{ status: string }> }) => s.records);
    const present = records.filter((r: { status: string }) => r.status === 'PRESENT').length;
    const marked = records.length;

    // Today's teaching schedule from the real timetable (branch day name).
    const dayNames = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
    const todayName = dayNames[today.getDay()];
    const slots = await prisma.timetableSlot.findMany({
      where: { staffId: staff.id, day: todayName, section: { class: { branchId: staff.branchId } } },
      include: { subject: { select: { name: true } }, section: { select: { name: true, class: { select: { name: true } } } } },
      orderBy: { startTime: 'asc' },
    });
    const schedule = slots.map((s: (typeof slots)[number]) => ({
      time: `${s.startTime}-${s.endTime}`,
      cls: `${s.section.class.name}-${s.section.name}`,
      sub: s.subject.name,
      room: s.room ?? '—',
    }));

    const classOverview = sections.slice(0, 4).map((s: { cls: string; sec: string; classId: string; sectionId: string }) => ({
      cls: `${s.cls}-${s.sec}`,
      students: countBy(s.classId, s.sectionId),
    }));

    res.json({
      totalClasses: sections.length,
      totalStudents,
      attendanceToday: marked > 0 ? `${present}/${marked}` : null,
      attendanceRate: marked > 0 ? Math.round((present / marked) * 100) : null,
      examsPending: 0,
      schedule,
      tasks: [],
      classOverview,
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
