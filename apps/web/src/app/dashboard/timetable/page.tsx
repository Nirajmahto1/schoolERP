'use client';
import Topbar from '@/components/Topbar';
import { useState, useEffect, useCallback, useMemo } from 'react';
import { timetableApi, studentApi, teacherApi, academicApi, staffApi } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import { useLoading } from '@/context/LoadingContext';

const DAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'] as const;
const subjectColors: Record<string, string> = { Mathematics: '#5048E5', Science: '#10B981', English: 'school3B82F6', Hindi: '#F59E0B', SST: '#EC4899', 'Physical Ed.': '#8B5CF6', Art: '#F97316', Computer: '#0EA5E9', Library: '#6366F1', 'Science Lab': '#059669' };

type Slot = {
  id: string;
  day: string;
  startTime: string;
  endTime: string;
  room: string | null;
  subject: { name: string; code: string } | null;
  staff: { firstName: string; lastName: string; employeeId: string } | null;
};

export default function TimetablePage() {
  const { user } = useAuth();
  const { startLoading, stopLoading } = useLoading();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [grid, setGrid] = useState<any[]>([]);
  const [className, setClassName] = useState('');
  const [classes, setClasses] = useState<any[]>([]);
  const [sections, setSections] = useState<any[]>([]);
  const [subjects, setSubjects] = useState<any[]>([]);
  const [staffList, setStaffList] = useState<any[]>([]);
  const [sectionId, setSectionId] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ subjectId: '', staffId: '', day: 'MONDAY', startTime: '09:00', endTime: '09:45', room: '' });

  const isAdmin = (user?.roles || []).some(r => ['SUPER_ADMIN', 'BRANCH_ADMIN', 'ACADEMIC_COORDINATOR'].includes(r));

  const loadSlots = useCallback(async (sid: string) => {
    if (!sid) { setSlots([]); setGrid([]); return; }
    const res = await timetableApi.get(sid);
    setSlots(res.data || []);
  }, []);

  // Admin: class → section → slots. Student/teacher: server-derived self view.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        if (!isAdmin) {
          const data = user?.role === 'TEACHER' ? await teacherApi.getMyTimetable() : await studentApi.getMyTimetable();
          if (cancelled) return;
          setClassName(data.className || '');
          setGrid(data.timetable || []);
          return;
        }
        const cls = await academicApi.getClasses();
        const classList = cls.data || [];
        if (cancelled) return;
        setClasses(classList);
        const firstClass = classList[0];
        if (firstClass) {
          const secs = await academicApi.getSections(firstClass.id);
          if (cancelled) return;
          setSections(secs.data || []);
          setSectionId(secs.data?.[0]?.id || '');
        }
      } catch (err: any) {
        if (!cancelled) setError(err?.detail || err?.message || 'Failed to load timetable.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [user, isAdmin]);

  // Load subjects + staff for the add form when the class changes; load slots
  // whenever the section changes.
  useEffect(() => {
    if (!isAdmin || !sectionId) return;
    (async () => {
      try {
        await loadSlots(sectionId);
        const cls = classes.find(c => c.sections?.some((s: any) => s.id === sectionId)) || classes[0];
        if (cls) {
          const subs = await academicApi.getSubjects(cls.id);
          setSubjects(subs.data || []);
        }
        if (staffList.length === 0) {
          const st = await staffApi.list();
          setStaffList(st.data || []);
        }
      } catch (err: any) {
        setError(err?.detail || err?.message || 'Failed to load timetable data.');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sectionId, isAdmin]);

  const addSlot = async () => {
    if (!sectionId || !form.subjectId) { alert('Pick a section and a subject first.'); return; }
    startLoading('Creating slot...');
    try {
      await timetableApi.createSlot({ sectionId, ...form, room: form.room || undefined });
      setShowAdd(false);
      setForm({ subjectId: '', staffId: '', day: 'MONDAY', startTime: '09:00', endTime: '09:45', room: '' });
      await loadSlots(sectionId);
    } catch (err: any) { alert(err?.detail || 'Failed to create slot'); }
    stopLoading();
  };

  const removeSlot = async (id: string) => {
    startLoading('Deleting slot...');
    try { await timetableApi.deleteSlot(id); await loadSlots(sectionId); }
    catch (err: any) { alert(err?.detail || 'Failed to delete slot'); }
    stopLoading();
  };

  const cellRender = (s: any) => {
    if (!s) return <span className="text-sm text-gray" style={{ opacity: 0.5 }}>-</span>;
    if (s === 'Break' || s === 'Lunch') return <span className="text-sm text-gray" style={{ fontStyle: 'italic' }}>{s}</span>;
    const name = typeof s === 'string' ? s : s.subject?.name || '-';
    const teacher = typeof s === 'object' && s.staff ? `${s.staff.firstName} ${s.staff.lastName}` : '';
    const room = typeof s === 'object' && s.room ? ` · ${s.room}` : '';
    const color = subjectColors[name] || '#5048E5';
    return (
      <div style={{ padding: '6px 10px', borderRadius: 8, background: color + '10', borderLeft: `3px solid ${color}` }}>
        <span style={{ fontSize: '0.8125rem', fontWeight: 600, color }}>{name}</span>
        {(teacher || room) && <div style={{ fontSize: '0.6875rem', color: 'var(--gray-500)', marginTop: 2 }}>{teacher}{room}</div>}
      </div>
    );
  };

  const gridRows = useMemo(() => {
    const byTime: Record<string, any> = {};
    slots.forEach(s => {
      const key = `${s.startTime} - ${s.endTime}`;
      if (!byTime[key]) byTime[key] = { time: key, MONDAY: null, TUESDAY: null, WEDNESDAY: null, THURSDAY: null, FRIDAY: null };
      byTime[key][s.day] = s;
    });
    return Object.values(byTime);
  }, [slots]);

  if (loading) return <div className="p-12 text-center text-primary animate-pulse">Loading schedule...</div>;
  if (error) return <><Topbar title="Timetable" subtitle="Weekly class schedule" /><div style={{ padding: 24 }}><div className="card" style={{ padding: 24, background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 12, color: '#B91C1C' }}>{error}</div></div></>;

  return (
    <>
      <Topbar title="Timetable" subtitle="Weekly class schedule" />
      <div style={{ padding: '24px 32px' }}>
        <div className="flex items-center justify-between mb-4">
          <div className="flex gap-3">
            {isAdmin ? (
              <>
                <select className="select" style={{ width: 150 }} onChange={async e => {
                  const cid = e.target.value;
                  const secs = await academicApi.getSections(cid);
                  setSections(secs.data || []);
                  setSectionId(secs.data?.[0]?.id || '');
                }}>
                  {classes.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                <select className="select" style={{ width: 150 }} value={sectionId} onChange={e => setSectionId(e.target.value)}>
                  {sections.map(s => <option key={s.id} value={s.id}>Section {s.name}</option>)}
                </select>
              </>
            ) : (
              <select className="select" style={{ width: 130 }}><option>{className || 'My Schedule'}</option></select>
            )}
          </div>
          <div className="flex gap-3">
            {isAdmin && <button className="btn btn-primary" onClick={() => setShowAdd(!showAdd)}><span className="icon icon-sm">{showAdd ? 'close' : 'add'}</span>{showAdd ? 'Cancel' : 'Add Slot'}</button>}
            <button className="btn btn-secondary"><span className="icon icon-sm">print</span>Print</button>
          </div>
        </div>

        {isAdmin && showAdd && (
          <div className="card mb-4 animate-fadeIn"><div className="card-body">
            <h3 className="mb-4">Add Timetable Slot</h3>
            <div className="grid grid-3 gap-4">
              <div className="input-group"><label className="input-label">Subject *</label>
                <select className="select" value={form.subjectId} onChange={e => setForm({ ...form, subjectId: e.target.value })}>
                  <option value="">Select subject</option>
                  {subjects.map(s => <option key={s.id} value={s.id}>{s.name}{s.class?.name ? ` (${s.class.name})` : ''}</option>)}
                </select>
              </div>
              <div className="input-group"><label className="input-label">Teacher</label>
                <select className="select" value={form.staffId} onChange={e => setForm({ ...form, staffId: e.target.value })}>
                  <option value="">Unassigned</option>
                  {staffList.map(s => <option key={s.id} value={s.id}>{s.firstName} {s.lastName}{s.employeeId ? ` (${s.employeeId})` : ''}</option>)}
                </select>
              </div>
              <div className="input-group"><label className="input-label">Room</label><input className="input" value={form.room} onChange={e => setForm({ ...form, room: e.target.value })} placeholder="R-101" /></div>
              <div className="input-group"><label className="input-label">Day *</label>
                <select className="select" value={form.day} onChange={e => setForm({ ...form, day: e.target.value })}>
                  {DAYS.map(d => <option key={d} value={d}>{d.charAt(0) + d.slice(1).toLowerCase()}</option>)}
                </select>
              </div>
              <div className="input-group"><label className="input-label">Start *</label><input className="input" type="time" value={form.startTime} onChange={e => setForm({ ...form, startTime: e.target.value })} /></div>
              <div className="input-group"><label className="input-label">End *</label><input className="input" type="time" value={form.endTime} onChange={e => setForm({ ...form, endTime: e.target.value })} /></div>
            </div>
            <div className="flex gap-3 mt-4"><button className="btn btn-primary" onClick={addSlot}><span className="icon icon-sm">check</span>Create Slot</button><button className="btn btn-secondary" onClick={() => setShowAdd(false)}>Cancel</button></div>
          </div></div>
        )}

        <div className="card">
          <div className="table-wrapper">
            <table className="table">
              <thead><tr><th>Time</th>{DAYS.map(d => <th key={d}>{d.charAt(0) + d.slice(1).toLowerCase()}</th>)}</tr></thead>
              <tbody>
                {(isAdmin ? gridRows : grid).length === 0 ? (
                  <tr><td colSpan={6} className="text-center py-6 text-gray">No schedule found{isAdmin ? ' — add slots to get started' : ''}</td></tr>
                ) : (isAdmin ? gridRows : grid).map((row: any, i: number) => (
                  <tr key={i}>
                    <td><span className="badge badge-gray" style={{ minWidth: 110, justifyContent: 'center' }}>{row.time}</span></td>
                    {DAYS.map(d => {
                      const cell = row[d];
                      const del = isAdmin && cell?.id;
                      return (
                        <td key={d}>
                          <div style={{ position: 'relative' }}>
                            {cellRender(cell)}
                            {del && <button title="Delete slot" onClick={() => removeSlot(cell.id)} style={{ position: 'absolute', top: 2, right: 2, background: 'none', border: 'none', cursor: 'pointer', color: '#EF4444', fontSize: 12 }}><span className="icon icon-sm">delete</span></button>}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}
