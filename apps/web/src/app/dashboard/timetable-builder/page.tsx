'use client';
// ──────────────────────────────────────────────
// Timetable Builder — built for principals, HODs and academic heads.
//
// LEFT: the class's subject palette (colored chips, each with its default
//   teacher selectable right on the chip).
// RIGHT: the whole week — periods across the top (P1…P8), days down the side.
//
//   1. Drag a subject into any empty cell.
//   2. A teacher dropdown opens immediately — pick who takes that lecture.
//
// One teacher, one place, one time: every teacher already booked at that
// (day, period) — in ANY section of the school — is greyed out in the
// dropdown. The server re-checks on save (409) so a race can never slip in.
//
// The lunch break is a real column: after P4 the grid inserts a LUNCH spacer
// between period columns, matching the 45+30 minute day grid.
//
// Auto-generate (the Go solver: max 8 lectures/day, lunch after 4) stays one
// click away for the "just give me a timetable" path.
// ──────────────────────────────────────────────

import Topbar from '@/components/Topbar';
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useLoading } from '@/context/LoadingContext';
import { academicApi, staffApi, timetableApi } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';

const DAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'] as const;
const DAY_SHORT: Record<string, string> = { MONDAY: 'Monday', TUESDAY: 'Tuesday', WEDNESDAY: 'Wednesday', THURSDAY: 'Thursday', FRIDAY: 'Friday', SATURDAY: 'Saturday' };
const MAX_PERIODS = 8;
const LUNCH_AFTER = 4; // lunch column inserted after period 4
const PERIOD_MIN = 45;
const LUNCH_MIN = 30;

function defaultPeriodTimes(n = MAX_PERIODS) {
  const out: Array<{ start: string; end: string }> = [];
  let cursor = 8 * 60;
  const fmt = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  for (let i = 0; i < n; i++) {
    out.push({ start: fmt(cursor), end: fmt(cursor + PERIOD_MIN) });
    cursor += PERIOD_MIN;
    if (i === LUNCH_AFTER - 1) cursor += LUNCH_MIN; // the lunch gap lives here
  }
  return out;
}
const PERIOD_TIMES = defaultPeriodTimes();
/** Column headers = P1..P4, LUNCH, P5..P8. */
const COLUMNS: Array<{ period: number | null }> = [
  ...Array.from({ length: LUNCH_AFTER }, (_, i) => ({ period: i + 1 })),
  { period: null },
  ...Array.from({ length: MAX_PERIODS - LUNCH_AFTER }, (_, i) => ({ period: i + LUNCH_AFTER + 1 })),
];

const subjectColors: Record<string, string> = { Mathematics: '#5048E5', Science: '#10B981', English: '#3B82F6', Hindi: '#F59E0B', 'Social Science': '#EC4899', 'Physical Ed.': '#8B5CF6', Art: '#F97316', Computer: '#0EA5E9' };
const palette = ['#5048E5', '#10B981', '#3B82F6', '#F59E0B', '#EC4899', '#8B5CF6', '#F97316', '#0EA5E9', '#6366F1', '#059669', '#D946EF', '#14B8A6'];
const colorFor = (name: string) => {
  if (subjectColors[name]) return subjectColors[name];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
};

type SubjectChip = { id: string; name: string; code: string; teacherId: string | null; assignmentId: string | null; teacherName: string };

