'use client';
import Topbar from '@/components/Topbar';
import { useState, useEffect } from 'react';
import { studentApi, teacherApi } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';

const subColors: Record<string, string> = { Mathematics: '#5048E5', Science: '#10B981', English: '#3B82F6', Hindi: '#F59E0B', SST: '#EC4899', 'Physical Ed.': '#8B5CF6', Art: '#F97316', Computer: '#0EA5E9', Library: '#6366F1', 'Science Lab': '#059669', Break: '#94A3B8', Lunch: '#94A3B8' };

export default function TimetablePage() {
  const [loading, setLoading] = useState(true);
  const [timetable, setTimetable] = useState<any[]>([]);
  const [className, setClassName] = useState('');

  const { user } = useAuth();
  
  useEffect(() => {
    const fetchTable = async () => {
      try {
        const data = user?.role === 'TEACHER' ? await teacherApi.getMyTimetable() : await studentApi.getMyTimetable();
        setTimetable(data.timetable);
        setClassName(data.className);
      } catch (err) {
        console.error('Failed to load timetable', err);
      } finally { setLoading(false); }
    };
    if (user) fetchTable();
  }, [user]);

  if (loading) return <div className="p-12 text-center text-primary animate-pulse">Loading schedule...</div>;

  return (
    <>
      <Topbar title="Timetable" subtitle="Weekly class schedule" />
      <div style={{ padding: '24px 32px' }}>
        <div className="flex items-center justify-between mb-4">
          <div className="flex gap-3">
            <select className="select" style={{ width: 130 }}><option>Class {className}</option></select>
            <select className="select" style={{ width: 160 }}><option>Current Week</option></select>
          </div>
          <button className="btn btn-secondary"><span className="icon icon-sm">print</span>Print</button>
        </div>

        <div className="card">
          <div className="table-wrapper">
            <table className="table">
              <thead><tr><th>Time</th><th>Monday</th><th>Tuesday</th><th>Wednesday</th><th>Thursday</th><th>Friday</th></tr></thead>
              <tbody>
                {timetable.length === 0 ? (
                  <tr><td colSpan={6} className="text-center py-6 text-gray">No schedule found</td></tr>
                ) : timetable.map((row, i) => (
                  <tr key={i}>
                    <td><span className="badge badge-gray" style={{ minWidth: 90, justifyContent: 'center' }}>{row.time}</span></td>
                    {[row.mon, row.tue, row.wed, row.thu, row.fri].map((sub, j) => (
                      <td key={j}>
                        {sub === '-' || !sub ? <span className="text-sm text-gray" style={{ opacity: 0.5 }}>-</span> : sub === 'Break' || sub === 'Lunch' ? (
                          <span className="text-sm text-gray" style={{ fontStyle: 'italic' }}>{sub}</span>
                        ) : (
                          <div style={{ padding: '6px 10px', borderRadius: 8, background: (subColors[sub] || '#5048E5') + '10', borderLeft: `3px solid ${subColors[sub] || '#5048E5'}` }}>
                            <span style={{ fontSize: '0.8125rem', fontWeight: 600, color: subColors[sub] || '#5048E5' }}>{sub}</span>
                          </div>
                        )}
                      </td>
                    ))}
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
