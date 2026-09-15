// ──────────────────────────────────────────────
// Timetable engine integration (BUILD_PLAN Phase 6.2)
//
// The Go timetable-engine solves; this module is the DB-side adapter that
//   1. builds the engine's Problem spec from the branch's live data
//      (sections with enrollment strength, subject demands via
//      SubjectTeacher, locked slots from the existing grid),
//   2. calls the engine over a peer assertion (same pattern as the
//      attendance-service absence-alert fire),
//   3. on "solved" persists the result as TimetableSlot rows inside ONE
//      transaction — an infeasible result writes NOTHING.
//
// Partial regeneration (the plan's "locked slots + partial regeneration"):
// `keepSectionIds` freezes those sections — every existing slot of a kept
// section becomes a LockedSlot, and only the remaining sections' slots are
// deleted and re-solved. Kept sections still constrain the solver through
// the shared-teacher hard rules.
// ──────────────────────────────────────────────

import type { PrismaClient } from '@school-erp/database';
import { mintAssertion } from '@school-erp/auth';

export const DEFAULT_DAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];

export interface PeriodTimeSpec {
  start: string; // "08:00"
  end: string;   // "08:45"
}

export interface GenerateOptions {
  days?: string[];
  periods?: number;
  periodTimes?: PeriodTimeSpec[];
  /** Per-subject override (by subject id); everything else uses 4/week. */
  subjectPeriods?: Record<string, number>;
  /** Sections whose existing timetable is frozen (locked) this run. */
  keepSectionIds?: string[];
  /** Per-teacher overrides: daily cap and notConsecutive. */
  teacherOverrides?: Record<string, { maxPerDay?: number; notConsecutive?: boolean }>;
  seed?: number;
}

export interface TimetableDeps {
  engineBaseUrl: string;
  internalAssertionPrivateKey?: string;
  fetchImpl?: typeof fetch;
}

interface EngineSlot {
  day: string;
  period: number;
  sectionId: string;
  subjectId: string;
  teacherId: string;
  roomId: string;
  locked?: boolean;
}

interface EngineResult {
  status: 'solved' | 'infeasible';
  slots?: EngineSlot[];
  violations?: Array<{ rule: string; detail: string }>;
  stats?: { attempts: number; nodesExplored: number; elapsedMs: number; placements: number };
}

/** Default period grid: 8 × 45-minute periods from 08:00, lunch after P4. */
export function defaultPeriodTimes(periods: number): PeriodTimeSpec[] {
  const out: PeriodTimeSpec[] = [];
  let cursor = 8 * 60; // minutes from midnight
  for (let i = 0; i < periods; i++) {
    const start = `${String(Math.floor(cursor / 60)).padStart(2, '0')}:${String(cursor % 60).padStart(2, '0')}`;
    cursor += 45;
    const end = `${String(Math.floor(cursor / 60)).padStart(2, '0')}:${String(cursor % 60).padStart(2, '0')}`;
    out.push({ start, end });
    if (i === 3) cursor += 30; // lunch break after period 4
  }
  return out;
}

const DAY_NAMES = new Set(DEFAULT_DAYS);

/** "2026-09-09" (UTC) → "WEDNESDAY". */
export function dayNameOf(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  return ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'][d.getUTCDay()];
}

/**
 * Generate for a branch: build → solve → persist. Returns the engine result
 * plus the persisted slot count (0 when infeasible — nothing is written).
 */
export async function generateAndPersist(
  prisma: PrismaClient,
  branchId: string,
  opts: GenerateOptions,
  deps: TimetableDeps,
  actor: { userId: string; email: string; tenantId: string },
): Promise<{ engine: EngineResult; persisted: number; skipped: Array<{ sectionId: string; subjectId: string; reason: string }> }> {
  const { problem, skipped } = await buildProblem(prisma, branchId, opts);
  const result = await callEngine<EngineResult>(deps, actor, '/timetable/generate', problem);

  if (result.status !== 'solved' || !result.slots) {
    return { engine: result, persisted: 0, skipped };
  }

  const periodTimes = problem.periodTimes as PeriodTimeSpec[];
  const keep = new Set(opts.keepSectionIds ?? []);

  // Sections being regenerated = every branch section (current year) minus the
  // frozen ones.
  const currentYear = await prisma.academicYear.findFirst({
    where: { branchId, isCurrent: true },
    select: { id: true },
  });
  const branchSections = await prisma.class.findMany({
    where: { branchId, deletedAt: null, academicYearId: currentYear?.id ?? undefined },
    select: { sections: { where: { deletedAt: null }, select: { id: true } } },
  });
  const regenerateIds = branchSections
    .flatMap((c) => c.sections.map((s) => s.id))
    .filter((id) => !keep.has(id));

  await prisma.$transaction(async (tx) => {
    await tx.timetableSlot.deleteMany({ where: { sectionId: { in: regenerateIds } } });
    const rows = result.slots!.filter((s) => regenerateIds.includes(s.sectionId));
    if (rows.length > 0) {
      await tx.timetableSlot.createMany({
        data: rows.map((s) => ({
          sectionId: s.sectionId,
          subjectId: s.subjectId,
          staffId: s.teacherId || null,
          day: s.day,
          startTime: periodTimes[s.period - 1]?.start ?? `P${s.period}`,
          endTime: periodTimes[s.period - 1]?.end ?? `P${s.period}`,
          room: s.roomId || null,
        })),
      });
    }
  });

  return {
    engine: result,
    persisted: result.slots!.filter((s) => regenerateIds.includes(s.sectionId)).length,
    skipped,
  };
}