export default function TimetableBuilderPage() {
  const { user } = useAuth();
  const { startLoading, stopLoading } = useLoading();

  const [classes, setClasses] = useState<any[]>([]);
  const [staffList, setStaffList] = useState<any[]>([]);
  const [subjectsByClass, setSubjectsByClass] = useState<Record<string, SubjectChip[]>>({});
  const [activeClassId, setActiveClassId] = useState('');
  const [loadingData, setLoadingData] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [slots, setSlots] = useState<any[]>([]);       // active section
  const [allSlots, setAllSlots] = useState<any[]>([]); // whole branch (busy detection)
  const [cellError, setCellError] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ day: string; period: number } | null>(null);
  const [pending, setPending] = useState<{ day: string; period: number } | null>(null);
  const dragSubject = useRef<SubjectChip | null>(null);
  const [draggingName, setDraggingName] = useState<string | null>(null);

  // Auto-generate panel
  const [generating, setGenerating] = useState(false);
  const [genResult, setGenResult] = useState<any>(null);
  const [showGen, setShowGen] = useState(false);

  const activeClass = classes.find((c) => c.id === activeClassId);
  const sections = activeClass?.sections || [];
  const [sectionId, setSectionId] = useState('');
  const activeSectionId = sectionId || sections[0]?.id || '';
  const subjects = subjectsByClass[activeClassId] || [];

  const loadEverything = useCallback(async () => {
    setLoadingData(true);
    setLoadError(null);
    try {
      const [cls, st] = await Promise.all([academicApi.getClasses(), staffApi.list()]);
      const classList = cls.data || [];
      setClasses(classList);
      setStaffList(st.data || []);
      if (classList[0]) setActiveClassId(classList[0].id);
      const results = await Promise.all(classList.map((c: any) => academicApi.getSubjects(c.id).catch(() => ({ data: [] }))));
      const map: Record<string, SubjectChip[]> = {};
      classList.forEach((c: any, i: number) => {
        map[c.id] = (results[i].data || []).map((s: any) => {
          const t = s.teachers?.[0];
          return {
            id: s.id, name: s.name, code: s.code,
            teacherId: t?.staffId ?? null,
            assignmentId: t?.id ?? null, // SubjectTeacher row id — needed to swap the assignment
            teacherName: t?.staff ? `${t.staff.firstName} ${t.staff.lastName}` : '',
          };
        });
      });
      setSubjectsByClass(map);
    } catch (err: any) {
      setLoadError(err?.detail || err?.message || 'Failed to load data.');
    } finally {
      setLoadingData(false);
    }
  }, []);

  useEffect(() => { loadEverything(); }, [loadEverything]);
  useEffect(() => { setSectionId(''); }, [activeClassId]);

  const loadSlots = useCallback(async (sid: string) => {
    if (!sid) { setSlots([]); return; }
    const res = await timetableApi.get(sid).catch(() => ({ data: [] }));
    setSlots(res.data || []);
  }, []);
  // Branch-wide slots refresh silently — busy-grey stays correct even when
  // another admin drags a teacher somewhere at the same time.
  const loadAllSlots = useCallback(async () => {
    const res = await timetableApi.getAll().catch(() => ({ data: [] }));
    setAllSlots(res.data || []);
  }, []);
  useEffect(() => { loadSlots(activeSectionId); setSelected(null); }, [activeSectionId, loadSlots]);
  useEffect(() => { loadAllSlots(); }, [loadAllSlots]);

  const cellMap = useMemo(() => {
    const m = new Map<string, any>();
    slots.forEach((s) => {
      const period = PERIOD_TIMES.findIndex((p) => p.start === s.startTime) + 1;
      if (period > 0) m.set(`${s.day}|${period}`, s);
    });
    return m;
  }, [slots]);

  /** One teacher, one place, one time — across the WHOLE branch. */
  const busyTeacherIds = useCallback((day: string, period: number, excludeSlotId?: string) => {
    const pt = PERIOD_TIMES[period - 1];
    return new Set(
      allSlots
        .filter((s) => s.day === day && s.startTime === pt.start && s.id !== excludeSlotId && s.staffId)
        .map((s) => s.staffId),
    );
  }, [allSlots]);

  const placeSubject = async (day: string, period: number, subject: SubjectChip) => {
    setCellError(null);
    const pt = PERIOD_TIMES[period - 1];
    setPending({ day, period });
    try {
      // Place with the subject's default teacher pre-selected; the dropdown
      // opens right after (setSelected below) so the HOD can confirm/change.
      const created = await timetableApi.createSlot({
        sectionId: activeSectionId,
        subjectId: subject.id,
        staffId: subject.teacherId || undefined,
        day,
        startTime: pt.start,
        endTime: pt.end,
      });
      await Promise.all([loadSlots(activeSectionId), loadAllSlots()]);
      const periodOf = PERIOD_TIMES.findIndex((p) => p.start === created.startTime) + 1;
      if (periodOf > 0) setSelected({ day: created.day, period: periodOf });
    } catch (err: any) {
      setPending(null);
      const conflict = err?.status === 409 || /clash/i.test(err?.detail || '');
      setCellError(conflict
        ? `That teacher is already teaching another class at ${DAY_SHORT[day]} P${period} — pick someone free.`
        : `${subject.name} on ${DAY_SHORT[day]} P${period}: ${err?.detail || 'failed'}`);
      await loadSlots(activeSectionId);
    }
  };

  const changeTeacher = async (slotId: string, staffId: string) => {
    setCellError(null);
    const slot = slots.find((s) => s.id === slotId);
    if (!slot) return;
    try {
      // Move = delete + recreate (no PATCH endpoint; the server's clash check
      // runs either way, so a race still lands as a clean 409).
      await timetableApi.deleteSlot(slotId);
      await timetableApi.createSlot({
        sectionId: slot.sectionId, subjectId: slot.subjectId,
        staffId: staffId || undefined, day: slot.day,
        startTime: slot.startTime, endTime: slot.endTime, room: slot.room || undefined,
      });
      await Promise.all([loadSlots(activeSectionId), loadAllSlots()]);
    } catch (err: any) {
      setCellError(err?.detail || 'Failed to change teacher');
      await loadSlots(activeSectionId);
    }
  };

  const removeSlot = async (slotId: string) => {
    setCellError(null);
    try {
      await timetableApi.deleteSlot(slotId);
      await Promise.all([loadSlots(activeSectionId), loadAllSlots()]);
    } catch (err: any) { setCellError(err?.detail || 'Failed to remove'); }
  };

  const generate = async () => {
    setGenerating(true);
    setGenResult(null);
    setShowGen(false);
    startLoading('Solving the whole-school timetable...');
    try {
      const subjectPeriods: Record<string, number> = {};
      Object.values(subjectsByClass).forEach((rows) => rows.forEach((s) => { subjectPeriods[s.id] = 4; }));
      const result = await timetableApi.generate({ periods: MAX_PERIODS, subjectPeriods });
      setGenResult(result);
      setShowGen(true);
      await Promise.all([loadSlots(activeSectionId), loadAllSlots()]);
    } catch (err: any) {
      setCellError(err?.detail || 'Generation failed.');
    } finally {
      setGenerating(false);
      stopLoading();
    }
  };

  const setDefaultTeacher = async (subjectId: string, staffId: string) => {
    setCellError(null);
    try {
      const chips = subjectsByClass[activeClassId] || [];
      const chip = chips.find((s) => s.id === subjectId);
      // Replace the whole assignment: delete the old SubjectTeacher row(s),
      // create the new one. Stale ids (another admin reassigned meanwhile)
      // fail harmlessly — every delete is best-effort.
      if (chip?.assignmentId) await academicApi.removeTeacher(chip.assignmentId).catch(() => undefined);
      if (staffId) await academicApi.assignTeacher({ subjectId, staffId });
      setSubjectsByClass((m) => ({
        ...m,
        [activeClassId]: (m[activeClassId] || []).map((s) =>
          s.id === subjectId
            ? { ...s, teacherId: staffId || null, assignmentId: null, teacherName: staffList.find((t) => t.id === staffId) ? `${staffList.find((t) => t.id === staffId)!.firstName} ${staffList.find((t) => t.id === staffId)!.lastName}` : '' }
            : s,
        ),
      }));
    } catch (err: any) {
      setCellError(err?.detail || 'Failed to assign teacher');
    }
  };

  const onDrop = (day: string, period: number) => (e: React.DragEvent) => {
    e.preventDefault();
    setDraggingName(null);
    const raw = e.dataTransfer.getData('text/plain');
    const subject = subjects.find((s) => s.id === raw) || dragSubject.current;
    if (subject) placeSubject(day, period, subject);
  };

  if (loadingData) {
    return (<><Topbar title="Timetable Builder" subtitle="Drag subjects onto the week" /><div className="flex items-center justify-center p-12"><span className="icon animate-spin text-4xl text-primary">sync</span></div></>);
  }
  if (loadError) {
    return (<><Topbar title="Timetable Builder" subtitle="Drag subjects onto the week" /><div className="card" style={{ margin: 24, padding: 24, color: '#B91C1C' }}>{loadError}</div></>);
  }

  const placed = slots.length;
  const capacity = MAX_PERIODS * DAYS.length;

  return (
    <>
      <Topbar title="Timetable Builder" subtitle="Drag a subject into the week — choose the teacher in the dropdown that opens" />

      {/* Toolbar: class + section on the left, progress + auto-fill on the right */}
      <div className="card" style={{ padding: '12px 18px', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="icon icon-sm" style={{ color: '#5048E5' }}>class</span>
          <select className="input" style={{ width: 'auto', padding: '7px 10px' }} value={activeClassId} onChange={(e) => setActiveClassId(e.target.value)}>
            {classes.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="icon icon-sm" style={{ color: '#10B981' }}>groups</span>
          <select className="input" style={{ width: 'auto', padding: '7px 10px' }} value={activeSectionId} onChange={(e) => setSectionId(e.target.value)}>
            {sections.map((s: any) => <option key={s.id} value={s.id}>Section {s.name}</option>)}
          </select>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 14 }}>
          <span style={{ fontSize: 13, color: 'var(--gray-500)' }}>
            <strong style={{ color: 'var(--gray-800, #1F2937)' }}>{placed}</strong>/{capacity} periods set
          </span>
          <button className="btn btn-secondary btn-sm" disabled={generating} onClick={generate}>
            <span className="icon icon-sm">{generating ? 'progress_activity' : 'auto_awesome'}</span>
            {generating ? 'Solving…' : 'Auto-fill all classes'}
          </button>
        </div>
      </div>

      {cellError && (
        <div style={{ margin: '0 0 12px', padding: '10px 16px', borderRadius: 10, background: '#FEF2F2', color: '#B91C1C', fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="icon icon-sm">error</span>{cellError}
          <button style={{ marginLeft: 'auto', border: 'none', background: 'none', cursor: 'pointer', color: '#B91C1C' }} onClick={() => setCellError(null)}>✕</button>
        </div>
      )}
      {showGen && genResult && (
        <div style={{ margin: '0 0 12px', padding: '10px 16px', borderRadius: 10, background: genResult.status === 'solved' ? '#ECFDF5' : '#FEF2F2', fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="icon icon-sm" style={{ color: genResult.status === 'solved' ? '#059669' : '#B91C1C' }}>{genResult.status === 'solved' ? 'check_circle' : 'error' }</span>
          {genResult.status === 'solved'
            ? <span>Whole-school timetable solved — <strong>{genResult.persisted}</strong> slots written in {genResult.stats?.elapsedMs ?? 0} ms. Every class is clash-free: max {MAX_PERIODS} lectures/day, lunch after {LUNCH_AFTER}.</span>
            : <span>The solver could not fit every class — usually a teacher-load issue (more sections than teacher hours). Add staff or reduce subjects per class.</span>}
          <button style={{ marginLeft: 'auto', border: 'none', background: 'none', cursor: 'pointer' }} onClick={() => setShowGen(false)}>✕</button>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '250px minmax(0, 1fr)', gap: 16, alignItems: 'start' }}>
        {/* ── Subject palette ── */}
        <div className="card" style={{ padding: 0, overflow: 'hidden', position: 'sticky', top: 16 }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border, #E5E7EB)', fontWeight: 700, fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="icon icon-sm" style={{ color: '#5048E5' }}>palette</span> Subjects — {activeClass?.name}
          </div>
          {subjects.length === 0 ? (
            <p style={{ padding: 20, fontSize: 13, color: 'var(--gray-500)' }}>No subjects yet — add them on the Academics page.</p>
          ) : (
            <div style={{ padding: 10, display: 'grid', gap: 8, maxHeight: 'calc(100vh - 220px)', overflowY: 'auto' }}>
              {subjects.map((s) => {
                const color = colorFor(s.name);
                return (
                  <div key={s.id} draggable
                    onDragStart={(e) => { dragSubject.current = s; setDraggingName(s.name); e.dataTransfer.setData('text/plain', s.id); e.dataTransfer.effectAllowed = 'copy'; }}
                    onDragEnd={() => { setDraggingName(null); dragSubject.current = null; }}
                    style={{
                      padding: '9px 12px', borderRadius: 10, cursor: 'grab', userSelect: 'none',
                      background: color + '10', border: `1px solid ${color}35`, borderLeft: `4px solid ${color}`,
                      opacity: draggingName === s.name ? 0.5 : 1,
                    }}>
                    <div style={{ fontWeight: 700, fontSize: 13, color }}>{s.name}</div>
                    {/* Default teacher lives ON the chip — set once, then every
                        drop of this subject comes pre-assigned. */}
                    <select
                      className="input"
                      title="Default teacher for this subject"
                      style={{ marginTop: 5, padding: '3px 6px', fontSize: 11, width: '100%' }}
                      value={s.teacherId || ''}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => { e.stopPropagation(); setDefaultTeacher(s.id, e.target.value); }}
                    >
                      <option value="">— pick default teacher —</option>
                      {staffList.map((t: any) => <option key={t.id} value={t.id}>{t.firstName} {t.lastName}</option>)}
                    </select>
                  </div>
                );
              })}
            </div>
          )}
          <div style={{ padding: '10px 16px', borderTop: '1px solid var(--border, #E5E7EB)', fontSize: 11, color: 'var(--gray-400)' }}>
            Drag a chip onto the grid →
          </div>
        </div>

        {/* ── The week grid ── */}
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'separate', borderSpacing: 5, width: '100%', minWidth: 780, padding: 10 }}>
            <thead>
              <tr>
                <th style={{ ...cellHead, width: 92 }}></th>
                {COLUMNS.map((col, i) => (
                  col.period === null ? (
                    <th key="lunch" style={{ padding: 0, width: 34 }}>
                      <div style={{
                        height: '100%', minHeight: 46, borderRadius: 8,
                        background: 'linear-gradient(180deg,#FFF7ED,#FFEDD5)',
                        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2,
                      }}>
                        <span className="icon" style={{ fontSize: 16, color: '#C2410C' }}>restaurant</span>
                        <span style={{ fontSize: 9.5, fontWeight: 800, color: '#C2410C', letterSpacing: 1, writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}>LUNCH</span>
                      </div>
                    </th>
                  ) : (
                    <th key={i} style={cellHead}>
                      <div style={{ fontWeight: 800, fontSize: 13 }}>P{col.period}</div>
                      <div style={{ fontSize: 10, fontWeight: 500, color: 'var(--gray-400)' }}>{PERIOD_TIMES[col.period - 1].start}</div>
                    </th>
                  )
                ))}
              </tr>
            </thead>
            <tbody>
              {DAYS.map((day) => (
                <tr key={day}>
                  <td style={dayCell}>{DAY_SHORT[day]}</td>
                  {COLUMNS.map((col, ci) => (
                    col.period === null ? (
                      <td key={`lunch-${ci}`} style={{ padding: 0 }}>
                        <div style={{
                          height: '100%', minHeight: 58, borderRadius: 8,
                          background: 'repeating-linear-gradient(45deg,#FFFBEB,#FFFBEB 4px,#FEF3C7 4px,#FEF3C7 8px)',
                          border: '1px dashed #FCD34D',
                        }} />
                      </td>
                    ) : (
                      (() => {
                        const period = col.period as number;
                        const cell = cellMap.get(`${day}|${period}`);
                        const isSel = selected?.day === day && selected?.period === period;
                        const color = cell?.subject?.name ? colorFor(cell.subject.name) : '#5048E5';
                        return (
                          <td key={period}
                            onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
                            onDrop={onDrop(day, period)}
                            onClick={() => cell && setSelected(isSel ? null : { day, period })}
                            style={{
                              height: 58, borderRadius: 10, verticalAlign: 'top', position: 'relative',
                              cursor: cell ? 'pointer' : 'copy',
                              background: cell ? color + '14' : 'var(--gray-50, #F9FAFB)',
                              border: isSel ? `2px solid ${color}` : `1.5px dashed ${cell ? 'transparent' : 'var(--gray-200, #E5E7EB)'}`,
                              padding: cell ? '6px 8px' : 0,
                            }}>
                            {cell ? (
                              <>
                                <div style={{ fontWeight: 700, fontSize: 12, color, lineHeight: 1.2 }}>{cell.subject?.name}</div>
                                <div style={{ fontSize: 10.5, color: 'var(--gray-500)', marginTop: 2 }}>
                                  {cell.staff ? `${cell.staff.firstName} ${cell.staff.lastName}` : 'tap to set teacher'}
                                </div>
                                {isSel && (
                                  <div onClick={(e) => e.stopPropagation()} style={{ marginTop: 6, display: 'grid', gap: 4 }}>
                                    <select
                                      className="input" autoFocus
                                      style={{ padding: '3px 6px', fontSize: 11 }}
                                      value={cell.staffId || ''}
                                      onChange={(e) => changeTeacher(cell.id, e.target.value)}>
                                      <option value="">— no teacher —</option>
                                      {staffList.map((t: any) => {
                                        // Grey out anyone teaching ANY class at this
                                        // (day, period) — the one-place rule, live.
                                        const busy = busyTeacherIds(day, period, cell.id).has(t.id);
                                        return <option key={t.id} value={t.id} disabled={busy}>{t.firstName} {t.lastName}{busy ? ' (busy)' : ''}</option>;
                                      })}
                                    </select>
                                    <button onClick={() => removeSlot(cell.id)}
                                      style={{ border: 'none', background: '#FEF2F2', color: '#B91C1C', fontSize: 11, fontWeight: 600, borderRadius: 6, padding: '3px 0', cursor: 'pointer' }}>
                                      Remove
                                    </button>
                                  </div>
                                )}
                              </>
                            ) : (
                              pending?.day === day && pending?.period === period
                                ? <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#5048E5' }}><span className="icon animate-spin">progress_activity</span></span>
                                : <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--gray-300, #D1D5DB)', fontSize: 18, fontWeight: 300 }}>+</span>
                            )}
                          </td>
                        );
                      })()
                    )
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div style={{ margin: '14px 4px', fontSize: 12, color: 'var(--gray-400)', display: 'flex', gap: 18, flexWrap: 'wrap' }}>
        <span><strong>Drag</strong> a subject chip into any empty cell</span>
        <span><strong>Dropdown opens</strong> — pick the teacher; busy ones are greyed out</span>
        <span><strong>Click</strong> a placed card to change its teacher or remove it</span>
        <span>Set a subject's usual teacher on the chip — every drop comes pre-filled</span>
        <span>Max {MAX_PERIODS} lectures/day · lunch after {LUNCH_AFTER}</span>
      </div>
    </>
  );
}

const cellHead: React.CSSProperties = { padding: '6px 4px', textAlign: 'center', color: 'var(--gray-500)' };
const dayCell: React.CSSProperties = { fontWeight: 700, fontSize: 13, color: 'var(--gray-600, #4B5563)', whiteSpace: 'nowrap', paddingRight: 10 };
