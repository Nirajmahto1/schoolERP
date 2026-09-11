// ──────────────────────────────────────────────
// Demo tenant seed (GATE 2: "seed produces a realistic 3-branch, 1,200-
// student, 2-academic-year school")
//
// Deterministic (same input → same data), bulk-created via createMany with
// stable ids, and safe to re-run (skipDuplicates). It exercises every Phase 2
// shape: enrollments for two years, session-based attendance with monthly
// summaries, published exams with grades for both years, a fee ledger that
// ties out by construction, sequences, terms, holidays and staff.
//
// Imported by both packages/database/prisma/seed.ts (via relative path, so
// `pnpm db:seed` needs no build) and the GATE-2 test suite.
// ──────────────────────────────────────────────

import type { PrismaClient } from '@prisma/client';
import type {
  GuardianRelation,
  EnrollmentStatus,
  AttendanceStatus,
  ExamStatus,
  InvoiceStatus,
  PaymentMethod,
  PaymentStatus,
  FeeLedgerType,
  FeeFrequency,
  FeeHeadType,
} from '@prisma/client';

export interface DemoSeedOptions {
  code?: string;
  schoolName?: string;
  branches?: number;
  studentsPerBranch?: number;
  /** Weekdays of attendance generated per academic year. */
  attendanceDaysPerYear?: number;
  /** Deterministic pseudo-random seed offset. */
  offset?: number;
}

export interface DemoSeedResult {
  schoolId: string;
  branchIds: string[];
  academicYearIds: { past: string; current: string };
  classLadder: string[];
  stats: {
    students: number;
    enrollments: number;
    users: number;
    attendanceSessions: number;
    attendanceRecords: number;
    attendanceSummaries: number;
    invoices: number;
    invoiceLines: number;
    payments: number;
    ledgerEntries: number;
    examResults: number;
  };
}

export const CLASS_LADDER = [
  'NURSERY', 'LKG', 'UKG', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE',
  'SIX', 'SEVEN', 'EIGHT', 'NINE', 'TEN', 'ELEVEN', 'TWELVE',
] as const;

const SECTIONS = ['A', 'B'];

const FIRST_NAMES = [
  'Aarav', 'Diya', 'Arjun', 'Ananya', 'Vihaan', 'Ishita', 'Rohan', 'Saanvi',
  'Kabir', 'Myra', 'Aditya', 'Aadhya', 'Reyansh', 'Anika', 'Shaurya', 'Navya',
  'Dhruv', 'Kiara', 'Krishna', 'Pari', 'Ishaan', 'Anvi', 'Yash', 'Aarya',
  'Atharv', 'Mahika', 'Vivaan', 'Sara', 'Ayaan', 'Riya',
];

const LAST_NAMES = [
  'Sharma', 'Verma', 'Gupta', 'Patel', 'Singh', 'Kumar', 'Reddy', 'Joshi',
  'Mishra', 'Chauhan', 'Agarwal', 'Mehta', 'Nair', 'Iyer', 'Das', 'Bose',
  'Khan', 'Rao', 'Bhat', 'Kulkarni',
];

const SUBJECTS = [
  { name: 'Mathematics', code: 'MATH' },
  { name: 'Science', code: 'SCI' },
  { name: 'English', code: 'ENG' },
  { name: 'Hindi', code: 'HIN' },
  { name: 'Social Science', code: 'SST' },
];

const MODULES = ['students', 'staff', 'academics', 'attendance', 'fees', 'communication', 'library', 'transport', 'reports', 'exams'];
const ACTIONS = ['create', 'read', 'update', 'delete'];

const GRADE_BANDS: Array<{ grade: string; min: number; max: number; points: number }> = [
  { grade: 'A1', min: 91, max: 100, points: 10 },
  { grade: 'A2', min: 81, max: 90, points: 9 },
  { grade: 'B1', min: 71, max: 80, points: 8 },
  { grade: 'B2', min: 61, max: 70, points: 7 },
  { grade: 'C1', min: 51, max: 60, points: 6 },
  { grade: 'C2', min: 41, max: 50, points: 5 },
  { grade: 'D', min: 33, max: 40, points: 4 },
  { grade: 'E', min: 0, max: 32, points: 0 },
];

export function gradeFor(marks: number): string {
  return GRADE_BANDS.find((b) => marks >= b.min && marks <= b.max)?.grade ?? 'E';
}

/** Monthly tuition by class tier — mirrors a real Indian fee book. */
function tuitionFor(classIdx: number): number {
  if (classIdx <= 2) return 1500;
  if (classIdx <= 6) return 2000;
  if (classIdx <= 9) return 2500;
  if (classIdx <= 11) return 3000;
  return 3500;
}

function annualFor(classIdx: number): number {
  return classIdx <= 6 ? 5000 : 8000;
}

function monthDay(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day));
}

function isWeekend(d: Date): boolean {
  const day = d.getDay();
  return day === 0 || day === 6;
}