/**
 * Build the engine's SubstitutionProblem from the DB: the day's slots across
 * the branch, the absentees, and the SubjectTeacher qualification map.
 */
export async function buildSubstitutionProblem(
  prisma: PrismaClient,
  branchId: string,
  date: string,
  absent: string[],
  periodTimes: PeriodTimeSpec[],
): Promise<Record<string, unknown>> {
  const day = dayNameOf(date);
  const dayDate = new Date(`${date}T00:00:00Z`);

  // startTime → period index on the day's grid (1-based, matching the engine).
  const startToPeriod = new Map<string, number>();
  periodTimes.forEach((pt, i) => startToPeriod.set(pt.start, i + 1));
  const periods = periodTimes.length;

  const slots = await prisma.timetableSlot.findMany({
    where: {
      day,
      section: { class: { branchId, deletedAt: null }, deletedAt: null },
    },
    select: { id: true, sectionId: true, subjectId: true, staffId: true, startTime: true, endTime: true },
  });

  // Absentees on this date: explicit list ∪ approved leave spanning the date.
  const onLeave = await prisma.leaveRequest.findMany({
    where: {
      status: 'APPROVED',
      startDate: { lte: dayDate },
      endDate: { gte: dayDate },
      staff: { isActive: true, deletedAt: null, OR: [{ branchId }, { branchAssignments: { some: { branchId } } }] },
    },
    select: { staffId: true },
  });
  const absentees = new Set(absent);
  for (const lr of onLeave) absentees.add(lr.staffId);

  const staff = await prisma.staff.findMany({
    where: {
      isActive: true,
      deletedAt: null,
      OR: [{ branchId }, { branchAssignments: { some: { branchId } } }],
    },
    select: { id: true, firstName: true, lastName: true },
  });

  // Qualification: subjectId → staff ids who teach it anywhere in this branch.
  const qualRows = await prisma.subjectTeacher.findMany({
    where: { staff: { isActive: true, deletedAt: null, OR: [{ branchId }, { branchAssignments: { some: { branchId } } }] } },
    select: { subjectId: true, staffId: true },
  });
  const qualified: Record<string, string[]> = {};
  for (const q of qualRows) {
    (qualified[q.subjectId] ??= []).push(q.staffId);
  }

  return {
    day,
    periods,
    timetable: slots
      .filter((s) => startToPeriod.has(s.startTime))
      .map((s) => ({
        id: s.id,
        day,
        period: startToPeriod.get(s.startTime) as number,
        sectionId: s.sectionId,
        subjectId: s.subjectId,
        teacherId: s.staffId ?? '',
        startTime: s.startTime,
      })),
    absent: [...absentees],
    staff: staff.map((s) => ({ id: s.id, name: `${s.firstName} ${s.lastName}` })),
    qualified,
  };
}

