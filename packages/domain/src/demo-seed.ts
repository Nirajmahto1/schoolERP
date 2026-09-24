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
    deviceTokens: number;
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

/** n calendar days before `base` (UTC). */
function daysBefore(n: number, base: Date): Date {
  const d = new Date(base);
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

/**
 * The school year the real calendar is in right now (Indian year: April–
 * March), expressed as the calendar year of its April 1. The seed used to
 * hardwire "2025-26" as current, so every demo aged past its own April:
 * attendance analytics went quiet, invoices lived a year back, and the
 * timetable engine's current-year scoping had nothing to chew on.
 */
export function currentSchoolYearStart(now: Date = new Date()): number {
  return now.getUTCMonth() + 1 >= 4 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
}

function isWeekend(d: Date): boolean {
  const day = d.getDay();
  return day === 0 || day === 6;
}

/**
 * The first N weekdays of the academic year — or, when the anchor is given,
 * the LAST N weekdays ending at the anchor. The live year anchors on
 * yesterday: a seed run in, say, February must put its 30 session days in
 * the recent window (dashboards and the at-risk feature window read the last
 * 30 days), not in April where they go stale the moment school starts.
 */
export function schoolDays(yearStart: number, count: number, endBefore?: Date): Date[] {
  if (!endBefore) {
    const days: Date[] = [];
    const d = monthDay(yearStart, 4, 1);
    while (days.length < count) {
      if (!isWeekend(d)) days.push(new Date(d));
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return days;
  }
  // Walk backwards from the anchor collecting weekdays, then restore order.
  const days: Date[] = [];
  const d = new Date(endBefore);
  d.setUTCDate(d.getUTCDate() - 1); // anchor is exclusive, as before
  while (days.length < count) {
    if (!isWeekend(d)) days.push(new Date(d));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return days.reverse();
}

// Deterministic pseudo-random (no Math.random — seeds must be reproducible).
function prand(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ── Correlated student profiles (Gate-7 recalibration follow-up) ──
//
// Real branches have a persistent weak-student factor: the same child who
// misses school also fails exams and falls behind on fees. The seed used to
// draw every mark, attendance status and payment independently, which made
// the at-risk analytics measure noise — a student's position within the
// branch said nothing about their next exam (docs/ops/gate-7-evidence.md §3:
// quantile membership lift 0.91 on independent draws). Each student now
// carries one latent profile from a three-stratum mixture, and all three
// signal generators read from it — so the demo tenant exercises the at-risk
// model the way a real school would.
interface StudentProfile {
  /** Latent academic ability — the mean each exam's marks are drawn around. */
  ability: number;
  /** Probability of PRESENT on a school day. */
  attendanceReliability: number;
  payApril: number;
  payMay: number;
  payAnnual: number;
  /** Share of the annual fee cleared when the family does engage. */
  annualPct: number;
}

const STRATA = [
  // share, ability mean, marks spread, attendance base, payment probabilities
  // Weak families prioritise monthly tuition over the annual lump sum —
  // modelled: payMay stays high while payAnnual collapses. Arrears then
  // cluster on the weak stratum (~40% of the branch owes something) instead
  // of being universal.
  { share: 0.12, ability: 45, attendance: 0.88, payApril: 0.92, payMay: 0.75, payAnnual: 0.2, annualPct: 0.5 }, // struggling
  { share: 0.6, ability: 64, attendance: 0.93, payApril: 0.99, payMay: 0.9, payAnnual: 0.6, annualPct: 1.0 }, // average
  { share: 0.28, ability: 82, attendance: 0.97, payApril: 1.0, payMay: 0.98, payAnnual: 0.9, annualPct: 1.0 }, // strong
] as const;

/**
 * One student's latent profile, from the shared RNG stream.
 *
 * `pinAverage` holds the first student of each branch in the middle stratum:
 * gate2.test asserts plausibility floors (> 40 marks, > 80% attendance) on an
 * arbitrary student, and with deterministic streams that student is always
 * the first one seeded — pinning keeps the gate meaningful instead of flaky
 * by construction.
 */
function sampleProfile(rand: () => number, pinAverage: boolean): StudentProfile {
  const stratum = pinAverage ? STRATA[1] : (() => {
    const r = rand();
    let acc = 0;
    for (const st of STRATA) {
      acc += st.share;
      if (r < acc) return st;
    }
    return STRATA[STRATA.length - 1];
  })();

  // Box–Muller: ability is normal around the stratum mean, so a branch gets
  // a realistic continuum rather than three discrete bands.
  const u1 = Math.max(rand(), 1e-9);
  const u2 = rand();
  const gauss = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const ability = Math.min(98, Math.max(20, Math.round(stratum.ability + gauss * 8)));

  // Chronic absenteeism (~2%): mostly independent of ability, as in real
  // schools — illness and distance, not marks, keep these children home.
  const chronic = !pinAverage && rand() < 0.02;
  const attendanceReliability = chronic
    ? 0.68 + rand() * 0.06
    : Math.min(0.99, Math.max(0.75, stratum.attendance + (rand() - 0.5) * 0.04));

  return {
    ability,
    attendanceReliability,
    payApril: stratum.payApril,
    payMay: stratum.payMay,
    payAnnual: stratum.payAnnual,
    annualPct: stratum.annualPct,
  };
}

/** Marks for one student-subject-exam: ability + subject + day noise. */
function sampleMarks(rand: () => number, profile: StudentProfile): number {
  const subjectNoise = (rand() - 0.5) * 10; // ±5: stronger/weaker subjects
  const examNoise = (rand() - 0.5) * 8; // ±4: how the day went
  return Math.min(100, Math.max(5, Math.round(profile.ability + subjectNoise + examNoise)));
}

export async function seedDemoTenant(
  prisma: PrismaClient,
  options: DemoSeedOptions = {},
): Promise<DemoSeedResult> {
  const code = (options.code ?? 'DEMO').toUpperCase();
  const schoolName = options.schoolName ?? 'Sunrise Public School';
  const branchCount = options.branches ?? 3;
  const perBranch = options.studentsPerBranch ?? 400;
  const attDays = options.attendanceDaysPerYear ?? 30;
  const offset = options.offset ?? 0;
  const rand = prand(20260830 + offset);
  const now = new Date();

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

  // ── 2. Academic years: previous + the school year that contains TODAY ──
  // Derived from the wall clock (Apr–Mar), so the demo never ages: whatever
  // day you seed on, "current" is the year you are actually living in.
  const curStart = currentSchoolYearStart();
  const curLabel = `${curStart}-${String(curStart + 1).slice(2)}`;
  const pastLabel = `${curStart - 1}-${String(curStart).slice(2)}`;
  const years = [pastLabel, curLabel];
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
          isCurrent: name === curLabel,
          branchId: branch.id,
        },
      });
      (yearRows[branch.id] ??= {})[name] = row.id;
    }
  }
  const currentYear = curLabel;
  const pastYear = pastLabel;

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

  // Sized for the timetable (BUILD_PLAN 6.2): 15 classes × 2 sections × 5
  // subjects at the default 4 periods/week needs ~30 teachers per branch for
  // the solver's static pre-check to pass — 10 leaves a 240-vs-36 gap that
  // makes every generated timetable infeasible.
  const TEACHERS_PER_BRANCH = 30;
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
  // Per-student latent profile — marks, attendance and payments all read
  // from this (see the correlated-profiles note above prand).
  const profiles = new Map<string, StudentProfile>();
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
          profiles.set(sId, sampleProfile(rand, i === 0));

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
              fromDate: monthDay(curStart - 1, 4, 1),
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
              fromDate: monthDay(curStart, 4, 1),
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

  // yearId → id-scope tag + calendar start year (used for collision-free ids
  // and for summary rows that must carry the right calendar year).
  const yearMeta = new Map<string, { dayTag: string; startYear: number }>();
  for (const branch of branches) {
    for (const [yearName, yearId] of Object.entries(yearRows[branch.id])) {
      const sy = Number(yearName.split('-')[0]);
      yearMeta.set(yearId, { dayTag: `${yearName === pastYear ? 'p' : 'c'}${sy}`, startYear: sy });
    }
  }

  for (let b = 0; b < branches.length; b++) {
    const branch = branches[b];
    for (const [yearName, yearId] of Object.entries(yearRows[branch.id])) {
      const startYear = Number(yearName.split('-')[0]);
      // The live year cannot have school days in the future — attendance in
      // the "current" year stops at today (so rate dashboards light up),
      // while the past year keeps its full window.
      const days = schoolDays(startYear, attDays, yearName === currentYear ? daysBefore(1, now) : undefined);
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

      // Year-scoped ids: the same day index across two years must not share
      // one id (the old single-window ids collided across years).
      const dayTag = yearName === pastYear ? `p${startYear}` : `c${startYear}`;
      for (let di = 0; di < days.length; di++) {
        const date = days[di];
        for (const clsId of yearClasses) {
          const sections = sectionIds[clsId] ?? [];
          for (const secId of sections) {
            const students = sectionStudents.get(secId) ?? [];
            if (students.length === 0) continue;
            const sessionId = `ats_${branch.id}_${dayTag}_${di}_${clsId}_${secId}`;
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
              // Correlated attendance: the student's own reliability drives
              // the day's status — chronic absentees and weak-stratum
              // students now visibly rack up absences.
              const prof = profiles.get(studentId);
              const r = rand();
              const presentP = prof ? prof.attendanceReliability : 0.92;
              const status = r < presentP ? 'PRESENT' : r < Math.min(0.97, presentP + 0.05) ? 'ABSENT' : 'LATE';
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
        id: `sum_${branchId}_${yearMeta.get(yearId)?.dayTag}_${studentId}_${m}`,
        studentId,
        branchId,
        academicYearId: yearId,
        year: yearMeta.get(yearId)?.startYear ?? 0,
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
      const sy = Number(yearName.split('-')[0]);
      // Past year keeps its traditional December slot. The LIVE year's exam
      // must be fully in the past with results published — that is the whole
      // point of the demo (dashboards read the newest published exam; the
      // at-risk harness splits on it). Prefer the December slot when it has
      // already passed this school year; otherwise sit two weeks behind
      // today, never before mid-April of the school year itself.
      let examStart: Date;
      let examEnd: Date;
      let publishedAt: Date;
      if (yearName === currentYear) {
        const december = monthDay(sy, 12, 1);
        const recent = daysBefore(14, now);
        const earliest = monthDay(sy, 4, 15);
        examStart = december.getTime() < recent.getTime()
          ? december
          : recent.getTime() > earliest.getTime()
            ? recent
            : earliest;
        if (examStart.getTime() >= now.getTime()) {
          // Seeded in the first days of the school year — any in-year slot
          // would be in the future, so put the exam in the just-passed days.
          examStart = daysBefore(6, now);
        }
        examEnd = new Date(examStart.getTime() + 13 * 86400000);
        publishedAt = new Date(Math.min(examStart.getTime() + 17 * 86400000, daysBefore(1, now).getTime()));
      } else {
        examStart = monthDay(sy, 12, 1);
        examEnd = monthDay(sy, 12, 14);
        publishedAt = monthDay(sy, 12, 18);
      }
      examRows.push({
        id: examId,
        name: examName,
        academicYearId: yearId,
        branchId: branch.id,
        assessmentTypeId: null,
        startDate: examStart,
        endDate: examEnd,
        status: 'PUBLISHED',
        publishedAt,
        publishedBy: `usr_${sc}_${bcode}_principal`,
      });

      for (const clsId of classIds[branch.id][yearName]) {
        const classIdx = classIds[branch.id][yearName].indexOf(clsId);
        const classEnrollments = enrollmentsByYearClass.get(`${yearId}|${clsId}`) ?? [];
        for (let s = 0; s < SUBJECTS.length; s++) {
          const sub = SUBJECTS[s];
          const subjectId = `sub_${clsId}_${sub.code}`;
          subjectRows.push({ id: subjectId, name: sub.name, code: sub.code, classId: clsId, type: 'THEORY' });
          if (TEACHERS_PER_BRANCH > 0) {
            // Spread across the FULL staff pool, keyed by class index within
            // the year — the old (b*5+s)%10 pinned all allocations to 5 of the
            // 10 teachers (240 demanded lessons/week vs a 36 cap), which the
            // timetable engine's static pre-check rightly rejects.
            const teacherIdx = (b * 7 + classIdx * SUBJECTS.length + s) % TEACHERS_PER_BRANCH;
            const staffId = `stf_${sc}_${bcode}_${teacherIdx}`;
            subjectTeacherRows.push({ id: `st_${subjectId}_${staffId}`, subjectId, staffId });
          }
          const esId = `es_${examId}_${subjectId}`;
          examSubjectRows.push({
            id: esId,
            examinationId: examId,
            subjectId,
            examDate: new Date(examStart.getTime() + s * 86400000),
            startTime: '09:00',
            endTime: '12:00',
            maxMarks: 100,
            passingMarks: 33,
          });

          for (const e of classEnrollments) {
            // Correlated marks: the student's latent ability, plus subject
            // and day noise (see sampleMarks) — the same student is
            // recognisably the same across exams, which is what makes the
            // at-risk model learnable.
            const marks = sampleMarks(rand, profiles.get(e.studentId) ?? { ability: 70, attendanceReliability: 0.92, payApril: 1, payMay: 0.6, payAnnual: 0.15, annualPct: 0.6 });
            resultRows.push({
              id: `er_${esId}_${e.studentId}`,
              examSubjectId: esId,
              studentId: e.studentId,
              marksObtained: marks,
              grade: gradeFor(marks),
              enteredBy: `usr_${sc}_${bcode}_teach${(classIdx * SUBJECTS.length + s) % TEACHERS_PER_BRANCH}`,
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
    paidAmount: number; status: InvoiceStatus; createdAt: Date;
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
          academicYearId: currentYearId, periodStart: monthDay(curStart, 4, 1), periodEnd: monthDay(curStart, 4, 30),
          createdAt: monthDay(curStart, 4, 8),
          dueDate: monthDay(curStart, 4, 10), totalAmount: tuition - disc1, discountAmount: disc1, paidAmount: 0, status: 'ISSUED',
        },
        {
          id: inv2Id, invoiceNo: `INV-${branchCodes[b]}-${++invNo}`, studentId: s.id, branchId: branch.id,
          academicYearId: currentYearId, periodStart: monthDay(curStart, 5, 1), periodEnd: monthDay(curStart, 5, 31),
          createdAt: monthDay(curStart, 5, 8),
          dueDate: monthDay(curStart, 5, 10), totalAmount: tuition, discountAmount: 0, paidAmount: 0, status: 'ISSUED',
        },
        {
          id: inv3Id, invoiceNo: `INV-${branchCodes[b]}-${++invNo}`, studentId: s.id, branchId: branch.id,
          academicYearId: currentYearId, periodStart: null as unknown as Date, periodEnd: null as unknown as Date,
          createdAt: monthDay(curStart, 6, 10),
          dueDate: monthDay(curStart, 6, 15), totalAmount: annual, discountAmount: 0, paidAmount: 0, status: 'ISSUED',
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

      // Payments follow the student's latent profile too — arrears cluster
      // on the struggling stratum instead of being id-hash noise.
      const prof = profiles.get(s.id);
      const roll = Number(s.id.slice(-2));
      const payP = (p: number, fallback: boolean) => (prof ? rand() < p : fallback);
      if (payP(prof?.payApril ?? 0.8, roll % 10 < 7 || roll % 10 === 0)) {
        const pid = `pay_${branch.id}_${s.id}_apr`;
        paymentRows.push({ id: pid, studentId: s.id, branchId: branch.id, academicYearId: currentYearId, invoiceId: inv1Id, amount: tuition - disc1, method: 'UPI', status: 'SUCCESS', idempotencyKey: `idem_${pid}`, receiptNo: `REC-${branchCodes[b]}-${++recNo}`, paidAt: monthDay(curStart, 4, 11) });
        ledgerRows.push({ id: `lgp_${pid}`, studentId: s.id, branchId: branch.id, academicYearId: currentYearId, type: 'PAYMENT', amount: -(tuition - disc1), feeHeadId: null, invoiceId: inv1Id, paymentId: pid, description: 'Payment via UPI', reference: `REC-${branchCodes[b]}` });
      }
      if (payP(prof?.payMay ?? 0.6, roll % 5 < 3)) {
        const pid = `pay_${branch.id}_${s.id}_may`;
        paymentRows.push({ id: pid, studentId: s.id, branchId: branch.id, academicYearId: currentYearId, invoiceId: inv2Id, amount: tuition, method: 'CASH', status: 'SUCCESS', idempotencyKey: `idem_${pid}`, receiptNo: `REC-${branchCodes[b]}-${++recNo}`, paidAt: monthDay(curStart, 5, 11) });
        ledgerRows.push({ id: `lgp_${pid}`, studentId: s.id, branchId: branch.id, academicYearId: currentYearId, type: 'PAYMENT', amount: -tuition, feeHeadId: null, invoiceId: inv2Id, paymentId: pid, description: 'Payment via CASH', reference: `REC-${branchCodes[b]}` });
      }
      if (payP(prof?.payAnnual ?? 0.2, roll % 10 < 2)) {
        const pid = `pay_${branch.id}_${s.id}_annual`;
        const partial = Math.round(annual * (prof?.annualPct ?? 0.6));
        paymentRows.push({ id: pid, studentId: s.id, branchId: branch.id, academicYearId: currentYearId, invoiceId: inv3Id, amount: partial, method: 'ONLINE', status: 'SUCCESS', idempotencyKey: `idem_${pid}`, receiptNo: `REC-${branchCodes[b]}-${++recNo}`, paidAt: monthDay(curStart, 6, 16) });
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

  // ── 12. Parent-app adoption: ~75% of families have the app installed ──
  // The analytics adoption metric counts active device tokens per family;
  // without this the parent-app-adoption chart reads 0% on a fresh seed.
  const adoptableGuardians = new Set(
    studentGuardianRows.filter((sg) => sg.receivesComms).map((sg) => sg.guardianId),
  );
  const guardianUserById = new Map(guardianRows.map((g) => [g.id, g.userId]));
  const adoptees = [...adoptableGuardians]
    .map((gid) => guardianUserById.get(gid))
    .filter((uid): uid is string => !!uid)
    .sort(() => Math.random() - 0.5)
    .slice(0, Math.ceil(adoptableGuardians.size * 0.75));
  await prisma.deviceToken.createMany({
    data: adoptees.map((uid, i) => ({
      id: `dt_${sc}_${String(i + 1).padStart(4, '0')}`,
      userId: uid,
      token: `seed-fcm-${sc}-${uid}`,
      platform: Math.random() < 0.85 ? 'ANDROID' : 'IOS',
      label: 'Parent app (demo seed)',
      isActive: true,
    })),
    skipDuplicates: true,
  });

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
      deviceTokens: adoptees.length,
    },
  };
}