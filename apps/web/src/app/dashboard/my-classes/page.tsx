'use client';
import Topbar from '@/components/Topbar';
import { useAuth } from '@/context/AuthContext';
import { useState, useEffect } from 'react';
import { studentApi, teacherApi } from '@/lib/api';

export default function MyClassesPage() {
  const { user } = useAuth();
  const isTeacher = user?.role === 'TEACHER';

  const [loading, setLoading] = useState(true);
  const [classesData, setClassesData] = useState<any[]>([]);

  useEffect(() => {
    const fetchClasses = async () => {
      try {
        if (isTeacher) {
          const data = await teacherApi.getMyClasses();
          setClassesData(data);
        } else {
          const data = await studentApi.getMyClasses();
          setClassesData(data);
        }
      } catch (err) {
        console.error('Failed to load classes', err);
      } finally {
        setLoading(false);
      }
    };
    if (user) fetchClasses();
  }, [user, isTeacher]);

  if (!user || loading) {
    return (
      <div className="flex items-center justify-center p-12">
        <span className="icon animate-spin text-4xl text-primary">sync</span>
      </div>
    );
  }

  return (
    <>
      <Topbar title={isTeacher ? 'My Classes' : 'My Subjects'} subtitle={isTeacher ? 'Classes assigned to you this session' : `Class ${user?.classId}-${user?.sectionId} Subjects`} />
      <div style={{ padding: '24px 32px' }}>
        {isTeacher ? (
          <>
              <div className="grid grid-3 gap-4">
                {classesData.map((c, i) => (
                  <div key={i} className="card">
                  <div className="card-body">
                    <div className="flex items-center justify-between">
                      <h3>Class {c.cls}</h3>
                      <span className="badge badge-primary">{c.students} students</span>
                    </div>
                    <p className="text-sm text-gray mt-1">{c.sub}</p>
                    <div className="flex flex-col gap-2 mt-4">
                      <div className="flex items-center gap-2 text-sm"><span className="icon icon-sm text-gray">schedule</span>{c.schedule}</div>
                      <div className="flex items-center gap-2 text-sm"><span className="icon icon-sm text-gray">room</span>{c.room}</div>
                      <div className="flex items-center gap-2 text-sm"><span className="icon icon-sm text-success">event</span><span className="text-success font-semibold">{c.nextClass}</span></div>
                    </div>
                    <div className="flex gap-2 mt-4">
                      <a href="/dashboard/attendance" className="btn btn-sm btn-primary"><span className="icon icon-sm">fact_check</span>Take Attendance</a>
                      <a href="/dashboard/enter-marks" className="btn btn-sm btn-secondary"><span className="icon icon-sm">grading</span>Enter Marks</a>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="card">
              <div className="table-wrapper">
                <table className="table">
                  <thead><tr><th>Subject</th><th>Teacher</th><th>Schedule</th><th>Room</th><th>Attendance</th></tr></thead>
                  <tbody>
                    {classesData.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="text-center py-8 text-gray">No subjects assigned</td>
                      </tr>
                    ) : (
                      classesData.map((s, i) => (
                        <tr key={i}>
                          <td className="font-semibold"><span className="icon icon-sm text-primary" style={{marginRight:8}}>menu_book</span>{s.sub}</td>
                          <td>
                            <div className="flex items-center gap-2">
                              {s.teacher !== 'Unassigned' && <div className="avatar avatar-sm">{s.teacher.split(' ').map((n: string) => n[0]).join('')}</div>}
                              {s.teacher}
                            </div>
                          </td>
                          <td className="text-sm">{s.sched}</td>
                          <td>Room {s.room}</td>
                          <td><span className={`badge ${parseFloat(s.att)>=90?'badge-success':'badge-warning'}`}>{s.att}</span></td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}