/** Peer call to the engine with a 30-second, audience-bound assertion. */
export async function callEngine<T>(
  deps: TimetableDeps,
  actor: { userId: string; email: string; tenantId: string },
  path: string,
  body: unknown,
): Promise<T> {
  if (!deps.internalAssertionPrivateKey) {
    throw Object.assign(new Error('Timetable engine not configured: INTERNAL_ASSERTION_PRIVATE_KEY missing.'), { status: 503 });
  }
  const assertion = mintAssertion(
    {
      userId: actor.userId,
      email: actor.email,
      tenantId: actor.tenantId,
      roles: ['SYSTEM'],
      audience: 'timetable-engine',
    },
    { privateKey: deps.internalAssertionPrivateKey, ttlSeconds: 30 },
  );
  const fetchImpl = deps.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(`${deps.engineBaseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-assertion': assertion },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw Object.assign(new Error(`Timetable engine unreachable at ${deps.engineBaseUrl}: ${(err as Error).message}`), { status: 502 });
  }
  const payload = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw Object.assign(new Error(payload?.error || `Timetable engine failed (${res.status})`), { status: res.status });
  }
  return payload;
}

/**
 * Build the engine's Problem spec from the branch's live data: sections with
 * enrollment strength, subject demands via SubjectTeacher, and locked slots
 * from the frozen sections' existing grid.
 */
export async function buildProblem(
  prisma: PrismaClient,
  branchId: string,
  opts: GenerateOptions,
): Promise<{ problem: Record<string, unknown>; skipped: Array<{ sectionId: string; subjectId: string; reason: string }> }> {
  const days = opts.days?.length ? opts.days : DEFAULT_DAYS;
  const periods = opts.periods ?? 8;
  const periodTimes = opts.periodTimes?.length ? opts.periodTimes : defaultPeriodTimes(periods);
  if (periodTimes.length !== periods) {
    throw new Error(`periodTimes must have exactly ${periods} entries.`);
  }

  const keep = new Set(opts.keepSectionIds ?? []);

  // Sections (strength = active enrollments) + their class's subjects, with
  // the allocated teacher per subject — scoped to the CURRENT academic year.
  // Without the scoping, a tenant with a seeded past year gets every
  // class-subject demanded twice (once per year), doubling teacher demand and
  // making otherwise-feasible problems statically infeasible.
  const currentYear = await prisma.academicYear.findFirst({
    where: { branchId, isCurrent: true },
    select: { id: true },
  });
  const classes = await prisma.class.findMany({
    where: { branchId, deletedAt: null, academicYearId: currentYear?.id ?? undefined },
    select: {
      id: true,
      name: true,
      sections: {
        where: { deletedAt: null },
        select: {
          id: true,
          name: true,
          _count: { select: { enrollments: { where: { status: 'ENROLLED' } } } },
        },
      },
      subjects: {
        where: { deletedAt: null },
        select: {
          id: true,
          code: true,
          name: true,
          teachers: { select: { staffId: true }, take: 1 },
        },
      },
    },
  });

  // Teachers: active staff of the branch + shared teachers assigned to it.
  const staffRows = await prisma.staff.findMany({
    where: {
      isActive: true,
      deletedAt: null,
      OR: [{ branchId }, { branchAssignments: { some: { branchId } } }],
    },
    select: { id: true, firstName: true, lastName: true },
  });

  const sections: Array<Record<string, unknown>> = [];
  const requirements: Array<Record<string, unknown>> = [];
  const skipped: Array<{ sectionId: string; subjectId: string; reason: string }> = [];
  const usedTeachers = new Set<string>();

  for (const cls of classes) {
    for (const sec of cls.sections) {
      sections.push({
        id: sec.id,
        name: `${cls.name}-${sec.name}`,
        grade: cls.name,
        strength: sec._count.enrollments,
      });
      for (const subj of cls.subjects) {
        const teacher = subj.teachers[0]?.staffId;
        if (!teacher) {
          skipped.push({ sectionId: sec.id, subjectId: subj.id, reason: 'no teacher allocated' });
          continue;
        }
        if (!staffRows.some((s) => s.id === teacher)) {
          skipped.push({ sectionId: sec.id, subjectId: subj.id, reason: 'allocated teacher is not active in this branch' });
          continue;
        }
        const perWeek = opts.subjectPeriods?.[subj.id] ?? 4;
        requirements.push({
          subjectId: subj.id,
          subjectName: subj.name,
          sectionId: sec.id,
          teacherId: teacher,
          periodsPerWeek: perWeek,
        });
        usedTeachers.add(teacher);
      }
    }
  }

  const teachers = staffRows
    .filter((s) => usedTeachers.has(s.id))
    .map((s) => {
      const o = opts.teacherOverrides?.[s.id] ?? {};
      return {
        id: s.id,
        name: `${s.firstName} ${s.lastName}`,
        maxPerDay: o.maxPerDay ?? 6,
        notConsecutive: o.notConsecutive ?? false,
      };
    });

  // Locked slots: the frozen sections' existing grid. Period index comes from
  // startTime → grid mapping; slots off-grid are skipped (nothing to pin to).
  const startToPeriod = new Map<string, number>();
  periodTimes.forEach((pt, i) => startToPeriod.set(pt.start, i + 1));

  const lockSectionIds = [...keep];
  const lockedRows = lockSectionIds.length
    ? await prisma.timetableSlot.findMany({
        where: { sectionId: { in: lockSectionIds } },
        select: { sectionId: true, subjectId: true, staffId: true, day: true, startTime: true },
      })
    : [];

  const locked = lockedRows
    .filter((s) => DAY_NAMES.has(s.day) && startToPeriod.has(s.startTime) && s.staffId)
    .map((s) => ({
      day: s.day,
      period: startToPeriod.get(s.startTime) as number,
      sectionId: s.sectionId,
      subjectId: s.subjectId,
      teacherId: s.staffId as string,
    }));

  const problem = {
    days,
    periods,
    periodTimes,
    teachers,
    sections,
    rooms: [], // no Room entity yet — rooms are unmanaged (free text on the slot)
    requirements,
    locked,
    seed: opts.seed ?? 42,
    options: {},
  };
  return { problem, skipped };
}