/** The first N weekdays of the academic year starting April 1. */
export function schoolDays(yearStart: number, count: number): Date[] {
  const days: Date[] = [];
  const d = monthDay(yearStart, 4, 1);
  while (days.length < count) {
    if (!isWeekend(d)) days.push(new Date(d));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return days;
}

// Deterministic pseudo-random (no Math.random — seeds must be reproducible).
function prand(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export async function seedDemoTenant(
  prisma: PrismaClient,
  options: DemoSeedOptions = {},
): Promise<DemoSeedResult> {
  const code = (options.code ?? 'DEMO').toUpperCase();
  const schoolName = options.schoolName ?? 'Delhi Public School';
  const branchCount = options.branches ?? 3;
  const perBranch = options.studentsPerBranch ?? 400;
  const attDays = options.attendanceDaysPerYear ?? 30;
  const offset = options.offset ?? 0;
  const rand = prand(20260830 + offset);

  // ── 1. School + branches ──
  const school = await prisma.school.upsert({
    where: { code },
    update: {},
    create: {
      name: schoolName,
      code,
      address: '123, Education Lane, Sector 12',
      city: 'New Delhi',
      state: 'Delhi',
      pincode: '110001',
      phone: '+91 11 2345 6789',
      email: `info@${code.toLowerCase()}.demo.edu.in`,
    },
  });

  const branchNames = ['Main Campus', 'North Campus', 'South Campus'];
  const branchCodes = ['MAIN', 'NORTH', 'SOUTH'];
  const branches: Array<{ id: string }> = [];
  // School code is globally unique (School.code @unique) — every deterministic
  // id/email embeds it so multiple schools can seed into one database without
  // colliding (skipDuplicates would otherwise silently skip the duplicates).
  const sc = code.toLowerCase();
  for (let b = 0; b < branchCount; b++) {
    const branch = await prisma.branch.upsert({
      where: { schoolId_code: { schoolId: school.id, code: branchCodes[b] } },
      update: {},
      create: {
        schoolId: school.id,
        name: branchNames[b],
        code: branchCodes[b],
        address: '123, Education Lane, Sector 12',
        phone: '+91 11 2345 6789',
        email: `${branchCodes[b].toLowerCase()}@${code.toLowerCase()}.demo.edu.in`,
      },
    });
    branches.push(branch);
  }

  // ── 2. Academic years: 2024-25 (past) + 2025-26 (current) ──
  const years = ['2024-25', '2025-26'];
  const yearRows: Record<string, Record<string, string>> = {}; // branchId -> name -> id
  for (const branch of branches) {
    for (const name of years) {
      const startYear = Number(name.split('-')[0]);
      const row = await prisma.academicYear.upsert({
        where: { branchId_name: { branchId: branch.id, name } },
        update: {},
        create: {
          name,
          startDate: monthDay(startYear, 4, 1),
          endDate: monthDay(startYear + 1, 3, 31),
          isCurrent: name === '2025-26',
          branchId: branch.id,
        },
      });
      (yearRows[branch.id] ??= {})[name] = row.id;
    }
  }
  const currentYear = '2025-26';
  const pastYear = '2024-25';

  // ── 3. Classes + sections per branch per year ──
  const classIds: Record<string, Record<string, string[]>> = {}; // branchId -> yearName -> [classId]
  const sectionIds: Record<string, string[]> = {}; // classId -> [sectionId]
  for (const branch of branches) {
    classIds[branch.id] = {};
    for (const name of years) {
      const ids: string[] = [];
      for (let ci = 0; ci < CLASS_LADDER.length; ci++) {
        const cls = await prisma.class.upsert({
          where: {
            branchId_name_academicYearId: {
              branchId: branch.id,
              name: CLASS_LADDER[ci],
              academicYearId: yearRows[branch.id][name],
            },
          },
          update: {},
          create: {
            name: CLASS_LADDER[ci],
            numericOrder: ci,
            branchId: branch.id,
            academicYearId: yearRows[branch.id][name],
          },
        });
        ids.push(cls.id);
        for (const sectionName of SECTIONS) {
          const sec = await prisma.section.upsert({
            where: { classId_name: { classId: cls.id, name: sectionName } },
            update: {},
            create: { name: sectionName, classId: cls.id, capacity: 45 },
          });
          (sectionIds[cls.id] ??= []).push(sec.id);
        }
      }
      classIds[branch.id][name] = ids;
    }
  }

  // ── 4. Subjects + subject teachers + permissions/roles ──
  const permissionRows = await prisma.permission.findMany();
  const permissionIds = new Map(permissionRows.map((p) => [`${p.module}.${p.action}`, p.id]));
  const missing = [];
  for (const module of MODULES) {
    for (const action of ACTIONS) {
      if (!permissionIds.has(`${module}.${action}`)) missing.push({ module, action });
    }
  }
  if (missing.length) {
    await prisma.permission.createMany({ data: missing, skipDuplicates: true });
    const fresh = await prisma.permission.findMany({ where: { module: { in: MODULES }, action: { in: ACTIONS } } });
    for (const p of fresh) permissionIds.set(`${p.module}.${p.action}`, p.id);
  }

  const roles = await prisma.role.findMany();
  const roleId = (codeName: string) => roles.find((r) => r.code === codeName)?.id;

  // ── 5. Users: admins, teachers, students, parents ──
  const passwordHash =
    '$2a$10$1rLK7i2.BisiOJXZwLnuS.QZyUlVukwYafNSgeHTFgZAueszMxWOm'; // "Admin@123" (cost 10) — VERIFIED against bcryptjs
  const users: Array<{ id: string; email: string; passwordHash: string; isActive: boolean; defaultBranchId: string | null }> = [];
  const userBranches: Array<{ userId: string; branchId: string }> = [];
  const staffRows: Array<{
    id: string; userId: string; employeeId: string; firstName: string; lastName: string;
    dateOfBirth: Date; gender: 'MALE' | 'FEMALE'; designation: string; department: string;
    qualification: string; experience: number; joinDate: Date; salary: number;
    address: string; phone: string; branchId: string;
  }> = [];
  const teacherUsers: Array<{ id: string; branchId: string }> = [];

  const TEACHERS_PER_BRANCH = 10;
  for (let b = 0; b < branches.length; b++) {
    const branch = branches[b];
    const bcode = branchCodes[b].toLowerCase();

    // Branch admin + principal.
    const adminId = `usr_${sc}_${bcode}_admin`;
    const principalId = `usr_${sc}_${bcode}_principal`;
    users.push(
      { id: adminId, email: `admin@${sc}-${bcode}.demo.edu.in`, passwordHash, isActive: true, defaultBranchId: branch.id },
      { id: principalId, email: `principal@${sc}-${bcode}.demo.edu.in`, passwordHash, isActive: true, defaultBranchId: branch.id },
    );
    userBranches.push({ userId: adminId, branchId: branch.id }, { userId: principalId, branchId: branch.id });

    // Teachers (also staff rows).
    for (let t = 0; t < TEACHERS_PER_BRANCH; t++) {
      const uid = `usr_${sc}_${bcode}_teach${t}`;
      users.push({ id: uid, email: `teacher${t}@${sc}-${bcode}.demo.edu.in`, passwordHash, isActive: true, defaultBranchId: branch.id });
      userBranches.push({ userId: uid, branchId: branch.id });
      teacherUsers.push({ id: uid, branchId: branch.id });
      staffRows.push({
        id: `stf_${sc}_${bcode}_${t}`,
        userId: uid,
        employeeId: `EMP-${sc.toUpperCase()}-${bcode.toUpperCase()}-${String(t + 1).padStart(3, '0')}`,
        firstName: FIRST_NAMES[(b * 7 + t) % FIRST_NAMES.length],
        lastName: LAST_NAMES[(b * 3 + t) % LAST_NAMES.length],
        dateOfBirth: monthDay(1985 + (t % 10), 1 + (t % 12), 1 + t),
        gender: t % 2 === 0 ? 'FEMALE' : 'MALE',
        designation: 'Teacher',
        department: SUBJECTS[t % SUBJECTS.length].name,
        qualification: 'M.Ed',
        experience: 5 + t,
        joinDate: monthDay(2018 + (t % 5), 4, 1),
        salary: 35000 + t * 3000,
        address: 'Teacher Colony',
        phone: `+91 98765 ${String(10000 + t).padStart(5, '0')}`,
        branchId: branch.id,
      });
    }
  }

  // Student + parent users and rows.
  const studentRows: Array<{
    id: string; userId: string; admissionNo: string; firstName: string; lastName: string;
    dateOfBirth: Date; gender: 'MALE' | 'FEMALE'; bloodGroup: string; address: string;
    phone: string; admissionDate: Date; branchId: string;
  }> = [];
  const guardianRows: Array<{ id: string; userId: string; fullName: string; phone: string; email: string; occupation: string }> = [];
  const studentGuardianRows: Array<{ id: string; studentId: string; guardianId: string; relation: GuardianRelation; isPrimary: boolean; canPickup: boolean; receivesComms: boolean; hasPortalAccess: boolean }> = [];
  const enrollments: Array<{
    id: string; studentId: string; academicYearId: string; branchId: string;
    classId: string; sectionId: string; rollNo: string; status: EnrollmentStatus; fromDate: Date; createdBy: string;
  }> = [];

  let studentCounter = 0;
  for (let b = 0; b < branches.length; b++) {
    const branch = branches[b];
    const bcode = branchCodes[b].toLowerCase();
    const currentClasses = classIds[branch.id][currentYear];
    const pastClasses = classIds[branch.id][pastYear];

    // Distribute students across the 15 classes (lower classes bigger).
    const weights = [1.1, 1.1, 1.1, 1.0, 1.0, 1.0, 0.9, 0.9, 0.9, 0.9, 0.8, 0.8, 0.7, 0.6, 0.6];
    const totalWeight = weights.reduce((a, w) => a + w, 0);
    const perClass = weights.map((w) => Math.round((w / totalWeight) * perBranch));

    for (let ci = 0; ci < CLASS_LADDER.length; ci++) {
      const classSize = perClass[ci];
      const prevClassId = pastClasses[Math.max(ci - 1, 0)];
      const prevSections = prevClassId ? sectionIds[prevClassId] ?? [] : [];
      const curSections = sectionIds[currentClasses[ci]] ?? [];

      for (let si = 0; si < curSections.length; si++) {
        const curSecId = curSections[si];
        const prevSecId = prevSections[si] ?? prevSections[0];
        const sectionSize = Math.ceil(classSize / curSections.length);

        for (let k = 0; k < sectionSize && studentCounter < (b + 1) * perBranch; k++) {
          const i = studentCounter++;
          const sId = `stu_${sc}_${bcode}_${String(i).padStart(5, '0')}`;
          const first = FIRST_NAMES[(i + offset) % FIRST_NAMES.length];
          const last = LAST_NAMES[Math.floor((i + offset) / FIRST_NAMES.length) % LAST_NAMES.length];
          const gender = i % 2 === 0 ? 'MALE' : 'FEMALE';

          const uid = `usr_${sc}_${bcode}_stu${i}`;
          users.push({ id: uid, email: `${first.toLowerCase()}.${last.toLowerCase()}${i}@student.${sc}-${bcode}.demo.edu.in`, passwordHash, isActive: true, defaultBranchId: branch.id });
          userBranches.push({ userId: uid, branchId: branch.id });

          studentRows.push({
            id: sId,
            userId: uid,
            admissionNo: `ADM-${sc.toUpperCase()}-${bcode.toUpperCase()}-${String(i + 1).padStart(5, '0')}`,
            firstName: first,
            lastName: last,
            dateOfBirth: monthDay(2013 - ci, 1 + (i % 12), 1 + (i % 27)),
            gender,
            bloodGroup: ['A+', 'B+', 'O+', 'AB+', 'A-'][i % 5],
            address: `${200 + i}, Model Town`,
            phone: `+91 70000 ${String(10000 + i).padStart(5, '0')}`,
            admissionDate: monthDay(2023 + (ci % 2), 4, 1),
            branchId: branch.id,
          });

          // Guardian (one per student) + link.
          const gId = `grd_${sc}_${bcode}_${i}`;
          const pUserId = `usr_${sc}_${bcode}_par${i}`;
          users.push({ id: pUserId, email: `parent${i}@${sc}-${bcode}.demo.edu.in`, passwordHash, isActive: true, defaultBranchId: branch.id });
          userBranches.push({ userId: pUserId, branchId: branch.id });
          guardianRows.push({
            id: gId,
            userId: pUserId,
            fullName: `${FIRST_NAMES[(i + offset + 13) % FIRST_NAMES.length]} ${last}`,
            phone: `+91 98765 ${String(20000 + i).padStart(5, '0')}`,
            email: `parent${i}@${sc}-${bcode}.demo.edu.in`,
            occupation: ['Business', 'Engineer', 'Doctor', 'Teacher', 'Government Service'][i % 5],
          });
          studentGuardianRows.push({
            id: `sg_${sc}_${bcode}_${i}`,
            studentId: sId,
            guardianId: gId,
            relation: i % 3 === 0 ? 'MOTHER' : 'FATHER',
            isPrimary: true,
            canPickup: true,
            receivesComms: true,
            hasPortalAccess: true,
          });

          // Enrollments: past year in the previous class, current year here.
          const pastRoll = `${ci}-${si + 1}-${k + 1}`;
          const curRoll = `${ci + 1}-${si + 1}-${k + 1}`;
          enrollments.push(
            {
              id: `enr_${sId}_${pastYear}`,
              studentId: sId,
              academicYearId: yearRows[branch.id][pastYear],
              branchId: branch.id,
              classId: prevClassId,
              sectionId: prevSecId,
              rollNo: pastRoll,
              status: 'ENROLLED',
              fromDate: monthDay(2024, 4, 1),
              createdBy: 'seed',
            },
            {
              id: `enr_${sId}_${currentYear}`,
              studentId: sId,
              academicYearId: yearRows[branch.id][currentYear],
              branchId: branch.id,
              classId: currentClasses[ci],
              sectionId: curSecId,
              rollNo: curRoll,
              status: 'ENROLLED',
              fromDate: monthDay(2025, 4, 1),
              createdBy: 'seed',
            },
          );
        }
      }
    }
  }

  const chunk = <T,>(arr: T[], size: number): T[][] => {
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  };

  await prisma.user.createMany({ data: users, skipDuplicates: true });
  const branchByUser = new Map(userBranches.map((ub) => [ub.userId, ub.branchId]));
  await prisma.userRoleAssignment.createMany({
    data: users.map((u) => {
      const isStudent = u.id.includes('_stu');
      const isParent = u.id.includes('_par');
      const isTeacher = u.id.includes('_teach');
      const isAdmin = u.id.includes('_admin');
      const isPrincipal = u.id.includes('_principal');
      const roleCode = isStudent ? 'STUDENT' : isParent ? 'PARENT' : isTeacher ? 'TEACHER' : isAdmin ? 'BRANCH_ADMIN' : isPrincipal ? 'PRINCIPAL' : 'TEACHER';
      return {
        id: `ura_${u.id}`,
        userId: u.id,
        roleId: roleId(roleCode)!,
        branchId: branchByUser.get(u.id) ?? null,
        isActive: true,
      };
    }),
    skipDuplicates: true,
  });
  await prisma.staff.createMany({ data: staffRows, skipDuplicates: true });
  await prisma.student.createMany({ data: studentRows, skipDuplicates: true });
  await prisma.guardian.createMany({ data: guardianRows, skipDuplicates: true });
  await prisma.studentGuardian.createMany({ data: studentGuardianRows, skipDuplicates: true });
  await prisma.studentEnrollment.createMany({ data: enrollments, skipDuplicates: true });

  // Role permissions for system roles.
  const rolePermissionData: Array<{ id: string; roleId: string; permissionId: string }> = [];
  for (const r of roles) {
    const modulesFor =
      r.code === 'SUPER_ADMIN' || r.code === 'BRANCH_ADMIN'
        ? MODULES
        : r.code === 'PRINCIPAL'
          ? ['students', 'staff', 'academics', 'attendance', 'exams', 'fees', 'communication']
          : r.code === 'ACCOUNTANT' || r.code === 'FINANCE'
            ? ['fees', 'reports']
            : r.code === 'TEACHER'
              ? ['attendance', 'exams', 'academics', 'communication']
              : r.code === 'PARENT' || r.code === 'STUDENT'
                ? ['students', 'attendance', 'exams', 'fees', 'communication']
                : ['library', 'transport'];
    for (const module of modulesFor) {
      for (const action of ACTIONS) {
        const pid = permissionIds.get(`${module}.${action}`);
        if (pid) {
          rolePermissionData.push({ id: `rp_${r.id}_${module}_${action}`, roleId: r.id, permissionId: pid });
        }
      }
    }
  }
  await prisma.rolePermission.createMany({ data: rolePermissionData, skipDuplicates: true });

  // ── 6. Attendance: sessions + records + monthly summaries (both years) ──
  const sessionRows: Array<{
    id: string; branchId: string; date: Date; classId: string; sectionId: string;
    academicYearId: string; markedBy: string;
  }> = [];
  const recordRows: Array<{ id: string; sessionId: string; studentId: string; status: AttendanceStatus; reason: string | null }> = [];
  const summaryRows: Array<{
    id: string; studentId: string; branchId: string; academicYearId: string; year: number; month: number;
    workingDays: number; presentDays: number; absentDays: number; lateDays: number; halfDays: number;
    leaveDays: number; medicalDays: number; excusedDays: number; percentage: number;
  }> = [];
  // in-memory per (branch, year, student) month counters
  const monthCounts = new Map<string, { workingDays: number; present: number; absent: number; late: number; half: number; leave: number; medical: number; excused: number; months: Set<number> }>();

  const dayKey = (d: Date) => d.toISOString().slice(0, 10);

  for (let b = 0; b < branches.length; b++) {
    const branch = branches[b];
    for (const [yearName, yearId] of Object.entries(yearRows[branch.id])) {
      const startYear = Number(yearName.split('-')[0]);
      const days = schoolDays(startYear, attDays);
      const yearClasses = classIds[branch.id][yearName];

      // Map section -> students (from the in-memory enrollments).
      const sectionStudents = new Map<string, string[]>();
      for (const e of enrollments) {
        if (e.academicYearId === yearId && e.branchId === branch.id && e.status === 'ENROLLED') {
          const list = sectionStudents.get(e.sectionId) ?? [];
          list.push(e.studentId);
          sectionStudents.set(e.sectionId, list);
        }
      }

      const dayIdx = yearName === pastYear ? 0 : attDays; // distinct ids across years
      for (let di = 0; di < days.length; di++) {
        const date = days[di];
        for (const clsId of yearClasses) {
          const sections = sectionIds[clsId] ?? [];
          for (const secId of sections) {
            const students = sectionStudents.get(secId) ?? [];
            if (students.length === 0) continue;
            const sessionId = `ats_${branch.id}_${yearName}_${di}_${clsId}_${secId}`;
            sessionRows.push({
              id: sessionId,
              branchId: branch.id,
              date,
              classId: clsId,
              sectionId: secId,
              academicYearId: yearId,
              markedBy: `usr_${sc}_${branchCodes[b].toLowerCase()}_admin`,
            });
            const m = date.getUTCMonth() + 1;
            const y = date.getUTCFullYear();
            for (const studentId of students) {
              const r = rand();
              const status = r < 0.92 ? 'PRESENT' : r < 0.97 ? 'ABSENT' : 'LATE';
              recordRows.push({
                id: `atr_${sessionId}_${studentId}`,
                sessionId,
                studentId,
                status,
                reason: status === 'ABSENT' ? 'absent' : null,
              });
              const key = `${branch.id}|${yearId}|${studentId}`;
              const acc = monthCounts.get(key) ?? { workingDays: 0, present: 0, absent: 0, late: 0, half: 0, leave: 0, medical: 0, excused: 0, months: new Set<number>() };
              acc.workingDays++;
              acc.months.add(m);
              if (status === 'PRESENT') acc.present++;
              else if (status === 'ABSENT') acc.absent++;
              else acc.late++;
              monthCounts.set(key, acc);
            }
          }
        }
      }
    }
  }

  await prisma.attendanceSession.createMany({ data: sessionRows, skipDuplicates: true });
  await prisma.attendanceRecord.createMany({ data: recordRows, skipDuplicates: true });

  // Monthly summaries from the in-memory counters (same semantics as
  // rebuildMonthlySummary — attendance percentage is never computed from raw
  // rows at request time).
  for (const [key, acc] of monthCounts.entries()) {
    const [branchId, yearId, studentId] = key.split('|');
    for (const m of acc.months) {
      const attended = acc.present + acc.half + acc.late;
      const percentage = acc.workingDays > 0 ? Math.round((attended / acc.workingDays) * 10000) / 100 : 0;
      summaryRows.push({
        id: `sum_${branchId}_${studentId}_${m}`,
        studentId,
        branchId,
        academicYearId: yearId,
        year: yearId === yearRows[branchId][pastYear] ? 2024 : 2025,
        month: m,
        workingDays: acc.workingDays,
        presentDays: acc.present,
        absentDays: acc.absent,
        lateDays: acc.late,
        halfDays: acc.half,
        leaveDays: acc.leave,
        medicalDays: acc.medical,
        excusedDays: acc.excused,
        percentage,
      });
    }
  }
  await prisma.attendanceMonthlySummary.createMany({ data: summaryRows, skipDuplicates: true });

  // ── 7. Exams + results for both years ──
  const examRows: Array<{ id: string; name: string; academicYearId: string; branchId: string; assessmentTypeId: string | null; startDate: Date; endDate: Date; status: ExamStatus; publishedAt: Date | null; publishedBy: string | null }> = [];
  const examSubjectRows: Array<{ id: string; examinationId: string; subjectId: string; examDate: Date; startTime: string; endTime: string; maxMarks: number; passingMarks: number }> = [];
  const resultRows: Array<{ id: string; examSubjectId: string; studentId: string; marksObtained: number; grade: string; enteredBy: string }> = [];
  const subjectRows: Array<{ id: string; name: string; code: string; classId: string; type: string }> = [];
  const subjectTeacherRows: Array<{ id: string; subjectId: string; staffId: string }> = [];

  // Pre-index enrollments by year+class so result generation is O(n), not O(n²).
  const enrollmentsByYearClass = new Map<string, Array<(typeof enrollments)[number]>>();
  for (const e of enrollments) {
    const key = `${e.academicYearId}|${e.classId}`;
    const list = enrollmentsByYearClass.get(key) ?? [];
    list.push(e);
    enrollmentsByYearClass.set(key, list);
  }

  for (let b = 0; b < branches.length; b++) {
    const branch = branches[b];
    const bcode = branchCodes[b].toLowerCase();
    for (const [yearName, yearId] of Object.entries(yearRows[branch.id])) {
      const examName = yearName === pastYear ? 'Annual Examination' : 'Term I Examination';
      const examId = `exm_${branch.id}_${yearName}`;
      examRows.push({
        id: examId,
        name: examName,
        academicYearId: yearId,
        branchId: branch.id,
        assessmentTypeId: null,
        startDate: monthDay(Number(yearName.split('-')[0]), 2, 20),
        endDate: monthDay(Number(yearName.split('-')[0]), 3, 5),
        status: 'PUBLISHED',
        publishedAt: monthDay(Number(yearName.split('-')[0]), 3, 10),
        publishedBy: `usr_${sc}_${bcode}_principal`,
      });

      for (const clsId of classIds[branch.id][yearName]) {
        const classEnrollments = enrollmentsByYearClass.get(`${yearId}|${clsId}`) ?? [];
        for (let s = 0; s < SUBJECTS.length; s++) {
          const sub = SUBJECTS[s];
          const subjectId = `sub_${clsId}_${sub.code}`;
          subjectRows.push({ id: subjectId, name: sub.name, code: sub.code, classId: clsId, type: 'THEORY' });
          if (TEACHERS_PER_BRANCH > 0) {
            const teacherIdx = (b * 5 + s) % TEACHERS_PER_BRANCH;
            const staffId = `stf_${sc}_${bcode}_${teacherIdx}`;
            subjectTeacherRows.push({ id: `st_${subjectId}_${staffId}`, subjectId, staffId });
          }
          const esId = `es_${examId}_${subjectId}`;
          examSubjectRows.push({
            id: esId,
            examinationId: examId,
            subjectId,
            examDate: monthDay(Number(yearName.split('-')[0]), 2, 20 + s),
            startTime: '09:00',
            endTime: '12:00',
            maxMarks: 100,
            passingMarks: 33,
          });

          for (const e of classEnrollments) {
            const marks = Math.round(40 + rand() * 59);
            resultRows.push({
              id: `er_${esId}_${e.studentId}`,
              examSubjectId: esId,
              studentId: e.studentId,
              marksObtained: marks,
              grade: gradeFor(marks),
              enteredBy: `usr_${sc}_${bcode}_teach${s % TEACHERS_PER_BRANCH}`,
            });
          }
        }
      }
    }
  }

  await prisma.subject.createMany({ data: subjectRows, skipDuplicates: true });
  await prisma.subjectTeacher.createMany({ data: subjectTeacherRows, skipDuplicates: true });
  await prisma.examination.createMany({ data: examRows, skipDuplicates: true });
  await prisma.examSubject.createMany({ data: examSubjectRows, skipDuplicates: true });
  await prisma.examResult.createMany({ data: resultRows, skipDuplicates: true });

  // ── 8. Fees: heads (from migration) → structures → invoices → payments → ledger ──
  const invoiceRows: Array<{
    id: string; invoiceNo: string; studentId: string; branchId: string; academicYearId: string;
    periodStart: Date | null; periodEnd: Date | null; dueDate: Date; totalAmount: number; discountAmount: number;
    paidAmount: number; status: InvoiceStatus;
  }> = [];
  const lineRows: Array<{ id: string; invoiceId: string; feeHeadId: string; description: string; amount: number; discount: number }> = [];
  const paymentRows: Array<{
    id: string; studentId: string; branchId: string; academicYearId: string; invoiceId: string;
    amount: number; method: PaymentMethod; status: PaymentStatus; idempotencyKey: string; receiptNo: string; paidAt: Date;
  }> = [];
  const ledgerRows: Array<{
    id: string; studentId: string; branchId: string; academicYearId: string; type: FeeLedgerType;
    amount: number; feeHeadId: string | null; invoiceId: string | null; paymentId: string | null;
    description: string; reference: string | null;
  }> = [];

  // Standard fee heads per branch (fresh databases get none from the 0002
  // backfill — that only re-homes legacy rows). Same ids as the migration.
  const STANDARD_HEADS: Array<[string, string, FeeHeadType, boolean]> = [
    ['TUITION', 'Tuition Fee', 'TUITION', true],
    ['TRANSPORT', 'Transport Fee', 'TRANSPORT', true],
    ['ADMISSION', 'Admission Fee', 'ADMISSION', false],
    ['EXAM', 'Examination Fee', 'EXAM', false],
    ['LAB', 'Laboratory Fee', 'LAB', false],
    ['ANNUAL', 'Annual Fee', 'ANNUAL', false],
    ['DEVELOPMENT', 'Development Fee', 'DEVELOPMENT', false],
    ['LATE_FEE', 'Late Fee', 'LATE_FEE', false],
    ['MISC', 'Miscellaneous', 'MISCELLANEOUS', false],
  ];

  for (let b = 0; b < branches.length; b++) {
    const branch = branches[b];
    const currentYearId = yearRows[branch.id][currentYear];
    await prisma.feeHead.createMany({
      data: STANDARD_HEADS.map(([codeName, name, type, recurring]) => ({
        id: `fh_${branch.id}_${codeName}`,
        code: codeName,
        name,
        branchId: branch.id,
        type,
        isRecurring: recurring,
        isRefundable: false,
        gstApplicable: false,
      })),
      skipDuplicates: true,
    });
    const feeHeads = await prisma.feeHead.findMany({ where: { branchId: branch.id } });
    const head = (codeName: string) => feeHeads.find((h) => h.code === codeName)?.id ?? '';

    // Structures: tuition (all classes), annual (all), transport (all).
    const structureIds = new Map<string, string>();
    for (const [name, headCode, amount, frequency, dueDay] of [
      ['Monthly Tuition', 'TUITION', 0, 'MONTHLY', 10],
      ['Annual Fee', 'ANNUAL', 0, 'YEARLY', 15],
      ['Transport Fee', 'TRANSPORT', 1200, 'MONTHLY', 5],
    ] as Array<[string, string, number, FeeFrequency, number]>) {
      const fs = await prisma.feeStructure.upsert({
        where: { id: `fs_${branch.id}_${headCode}` },
        update: {},
        create: {
          id: `fs_${branch.id}_${headCode}`,
          name,
          branchId: branch.id,
          academicYearId: currentYearId,
        },
      });
      structureIds.set(headCode, fs.id);
      await prisma.feeStructureLine.createMany({
        data: [
          {
            id: `fsl_${fs.id}_${headCode}`,
            feeStructureId: fs.id,
            feeHeadId: head(headCode),
            amount: headCode === 'TUITION' ? 2000 : amount,
            frequency: frequency as never,
            dueDay,
          },
        ],
        skipDuplicates: true,
      });
      await prisma.feeStructureClass.createMany({
        data: classIds[branch.id][currentYear].map((clsId) => ({
          feeStructureId: fs.id,
          classId: clsId,
        })),
        skipDuplicates: true,
      });
    }

    const tuitionHead = head('TUITION');
    const annualHead = head('ANNUAL');

    let invNo = 0;
    let recNo = 0;
    const branchStudents = studentRows.filter((s) => s.branchId === branch.id);
    for (const s of branchStudents) {
      const inv1Id = `inv_${branch.id}_${s.id}_apr`;
      const inv2Id = `inv_${branch.id}_${s.id}_may`;
      const inv3Id = `inv_${branch.id}_${s.id}_annual`;
      const tuition = 2000;
      const annual = annualFor(0);

      // Concession: every 10th student gets RTE 25% off tuition.
      const rte = Number(s.id.slice(-2)) % 10 === 0;
      const disc1 = rte ? Math.round(tuition * 0.25) : 0;

      invoiceRows.push(
        {
          id: inv1Id, invoiceNo: `INV-${branchCodes[b]}-${++invNo}`, studentId: s.id, branchId: branch.id,
          academicYearId: currentYearId, periodStart: monthDay(2025, 4, 1), periodEnd: monthDay(2025, 4, 30),
          dueDate: monthDay(2025, 4, 10), totalAmount: tuition - disc1, discountAmount: disc1, paidAmount: 0, status: 'ISSUED',
        },
        {
          id: inv2Id, invoiceNo: `INV-${branchCodes[b]}-${++invNo}`, studentId: s.id, branchId: branch.id,
          academicYearId: currentYearId, periodStart: monthDay(2025, 5, 1), periodEnd: monthDay(2025, 5, 31),
          dueDate: monthDay(2025, 5, 10), totalAmount: tuition, discountAmount: 0, paidAmount: 0, status: 'ISSUED',
        },
        {
          id: inv3Id, invoiceNo: `INV-${branchCodes[b]}-${++invNo}`, studentId: s.id, branchId: branch.id,
          academicYearId: currentYearId, periodStart: null as unknown as Date, periodEnd: null as unknown as Date,
          dueDate: monthDay(2025, 6, 15), totalAmount: annual, discountAmount: 0, paidAmount: 0, status: 'ISSUED',
        },
      );
      lineRows.push(
        { id: `il_${inv1Id}_T`, invoiceId: inv1Id, feeHeadId: tuitionHead, description: 'Tuition — April', amount: tuition, discount: disc1 },
        { id: `il_${inv2Id}_T`, invoiceId: inv2Id, feeHeadId: tuitionHead, description: 'Tuition — May', amount: tuition, discount: 0 },
        { id: `il_${inv3Id}_A`, invoiceId: inv3Id, feeHeadId: annualHead, description: 'Annual Fee', amount: annual, discount: 0 },
      );
      ledgerRows.push(
        { id: `lg_${inv1Id}`, studentId: s.id, branchId: branch.id, academicYearId: currentYearId, type: 'DEMAND', amount: tuition - disc1, feeHeadId: tuitionHead, invoiceId: inv1Id, paymentId: null, description: 'Tuition — April', reference: `INV-${branchCodes[b]}` },
        { id: `lg_${inv2Id}`, studentId: s.id, branchId: branch.id, academicYearId: currentYearId, type: 'DEMAND', amount: tuition, feeHeadId: tuitionHead, invoiceId: inv2Id, paymentId: null, description: 'Tuition — May', reference: `INV-${branchCodes[b]}` },
        { id: `lg_${inv3Id}`, studentId: s.id, branchId: branch.id, academicYearId: currentYearId, type: 'DEMAND', amount: annual, feeHeadId: annualHead, invoiceId: inv3Id, paymentId: null, description: 'Annual Fee', reference: `INV-${branchCodes[b]}` },
      );

      // Payments: everyone pays April; 60% pay May; 20% pay part of Annual.
      const roll = Number(s.id.slice(-2));
      if (roll % 10 < 7 || roll % 10 === 0) {
        const pid = `pay_${branch.id}_${s.id}_apr`;
        paymentRows.push({ id: pid, studentId: s.id, branchId: branch.id, academicYearId: currentYearId, invoiceId: inv1Id, amount: tuition - disc1, method: 'UPI', status: 'SUCCESS', idempotencyKey: `idem_${pid}`, receiptNo: `REC-${branchCodes[b]}-${++recNo}`, paidAt: monthDay(2025, 4, 11) });
        ledgerRows.push({ id: `lgp_${pid}`, studentId: s.id, branchId: branch.id, academicYearId: currentYearId, type: 'PAYMENT', amount: -(tuition - disc1), feeHeadId: null, invoiceId: inv1Id, paymentId: pid, description: 'Payment via UPI', reference: `REC-${branchCodes[b]}` });
      }
      if (roll % 5 < 3) {
        const pid = `pay_${branch.id}_${s.id}_may`;
        paymentRows.push({ id: pid, studentId: s.id, branchId: branch.id, academicYearId: currentYearId, invoiceId: inv2Id, amount: tuition, method: 'CASH', status: 'SUCCESS', idempotencyKey: `idem_${pid}`, receiptNo: `REC-${branchCodes[b]}-${++recNo}`, paidAt: monthDay(2025, 5, 11) });
        ledgerRows.push({ id: `lgp_${pid}`, studentId: s.id, branchId: branch.id, academicYearId: currentYearId, type: 'PAYMENT', amount: -tuition, feeHeadId: null, invoiceId: inv2Id, paymentId: pid, description: 'Payment via CASH', reference: `REC-${branchCodes[b]}` });
      }
      if (roll % 10 < 2) {
        const pid = `pay_${branch.id}_${s.id}_annual`;
        const partial = Math.round(annual * 0.6);
        paymentRows.push({ id: pid, studentId: s.id, branchId: branch.id, academicYearId: currentYearId, invoiceId: inv3Id, amount: partial, method: 'ONLINE', status: 'SUCCESS', idempotencyKey: `idem_${pid}`, receiptNo: `REC-${branchCodes[b]}-${++recNo}`, paidAt: monthDay(2025, 6, 16) });
        ledgerRows.push({ id: `lgp_${pid}`, studentId: s.id, branchId: branch.id, academicYearId: currentYearId, type: 'PAYMENT', amount: -partial, feeHeadId: null, invoiceId: inv3Id, paymentId: pid, description: 'Payment via ONLINE', reference: `REC-${branchCodes[b]}` });
      }
    }
  }

  await prisma.invoice.createMany({ data: invoiceRows, skipDuplicates: true });
  await prisma.invoiceLine.createMany({ data: lineRows, skipDuplicates: true });
  await prisma.payment.createMany({ data: paymentRows, skipDuplicates: true });
  await prisma.feeLedger.createMany({ data: ledgerRows, skipDuplicates: true });

  // Invoice paidAmount/status from payments (keeps the tie-out honest).
  for (const p of paymentRows) {
    const inv = invoiceRows.find((i) => i.id === p.invoiceId);
    if (inv) {
      inv.paidAmount += p.amount;
      inv.status = inv.paidAmount >= inv.totalAmount - 1e-6 ? 'PAID' : 'PARTIALLY_PAID';
    }
  }
  await Promise.all(
    invoiceRows.map((i) =>
      prisma.invoice.update({
        where: { id: i.id },
        data: { paidAmount: i.paidAmount, status: i.status as never },
      }),
    ),
  );

  // ── 8b. Default CBSE grading scheme + bands per branch (fresh path) ──
  const schemeBands: Array<[string, number, number, number]> = [
    ['A1', 91, 100, 10], ['A2', 81, 90, 9], ['B1', 71, 80, 8], ['B2', 61, 70, 7],
    ['C1', 51, 60, 6], ['C2', 41, 50, 5], ['D', 33, 40, 4], ['E', 0, 32, 0],
  ];
  for (const branch of branches) {
    const currentYearId = yearRows[branch.id][currentYear];
    await prisma.gradingScheme.upsert({
      where: { id: `gs_${branch.id}` },
      update: {},
      create: {
        id: `gs_${branch.id}`,
        name: 'CBSE',
        branchId: branch.id,
        academicYearId: currentYearId,
        isDefault: true,
      },
    });
    await prisma.gradeBand.createMany({
      data: schemeBands.map(([grade, min, max, points]) => ({
        id: `gb_gs_${branch.id}_${grade}`,
        schemeId: `gs_${branch.id}`,
        grade,
        minPercent: min,
        maxPercent: max,
        points,
      })),
      skipDuplicates: true,
    });
  }

  // ── 9. Sequences (bump to the counts the seed created) ──
  for (const branch of branches) {
    for (const [codeName, count] of [
      ['ADMISSION', studentRows.filter((s) => s.branchId === branch.id).length],
      ['INVOICE', invoiceRows.filter((i) => i.branchId === branch.id).length],
      ['RECEIPT', paymentRows.filter((p) => p.branchId === branch.id).length],
      ['EMPLOYEE', staffRows.filter((s) => s.branchId === branch.id).length],
    ] as Array<[string, number]>) {
      await prisma.sequence.upsert({
        where: { branchId_code: { branchId: branch.id, code: codeName } },
        update: { currentValue: count },
        create: { branchId: branch.id, code: codeName, currentValue: count },
      });
    }
  }

  // ── 10. Terms, holidays, calendar ──
  for (const branch of branches) {
    for (const [yearName, yearId] of Object.entries(yearRows[branch.id])) {
      const startYear = Number(yearName.split('-')[0]);
      await prisma.term.createMany({
        data: [
          { name: 'Term 1', academicYearId: yearId, type: 'TERM', startDate: monthDay(startYear, 4, 1), endDate: monthDay(startYear, 9, 30) },
          { name: 'Term 2', academicYearId: yearId, type: 'TERM', startDate: monthDay(startYear, 10, 1), endDate: monthDay(startYear + 1, 3, 31) },
        ],
        skipDuplicates: true,
      });
      await prisma.holiday.createMany({
        data: [
          { branchId: branch.id, academicYearId: yearId, date: monthDay(startYear, 8, 15), name: 'Independence Day', type: 'NATIONAL' },
          { branchId: branch.id, academicYearId: yearId, date: monthDay(startYear, 10, 2), name: 'Gandhi Jayanti', type: 'NATIONAL' },
          { branchId: branch.id, academicYearId: yearId, date: monthDay(startYear + 1, 1, 26), name: 'Republic Day', type: 'NATIONAL' },
        ],
        skipDuplicates: true,
      });
    }
  }

  // ── 11. Light demo data: announcements, library, transport ──
  for (const branch of branches) {
    await prisma.announcement.createMany({
      data: [
        {
          title: 'Welcome to the new academic session',
          content: 'Classes begin April 1. Fee payment window opens April 2.',
          type: 'GENERAL',
          targetRoles: ['PARENT', 'TEACHER', 'STUDENT'],
          branchId: branch.id,
          createdBy: `usr_${sc}_${branchCodes[branches.indexOf(branch)].toLowerCase()}_admin`,
        },
      ],
      skipDuplicates: true,
    });
    await prisma.book.createMany({
      data: SUBJECTS.map((sub, s) => ({
        title: `${sub.name} for Class X`,
        author: 'R.D. Sharma',
        isbn: `978-93509431${s}${branches.indexOf(branch)}`,
        publisher: 'Academic Press',
        category: 'Textbook',
        totalCopies: 10,
        availableCopies: 10,
        shelfLocation: `Shelf-${sub.code}`,
        branchId: branch.id,
      })),
      skipDuplicates: true,
    });
    await prisma.vehicle.upsert({
      where: {
        branchId_vehicleNo: {
          branchId: branch.id,
          vehicleNo: `DL-01-${['AB', 'CD', 'EF'][branches.indexOf(branch)]}-1234`,
        },
      },
      update: {},
      create: {
        vehicleNo: `DL-01-${['AB', 'CD', 'EF'][branches.indexOf(branch)]}-1234`,
        type: 'Bus',
        capacity: 40,
        driverName: 'Rampal Singh',
        driverPhone: '+91 98765 00001',
        driverLicense: 'DL-0420110012345',
        branchId: branch.id,
      },
    });
  }

  return {
    schoolId: school.id,
    branchIds: branches.map((b) => b.id),
    academicYearIds: {
      past: yearRows[branches[0].id][pastYear],
      current: yearRows[branches[0].id][currentYear],
    },
    classLadder: [...CLASS_LADDER],
    stats: {
      students: studentRows.length,
      enrollments: enrollments.length,
      users: users.length,
      attendanceSessions: sessionRows.length,
      attendanceRecords: recordRows.length,
      attendanceSummaries: summaryRows.length,
      invoices: invoiceRows.length,
      invoiceLines: lineRows.length,
      payments: paymentRows.length,
      ledgerEntries: ledgerRows.length,
      examResults: resultRows.length,
    },
  };
}