'use client';
import Topbar from '@/components/Topbar';
import { useState, useEffect } from 'react';
import { teacherApi } from '@/lib/api';

function getGrade(marks: number, max: number) {
  const p = (marks / max) * 100;
  if (p >= 90) return 'A+'; if (p >= 80) return 'A'; if (p >= 70) return 'B+'; if (p >= 60) return 'B'; if (p >= 50) return 'C'; return 'F';
}

export default function EnterMarksPage() {
  const [cls, setCls] = useState('10-A');
  const [exam, setExam] = useState('Mid-Term Exam 2025');
  const [maxMarks, setMaxMarks] = useState(100);
  const [students, setStudents] = useState<any[]>([]);
  const [marks, setMarks] = useState<Record<string, number>>({});
  const [saved, setSaved] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadData = async () => {
      setLoading(true);
      try {
        const [cName, sName] = cls.split('-');
        const studRes = await teacherApi.getStudents(cName, sName);
        setStudents(studRes.data);
        
        let marksRes = { data: [] as any[] };
        try { marksRes = await teacherApi.getMarks(cName, sName); } catch {}
        
        const existing: Record<string, number> = {};
        studRes.data.forEach((s: any) => existing[s.id] = 0);
        marksRes.data.forEach((m: any) => { if (m.studentId) existing[m.studentId] = Number(m.marksObtained); });
        setMarks(existing);
      } catch (err) { console.error('Failed to wire up grades', err); }
      setLoading(false);
    };
    loadData();
  }, [cls, exam]);

  const updateMark = (studentId: string, value: number) => {
    setMarks({ ...marks, [studentId]: Math.min(Math.max(0, value), maxMarks) });
    setSaved(false);
    setSubmitted(false);
  };

  const saveGrades = async (final: boolean) => {
    try {
      const records = Object.entries(marks).map(([studentId, marksObtained]) => ({ studentId, marksObtained }));
      const [cName, sName] = cls.split('-');
      await teacherApi.submitMarks({
        marks: records,
        className: cName,
        sectionName: sName,
        subjectName: 'Mathematics',
      });
      setSaved(true);
      if (final) setSubmitted(true);
    } catch { alert('Failed to save grades'); }
  };

  const values = Object.values(marks);
  const sum = values.reduce((a, b) => a + b, 0);
  const avg = students.length ? Math.round(sum / students.length) : 0;
  const highest = values.length ? Math.max(...values) : 0;
  const lowest = values.length ? Math.min(...values) : 0;
  const passRate = students.length ? Math.round(values.filter(m => (m / maxMarks) * 100 >= 33).length / students.length * 100) : 0;

  return (
    <>
      <Topbar title="Enter Marks" subtitle="Submit examination marks for your classes" />
      <div style={{ padding: '24px 32px' }}>
        <div className="flex gap-3 mb-6" style={{ flexWrap: 'wrap' }}>
          <select className="select" style={{ width: 190 }} value={exam} onChange={e => { setExam(e.target.value); setSaved(false); setSubmitted(false); }}><option>Mid-Term Exam 2025</option><option>First Term Exam 2025</option><option>Unit Test 2</option></select>
          <select className="select" style={{ width: 120 }} value={cls} onChange={e => setCls(e.target.value)}><option>10-A</option><option>10-B</option><option>9-A</option></select>
          <select className="select" style={{ width: 150 }}><option>Mathematics</option></select>
          <div className="input-group" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><label className="input-label" style={{ margin: 0 }}>Max:</label><input className="input" type="number" style={{ width: 80 }} value={maxMarks} onChange={e => setMaxMarks(Number(e.target.value))} /></div>
        </div>

        <div className="grid grid-4 gap-4 mb-6">
          {[{ l: 'Class Average', v: `${avg}/${maxMarks}`, c: '#5048E5' }, { l: 'Highest', v: String(highest), c: '#10B981' }, { l: 'Lowest', v: String(lowest), c: '#EF4444' }, { l: 'Pass Rate', v: `${passRate}%`, c: '#F59E0B' }].map(s => (
            <div key={s.l} className="stat-card" style={{ borderLeftColor: s.c }}><div className="stat-icon" style={{ background: s.c + '15', color: s.c }}><span className="icon">grading</span></div><div><div className="stat-value">{s.v}</div><div className="stat-label">{s.l}</div></div></div>
          ))}
        </div>

        {loading ? (
          <div className="card" style={{ padding: 48, textAlign: 'center' }}><span className="icon" style={{ fontSize: 32, color: '#5048E5', animation: 'spin 1s linear infinite' }}>progress_activity</span><p style={{ marginTop: 12, color: '#6B7280' }}>Loading student grades...</p></div>
        ) : (
          <div className="card">
            <div className="card-body"><div className="flex items-center justify-between"><h3>{exam} — Class {cls} — Mathematics (Max: {maxMarks})</h3><span className={`badge ${submitted ? 'badge-success' : saved ? 'badge-info' : 'badge-warning'}`}>{submitted ? 'Submitted' : saved ? 'Saved' : 'Draft'}</span></div></div>
            <div className="table-wrapper"><table className="table"><thead><tr><th>#</th><th>Student</th><th>Roll No</th><th>Marks ({maxMarks})</th><th>%</th><th>Grade</th><th>Remarks</th></tr></thead><tbody>
              {students.map((s, i) => {
                const m = marks[s.id] || 0;
                const pct = Math.round((m / maxMarks) * 100);
                const grade = getGrade(m, maxMarks);
                return (
                  <tr key={s.id}><td>{i + 1}</td>
                    <td><div className="flex items-center gap-3"><div className="avatar avatar-sm">{s.firstName[0]}</div><span className="font-semibold">{s.firstName} {s.lastName}</span></div></td>
                    <td className="text-sm text-gray">{s.rollNo || s.admissionNo}</td>
                    <td><input className="input" type="number" min={0} max={maxMarks} value={m} onChange={e => updateMark(s.id, Number(e.target.value))} style={{ width: 80 }} disabled={submitted} /></td>
                    <td className="font-semibold">{pct}%</td>
                    <td><span className={`badge ${pct >= 80 ? 'badge-success' : pct >= 60 ? 'badge-info' : pct >= 33 ? 'badge-warning' : 'badge-danger'}`}>{grade}</span></td>
                    <td><input className="input" type="text" placeholder="Optional" style={{ width: 140 }} disabled={submitted} /></td>
                  </tr>
                );
              })}
              {students.length === 0 && <tr><td colSpan={7} className="text-center py-8 text-gray">No students found for this class.</td></tr>}
            </tbody></table></div>
            <div className="card-footer flex justify-between items-center">
              <span className="text-sm text-gray">{students.length} students • Avg: {avg}/{maxMarks}</span>
              <div className="flex gap-3 items-center">
                {saved && !submitted && <span className="badge badge-info">Draft saved</span>}
                {submitted && <span className="badge badge-success"><span className="icon icon-sm">check</span> Submitted</span>}
                <button className="btn btn-secondary" onClick={() => saveGrades(false)} disabled={submitted}><span className="icon icon-sm">save</span>Save Draft</button>
                <button className="btn btn-primary" onClick={() => saveGrades(true)} disabled={submitted}><span className="icon icon-sm">check_circle</span>Submit Final</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
