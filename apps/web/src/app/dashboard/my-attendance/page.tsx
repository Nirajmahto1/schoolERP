'use client';
import Topbar from '@/components/Topbar';
import { useState, useEffect } from 'react';
import { studentApi } from '@/lib/api';

export default function MyAttendancePage() {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<{ currentMonth: any[], monthlySummary: any[] }>({ currentMonth: [], monthlySummary: [] });
  const [targetDate] = useState(new Date());

  useEffect(() => {
    const fetchAttendance = async () => {
      try {
        const result = await studentApi.getMyAttendance();
        setData(result);
      } catch (err) {
        console.error('Failed to load attendance', err);
      } finally {
        setLoading(false);
      }
    };
    fetchAttendance();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center p-12">
        <span className="icon animate-spin text-4xl text-primary">sync</span>
      </div>
    );
  }

  const year = targetDate.getFullYear();
  const month = targetDate.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDay = new Date(year, month, 1).getDay();

  const days: any[] = [];
  for (let i = 0; i < firstDay; i++) {
    days.push(null);
  }

  for (let i = 1; i <= daysInMonth; i++) {
    const curDateStr = new Date(year, month, i).toISOString().split('T')[0];
    const record = data.currentMonth.find(a => new Date(a.date).toISOString().split('T')[0] === curDateStr);
    days.push({
      day: i,
      status: record ? record.status : 'holiday',
    });
  }

  const present = data.currentMonth.filter(d => d.status === 'present').length;
  const absent = data.currentMonth.filter(d => d.status === 'absent').length;
  const late = data.currentMonth.filter(d => d.status === 'late').length;
  const overallAtt = (present + absent + late) > 0 ? Math.round((present / (present + absent + late)) * 100) : 100;

  return (
    <>
      <Topbar title="My Attendance" subtitle="Your attendance record for this session" />
      <div style={{ padding: '24px 32px' }}>
        <div className="grid grid-4 gap-4 mb-6">
          {[{ l: 'Present', v: `${present}`, c: '#10B981' }, { l: 'Absent', v: `${absent}`, c: '#EF4444' }, { l: 'Late', v: `${late}`, c: '#F59E0B' }, { l: 'Attendance %', v: `${overallAtt}%`, c: '#5048E5' }].map(s => (
            <div key={s.l} className="stat-card" style={{ borderLeftColor: s.c }}>
              <div className="stat-icon" style={{ background: s.c + '15', color: s.c }}><span className="icon">event_available</span></div>
              <div><div className="stat-value">{s.v}</div><div className="stat-label">{s.l}</div></div>
            </div>
          ))}
        </div>

        <div className="grid grid-2 gap-6">
          <div className="card"><div className="card-body">
            <div className="flex items-center justify-between mb-4"><h3>{targetDate.toLocaleString('en-US', { month: 'long' })} {year}</h3><div className="flex gap-2"><button className="btn btn-ghost btn-icon btn-sm"><span className="icon icon-sm">chevron_left</span></button><button className="btn btn-ghost btn-icon btn-sm"><span className="icon icon-sm">chevron_right</span></button></div></div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 6 }}>
              {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map(d => <div key={d} style={{ textAlign: 'center', fontSize: '0.75rem', fontWeight: 700, color: 'var(--gray-400)', padding: 4 }}>{d}</div>)}
              {days.map((d, i) => (
                <div key={i} style={{ width: '100%', aspectRatio: '1', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.8125rem', fontWeight: 600, cursor: 'default',
                  background: !d ? 'transparent' : d.status === 'present' ? '#D1FAE5' : d.status === 'absent' ? '#FEE2E2' : d.status === 'late' ? '#FEF3C7' : '#F1F5F9',
                  color: !d ? 'transparent' : d.status === 'present' ? '#065F46' : d.status === 'absent' ? '#991B1B' : d.status === 'late' ? '#92400E' : '#94A3B8' }}>{d ? d.day : ''}</div>
              ))}
            </div>
            <div className="flex gap-4 mt-4">{[{ l: 'Present', c: '#D1FAE5' }, { l: 'Absent', c: '#FEE2E2' }, { l: 'Late', c: '#FEF3C7' }, { l: 'Holiday', c: '#F1F5F9' }].map(x => (<div key={x.l} className="flex items-center gap-2"><div style={{ width: 12, height: 12, borderRadius: 3, background: x.c }}></div><span className="text-xs text-gray">{x.l}</span></div>))}</div>
          </div></div>

          <div className="card"><div className="card-body">
            <h3 className="mb-4">Monthly Summary</h3>
            <table className="table"><thead><tr><th>Month</th><th>Working Days</th><th>Present</th><th>Absent</th><th>%</th></tr></thead>
              <tbody>
                {data.monthlySummary.length === 0 ? (
                   <tr><td colSpan={5} className="text-center py-4 text-gray text-sm">No attendance records found.</td></tr>
                ) : data.monthlySummary.map(r => (
                <tr key={r.m}><td className="font-semibold">{r.m}</td><td>{r.w}</td><td className="text-success">{r.p}</td><td className="text-danger">{r.a}</td><td><span className={`badge ${Math.round(r.p / r.w * 100) >= 90 ? 'badge-success' : 'badge-warning'}`}>{Math.round(r.p / r.w * 100)}%</span></td></tr>
                ))}
              </tbody>
            </table>
          </div></div>
        </div>
      </div>
    </>
  );
}
