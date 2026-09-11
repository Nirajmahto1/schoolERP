'use client';
import Topbar from '@/components/Topbar';
import { useState, useEffect, useCallback } from 'react';
import { attendanceApi, academicApi, studentApi } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import { useLoading } from '@/context/LoadingContext';

type AttStatus = 'PRESENT' | 'ABSENT' | 'LATE' | '';

interface StudentRow {
  id: string;
  name: string;
  rollNo: string;
  studentId: string;
}

export default function AttendancePage() {
  const { user } = useAuth();
  const { startLoading, stopLoading } = useLoading();
  const [date, setDate] = useState(new Date().toISOString().split('T')[0]);

  // Class/Section data from DB
  const [classes, setClasses] = useState<any[]>([]);
  const [selectedClassId, setSelectedClassId] = useState('');
  const [selectedSectionId, setSelectedSectionId] = useState('');
  const [sections, setSections] = useState<any[]>([]);

  const [studentRows, setStudentRows] = useState<StudentRow[]>([]);
  const [attendance, setAttendance] = useState<Record<string, AttStatus>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [saved, setSaved] = useState(false);
  const [showNotif, setShowNotif] = useState(false);

  // Load classes on mount
  useEffect(() => {
    (async () => {
      try {
        const res = await academicApi.getClasses();
        setClasses(res.data || []);
        if (res.data?.length > 0) {
          setSelectedClassId(res.data[0].id);
          setSections(res.data[0].sections || []);
          if (res.data[0].sections?.length > 0) {
            setSelectedSectionId(res.data[0].sections[0].id);
          }
        }
      } catch { /* classes will load as empty */ }
    })();
  }, []);

  // When class changes, update sections
  useEffect(() => {
    const cls = classes.find(c => c.id === selectedClassId);
    if (cls) {
      setSections(cls.sections || []);
      if (cls.sections?.length > 0) {
        setSelectedSectionId(cls.sections[0].id);
      } else {
        setSelectedSectionId('');
      }
    }
  }, [selectedClassId, classes]);

  const loadData = useCallback(async () => {
    if (!selectedClassId) return;
    setLoading(true);
    setError(null);
    setSaved(false);
    try {
      // Get students for the selected class + section
      const studRes = await studentApi.list({
        classId: selectedClassId,
        sectionId: selectedSectionId || undefined,
        limit: 200,
      });

      const rows: StudentRow[] = (studRes.data || []).map((s: any) => ({
        id: s.id,
        name: `${s.firstName} ${s.lastName}`,
        rollNo: s.rollNo || s.admissionNo || '—',
        studentId: s.id,
      }));
      setStudentRows(rows);

      // Get existing attendance for this date/class/section
      let attRes;
      try {
        attRes = await attendanceApi.getDaily({
          date,
          classId: selectedClassId,
          sectionId: selectedSectionId || undefined,
        });
      } catch {
        attRes = { data: [], summary: {} };
      }

      // Build attendance map: start with blanks, overlay existing
      const existing: Record<string, AttStatus> = {};
      rows.forEach(r => { existing[r.id] = ''; });
      (attRes.data || []).forEach((a: any) => {
        if (a.studentId && existing.hasOwnProperty(a.studentId)) {
          existing[a.studentId] = a.status as AttStatus;
        }
      });
      setAttendance(existing);

    } catch (err: any) {
      setError(err?.detail || err?.message || 'Failed to load students. Ensure backend services are running.');
      setStudentRows([]);
      setAttendance({});
    }
    setLoading(false);
  }, [date, selectedClassId, selectedSectionId]);

  useEffect(() => { loadData(); }, [loadData]);

  const setStatus = (studentId: string, status: AttStatus) => {
    setAttendance(prev => ({ ...prev, [studentId]: status }));
    setSaved(false);
  };

  const markAll = (status: AttStatus) => {
    setAttendance(Object.fromEntries(studentRows.map(s => [s.id, status])));
    setSaved(false);
  };

  const saveAttendance = async () => {
    setProcessing(true);
    startLoading('Saving attendance...');
    const absentees = Object.values(attendance).filter(v => v === 'ABSENT').length;

    try {
      const records = Object.entries(attendance)
        .filter(([, status]) => status !== '')
        .map(([studentId, status]) => ({ studentId, status }));

      await attendanceApi.mark({
        date,
        classId: selectedClassId,
        sectionId: selectedSectionId,
        records,
        markedBy: user?.id,
      });
      setSaved(true);
      if (absentees > 0) setShowNotif(true);
    } catch (err: any) {
      alert(err.detail || 'Failed to save attendance');
    }
    setProcessing(false);
    stopLoading();
    if (absentees > 0) {
      setTimeout(() => setShowNotif(false), 5000);
    }
  };

  const present = Object.values(attendance).filter(v => v === 'PRESENT').length;
  const absent = Object.values(attendance).filter(v => v === 'ABSENT').length;
  const late = Object.values(attendance).filter(v => v === 'LATE').length;
  const unmarked = Object.values(attendance).filter(v => v === '').length;

  const selectedClassName = classes.find(c => c.id === selectedClassId)?.name || '';
  const selectedSectionName = sections.find(s => s.id === selectedSectionId)?.name || '';

  return (
    <>
      <Topbar title="Attendance Tracking" subtitle="Daily student attendance management" />
      <div style={{ padding: '24px 32px', position: 'relative' }}>
        {showNotif && (
          <div className="animate-slideUp" style={{ position: 'fixed', bottom: 32, right: 32, zIndex: 100, background: '#1A1C2E', color: 'white', padding: '16px 24px', borderRadius: 12, boxShadow: '0 20px 25px -5px rgba(0,0,0,0.1)', display: 'flex', alignItems: 'center', gap: 12, border: '1px solid rgba(255,255,255,0.1)' }}>
            <div style={{ background: '#10B981', borderRadius: '50%', padding: 4, display: 'flex' }}><span className="icon" style={{ fontSize: 18 }}>notifications_active</span></div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 14 }}>Attendance Saved</div>
              <div style={{ fontSize: 12, opacity: 0.8 }}>{absent > 0 ? `${absent} absent — consider notifying parents.` : 'All records updated.'}</div>
            </div>
            <button onClick={() => setShowNotif(false)} style={{ background: 'transparent', border: 'none', color: 'white', cursor: 'pointer', marginLeft: 8 }}><span className="icon">close</span></button>
          </div>
        )}

        {/* Filter Bar */}
        <div className="flex gap-3 mb-6 items-center" style={{ flexWrap: 'wrap' }}>
          <div className="input-group" style={{ margin: 0 }}>
            <label className="input-label" style={{ marginBottom: 2, fontSize: 11 }}>Date</label>
            <input className="input" type="date" value={date} onChange={e => { setDate(e.target.value); setSaved(false); }} style={{ width: 165 }} />
          </div>
          <div className="input-group" style={{ margin: 0 }}>
            <label className="input-label" style={{ marginBottom: 2, fontSize: 11 }}>Class</label>
            <select className="select" style={{ width: 150 }} value={selectedClassId} onChange={e => setSelectedClassId(e.target.value)}>
              {classes.length === 0 && <option value="">No classes</option>}
              {classes.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          {sections.length > 0 && (
            <div className="input-group" style={{ margin: 0 }}>
              <label className="input-label" style={{ marginBottom: 2, fontSize: 11 }}>Section</label>
              <select className="select" style={{ width: 120 }} value={selectedSectionId} onChange={e => setSelectedSectionId(e.target.value)}>
                <option value="">All Sections</option>
                {sections.map((s: any) => <option key={s.id} value={s.id}>Section {s.name}</option>)}
              </select>
            </div>
          )}
          <div style={{ flex: 1 }}></div>
          <button className="btn btn-sm btn-success" onClick={() => markAll('PRESENT')}><span className="icon icon-sm">done_all</span>All Present</button>
          <button className="btn btn-sm btn-danger" onClick={() => markAll('ABSENT')}><span className="icon icon-sm">close</span>All Absent</button>
          <button className="btn btn-sm btn-secondary" onClick={() => markAll('')}><span className="icon icon-sm">restart_alt</span>Reset</button>
        </div>

        {/* Stats */}
        <div className="grid grid-4 gap-4 mb-6">
          {[{ l: 'Present', v: String(present), c: '#10B981', icon: 'check_circle' }, { l: 'Absent', v: String(absent), c: '#EF4444', icon: 'cancel' }, { l: 'Late', v: String(late), c: '#F59E0B', icon: 'schedule' }, { l: 'Unmarked', v: String(unmarked), c: '#94A3B8', icon: 'help' }].map(s => (
            <div key={s.l} className="stat-card" style={{ borderLeftColor: s.c }}><div className="stat-icon" style={{ background: s.c + '15', color: s.c }}><span className="icon">{s.icon}</span></div><div><div className="stat-value">{s.v}</div><div className="stat-label">{s.l}</div></div></div>
          ))}
        </div>

        {error && (
          <div className="card mb-4" style={{ padding: 24, background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 12 }}>
            <div className="flex items-center gap-3">
              <span className="icon" style={{ color: '#EF4444' }}>error</span>
              <div><div style={{ fontWeight: 600, color: '#991B1B' }}>Connection Error</div><div style={{ fontSize: 14, color: '#B91C1C' }}>{error}</div></div>
              <button className="btn btn-sm btn-secondary" style={{ marginLeft: 'auto' }} onClick={loadData}><span className="icon icon-sm">refresh</span>Retry</button>
            </div>
          </div>
        )}

        {loading ? (
          <div className="card" style={{ padding: 48, textAlign: 'center' }}>
            <span className="icon" style={{ fontSize: 32, color: '#5048E5', animation: 'spin 1s linear infinite' }}>progress_activity</span>
            <p style={{ marginTop: 12, color: '#6B7280' }}>Loading students for {selectedClassName} {selectedSectionName ? `(Sec ${selectedSectionName})` : ''}...</p>
          </div>
        ) : !error && (
          <div className="card">
            <div style={{ padding: '16px 24px', borderBottom: '1px solid #F3F4F6', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div className="flex items-center gap-3">
                <span className="icon" style={{ color: '#5048E5' }}>school</span>
                <h3 className="font-bold m-0">{selectedClassName}{selectedSectionName ? ` — Section ${selectedSectionName}` : ''}</h3>
                <span className="badge badge-primary">{studentRows.length} students</span>
              </div>
              <span className="text-sm text-gray">{new Date(date).toLocaleDateString('en-IN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</span>
            </div>
            <div className="table-wrapper"><table className="table" style={{ margin: 0 }}><thead><tr>
              <th style={{ paddingLeft: 24, width: 50 }}>#</th><th>Student</th><th style={{ width: 120 }}>Roll / Adm No</th><th style={{ textAlign: 'center' }}>Status</th>
            </tr></thead><tbody>
              {studentRows.map((s, i) => {
                const status = attendance[s.id] || '';
                return (
                  <tr key={s.id}>
                    <td style={{ paddingLeft: 24 }}>{i + 1}</td>
                    <td><div className="flex items-center gap-3"><div className="avatar avatar-sm">{s.name.split(' ').map(n => n[0]).join('')}</div><span className="font-semibold">{s.name}</span></div></td>
                    <td className="text-sm text-gray">{s.rollNo}</td>
                    <td><div className="flex gap-2" style={{ justifyContent: 'center' }}>
                      {([['PRESENT', 'Present', '#10B981'], ['ABSENT', 'Absent', '#EF4444'], ['LATE', 'Late', '#F59E0B']] as const).map(([val, label, color]) => (
                        <button key={val} onClick={() => setStatus(s.id, val)}
                          style={{ padding: '6px 16px', borderRadius: 6, border: `2px solid ${status === val ? color : 'var(--gray-200)'}`, background: status === val ? color + '15' : 'transparent', color: status === val ? color : 'var(--gray-400)', fontWeight: 600, fontSize: '0.8125rem', cursor: 'pointer', transition: 'all 0.15s', fontFamily: 'inherit' }}>
                          {label}
                        </button>
                      ))}
                    </div></td>
                  </tr>
                );
              })}
              {studentRows.length === 0 && (
                <tr><td colSpan={4} style={{ textAlign: 'center', padding: 32, color: '#9CA3AF' }}>
                  <span className="icon" style={{ fontSize: 28, display: 'block', marginBottom: 8 }}>group_off</span>
                  No students found in {selectedClassName}{selectedSectionName ? ` Section ${selectedSectionName}` : ''}. Ensure students are enrolled in this class.
                </td></tr>
              )}
            </tbody></table></div>
            <div style={{ padding: '16px 24px', borderTop: '1px solid #F3F4F6', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="text-sm text-gray">{selectedClassName}{selectedSectionName ? ` (${selectedSectionName})` : ''} • {date} • {studentRows.length} students</span>
              <div className="flex gap-3 items-center">
                {saved && <span className="badge badge-success"><span className="icon icon-sm">check</span> Saved!</span>}
                <button className="btn btn-primary" onClick={saveAttendance} disabled={studentRows.length === 0 || unmarked > 0 || processing}>
                  <span className="icon icon-sm">{processing ? 'hourglass_empty' : 'save'}</span>
                  {processing ? 'Saving...' : `Save Attendance${unmarked > 0 ? ` (${unmarked} unmarked)` : ''}`}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
