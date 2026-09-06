'use client';
import Topbar from '@/components/Topbar';
import { useAuth } from '@/context/AuthContext';
import styles from './page.module.css';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useLoading } from '@/context/LoadingContext';
import { aiApi, teacherApi, adminApi, studentApi } from '@/lib/api';
import { useState } from 'react';

/* ─── Admin / Principal Dashboard ─── */
function AdminDashboard() {
  const { user } = useAuth();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchData() {
      try {
        const res = await adminApi.getDashboard();
        setData(res);
      } catch (err: any) {
        setError(err.detail || err.message || 'Failed to load dashboard');
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, []);

  if (loading) return <div className="p-12 text-center text-primary animate-pulse">Loading dashboard...</div>;
  if (error) return <div className="p-12 text-center text-danger">Failed to load dashboard: {error}</div>;

  return (
    <>
      <Topbar title="Dashboard" subtitle={`Welcome back, ${user?.name || 'Admin'}`} />
      <div className={styles.content}>
        <div className="grid grid-4 gap-4 animate-fadeIn">
          {[
            { label: 'Total Students', value: data.totalStudents.toLocaleString(), icon: 'group', color: '#5048E5', bg: '#EEF0FF' },
            { label: 'Total Staff', value: data.totalStaff.toLocaleString(), icon: 'badge', color: '#10B981', bg: '#D1FAE5' },
            { label: 'Attendance Rate', value: `${data.attendanceRate}%`, icon: 'event_available', color: '#F59E0B', bg: '#FEF3C7' },
            { label: 'Fee Collection', value: `₹${(data.feeCollection / 100000).toFixed(1)}L`, icon: 'payments', color: '#EF4444', bg: '#FEE2E2' }
          ].map(s => (
            <div key={s.label} className="stat-card" style={{ borderLeftColor: s.color }}>
              <div className="stat-icon" style={{ background: s.bg, color: s.color }}><span className="icon">{s.icon}</span></div>
              <div>
                <div className="stat-value">{s.value}</div>
                <div className="stat-label">{s.label}</div>
              </div>
            </div>
          ))}
        </div>
        <div className={`grid grid-2 gap-4 mt-6 ${styles.chartsRow}`}>
          <div className="card"><div className="card-body"><h3>Weekly Attendance Trend</h3><div className={styles.chartPlaceholder}><div className={styles.barChart}>
            {['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].map((d, i) => (<div key={d} className={styles.barGroup}><div className={styles.bar} style={{ height: `${65 + Math.random() * 30}%`, background: i === 4 ? 'var(--primary-light)' : 'var(--primary)' }}></div><span>{d}</span></div>))}
          </div></div></div></div>
          <div className="card"><div className="card-body"><h3>Fee Collection Trend (6 Months)</h3><div className={styles.chartPlaceholder}><div className={styles.lineChart}><svg viewBox="0 0 300 120" className={styles.svg}><defs><linearGradient id="grad" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stopColor="var(--primary)" stopOpacity="0.2" /><stop offset="100%" stopColor="var(--primary)" stopOpacity="0" /></linearGradient></defs><path d="M0,100 L50,70 L100,80 L150,40 L200,50 L250,20 L300,30" fill="none" stroke="var(--primary)" strokeWidth="2.5" /><path d="M0,100 L50,70 L100,80 L150,40 L200,50 L250,20 L300,30 L300,120 L0,120 Z" fill="url(#grad)" /></svg><div className={styles.lineLabels}>{['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar'].map(m => <span key={m}>{m}</span>)}</div></div></div></div></div>
        </div>
        <div className={`grid grid-3 gap-4 mt-6 ${styles.bottomRow}`}>
          <div className="card"><div className="card-body"><div className="flex items-center justify-between mb-4"><h3><span className="icon icon-sm text-primary">campaign</span> Announcements</h3><a href="/dashboard/communication" className="btn btn-ghost btn-sm text-primary">View All</a></div>
            {[{ t: 'Annual Sports Meet 2025', d: '2h ago', c: '#5048E5' }, { t: 'Mid-term Exam Schedule', d: '5h ago', c: '#F59E0B' }, { t: 'Parent-Teacher Meeting', d: '1d ago', c: '#CBD5E1' }].map((a, i) => (
              <div key={i} className={styles.announcementItem}><div className={styles.announcementDot} style={{ background: a.c }}></div><div><div className={styles.announcementTitle}>{a.t}</div><span className={styles.announcementTime}>{a.d}</span></div></div>
            ))}
          </div></div>
          <div className="card"><div className="card-body"><h3 className="mb-4"><span className="icon icon-sm text-primary">calendar_month</span> Upcoming Events</h3>
            {[{ t: 'Science Exhibition', time: 'Mar 15 • 9 AM', c: '#5048E5' }, { t: "Teachers' Workshop", time: 'Mar 18 • 2 PM', c: '#10B981' }, { t: 'Inter-school Debate', time: 'Mar 22 • 10:30 AM', c: '#F59E0B' }].map((e, i) => (
              <div key={i} className={styles.eventItem}><div className={styles.eventDate} style={{ background: e.c + '15', color: e.c }}><span className={styles.eventDay}>{e.time.split(' ')[1]}</span><span className={styles.eventMonth}>{e.time.split(' ')[0]}</span></div><div><div className="font-semibold" style={{ fontSize: '0.875rem' }}>{e.t}</div><div className="text-sm text-gray">{e.time}</div></div></div>
            ))}
          </div></div>
          <div className="card"><div className="card-body"><h3 className="mb-4"><span className="icon icon-sm text-primary">rocket_launch</span> Quick Actions</h3>
            <div className={styles.quickGrid}>
              {[{ l: 'Add Student', i: 'person_add', h: '/dashboard/students' }, { l: 'Mark Attendance', i: 'fact_check', h: '/dashboard/attendance' }, { l: 'Collect Fee', i: 'receipt_long', h: '/dashboard/fees' }, { l: 'Send Notice', i: 'send', h: '/dashboard/communication' }, { l: 'View Reports', i: 'bar_chart', h: '/dashboard/exams' }, { l: 'Timetable', i: 'calendar_month', h: '/dashboard/academics' }].map(a => (
                <a key={a.l} href={a.h} className={styles.quickAction}><span className="icon" style={{ color: 'var(--primary)', fontSize: 22 }}>{a.i}</span><span>{a.l}</span></a>
              ))}
            </div>
          </div></div>
        </div>
      </div>
    </>
  );
}

/* ─── Teacher Dashboard ─── */
function TeacherDashboard() {
  const { user } = useAuth();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      try {
        const result = await teacherApi.getDashboard();
        setData(result);
      } catch (err) { console.error('Dashboard load failed', err); } finally { setLoading(false); }
    }
    fetchData();
  }, []);

  if (loading) return <div className="p-12 text-center text-primary animate-pulse">Loading dashboard...</div>;
  if (!data) return <div className="p-12 text-center text-danger">Failed to load dashboard</div>;

  return (
    <>
      <Topbar title="Teacher Dashboard" subtitle={`Welcome, ${user?.name || 'Teacher'}`} />
      <div className={styles.content}>
        <div className="grid grid-4 gap-4 animate-fadeIn">
          {[
            { l: 'My Classes', v: String(data.totalClasses), i: 'class', c: '#5048E5' }, 
            { l: 'Total Students', v: String(data.totalStudents), i: 'group', c: '#10B981' }, 
            { l: "Today's Attendance", v: data.attendanceToday, i: 'fact_check', c: '#F59E0B' }, 
            { l: 'Pending Marks', v: `${data.examsPending} exams`, i: 'grading', c: '#EF4444' }
          ].map(s => (
            <div key={s.l} className="stat-card" style={{ borderLeftColor: s.c }}>
              <div className="stat-icon" style={{ background: s.c + '15', color: s.c }}><span className="icon">{s.i}</span></div>
              <div><div className="stat-value">{s.v}</div><div className="stat-label">{s.l}</div></div>
            </div>
          ))}
        </div>

        <div className="grid grid-2 gap-4 mt-6">
          <div className="card"><div className="card-body">
            <h3 className="mb-4"><span className="icon icon-sm text-primary">calendar_month</span> Today&apos;s Schedule</h3>
            {data.schedule && data.schedule.length > 0 ? data.schedule.map((s: any, i: number) => (
              <div key={i} style={{ display: 'flex', gap: 16, padding: '12px 0', borderBottom: i < 3 ? '1px solid var(--gray-100)' : 'none', alignItems: 'center' }}>
                <span className="badge badge-primary" style={{ minWidth: 80, justifyContent: 'center' }}>{s.time}</span>
                <div><div className="font-semibold" style={{ fontSize: '0.875rem' }}>{s.sub}</div><div className="text-sm text-gray">{s.cls} • {s.room}</div></div>
                <a href="/dashboard/attendance" className="btn btn-sm btn-ghost" style={{ marginLeft: 'auto' }}><span className="icon icon-sm">fact_check</span></a>
              </div>
            )) : <p className="text-gray text-sm py-4">No scheduled classes today.</p>}
          </div></div>
          <div className="card"><div className="card-body">
            <h3 className="mb-4"><span className="icon icon-sm text-primary">assignment</span> Pending Tasks</h3>
            {data.tasks && data.tasks.length > 0 ? data.tasks.map((t: any, i: number) => (
              <div key={i} style={{ display: 'flex', gap: 12, padding: '12px 0', borderBottom: i < 3 ? '1px solid var(--gray-100)' : 'none', alignItems: 'center' }}>
                <input type="checkbox" style={{ accentColor: 'var(--primary)', width: 16, height: 16 }} />
                <div style={{ flex: 1 }}><div className="font-semibold" style={{ fontSize: '0.875rem' }}>{t.t}</div><div className="text-sm text-gray">Due: {t.due}</div></div>
                <span className={`badge ${t.p === 'Urgent' ? 'badge-danger' : t.p === 'High' ? 'badge-warning' : t.p === 'Medium' ? 'badge-info' : 'badge-gray'}`}>{t.p}</span>
              </div>
            )) : <p className="text-gray text-sm py-4">No pending tasks.</p>}
          </div></div>
        </div>

        <div className="card mt-6"><div className="card-body">
          <h3 className="mb-4">My Classes — Quick Overview</h3>
          <div className="grid grid-3 gap-4">
            {data.classOverview && data.classOverview.length > 0 ? data.classOverview.map((c: any) => (
              <div key={c.cls} style={{ padding: 16, background: 'var(--gray-50)', borderRadius: 'var(--radius)', border: '1px solid var(--gray-100)' }}>
                <div className="flex items-center justify-between"><h4>Class {c.cls}</h4><span className="badge badge-primary">{c.students} students</span></div>
                <div className="flex gap-4 mt-2"><span className="text-sm"><span className="text-gray">Attendance:</span> <span className="text-success font-semibold">{c.att}</span></span><span className="text-sm"><span className="text-gray">Avg Score:</span> <span className="font-semibold">{c.avg}%</span></span></div>
              </div>
            )) : <p className="text-gray text-sm py-4">No active classes found.</p>}
          </div>
        </div></div>
      </div>
    </>
  );
}

/* ─── Student Dashboard ─── */
function StudentDashboard() {
  const { startLoading, stopLoading } = useLoading();
  const [data, setData] = useState<any>(null);
  const [loadingError, setLoadingError] = useState<string | null>(null);
  const [prediction, setPrediction] = useState<any>(null);

  const { user } = useAuth();

  useEffect(() => {
    async function fetchData() {
      try {
        const result = await studentApi.getDashboard();
        setData(result);
      } catch (err: any) {
        setLoadingError(err.detail || err.message || 'Failed to load dashboard data');
      }
    }
    fetchData();
  }, []);

  const getPrediction = async () => {
    if (!data?.student) return;
    startLoading('Analyzing past performance and attendance...');
    try {
      const res = await aiApi.getStudentPerformance(data.student.id);
      setPrediction(res);
    } catch (err: any) {
      alert('AI prediction failed: ' + (err.detail || err.message));
    } finally {
      stopLoading();
    }
  };

  if (loadingError) {
    return (
      <>
        <Topbar title="Student Dashboard" subtitle={`Welcome, ${user?.name || 'Student'}`} />
        <div className={styles.content}>
          <div className="card" style={{ padding: '3rem', textAlign: 'center' }}>
            <span className="icon text-danger" style={{ fontSize: 48, marginBottom: 16 }}>error</span>
            <h3>Failed to load Dashboard</h3>
            <p className="text-gray mt-2">{loadingError}</p>
            <button className="btn btn-primary mt-4" onClick={() => window.location.reload()}>Retry</button>
          </div>
        </div>
      </>
    );
  }

  if (!data) {
    return (
      <>
        <Topbar title="Student Dashboard" subtitle={`Welcome, ${user?.name || 'Student'}`} />
        <div className={styles.content}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <span className="icon animate-spin">sync</span> Loading dashboard data...
          </div>
        </div>
      </>
    );
  }

  const { student, stats, timetable, announcements, recentResults } = data;
  const className = student ? `${student.class?.name}-${student.section?.name}` : 'Unknown Class';

  return (
    <>
      <Topbar title="Student Dashboard" subtitle={`Welcome, ${student?.firstName || user?.name || 'Student'} — ${className}`} />
      <div className={styles.content}>

        {prediction && (
          <div className="card mb-6 animate-fadeIn" style={{ background: 'linear-gradient(to right, #EEF0FF, #F8FAFC)' }}>
            <div className="card-body">
              <h3 className="mb-4 flex items-center gap-2 text-primary"><span className="icon">auto_awesome</span> AI Performance Prediction</h3>
              <div className="grid grid-3 gap-4">
                <div style={{ background: 'white', padding: 16, borderRadius: 8 }}>
                  <div className="text-sm text-gray">Predicted Final Grade</div>
                  <div className="text-2xl font-bold text-success">{prediction.predictedFinalGrade}</div>
                </div>
                <div style={{ background: 'white', padding: 16, borderRadius: 8 }}>
                  <div className="text-sm text-gray">Risk of Dropout</div>
                  <div className="text-2xl font-bold text-primary">{prediction.riskOfDropout}</div>
                </div>
                <div style={{ background: 'white', padding: 16, borderRadius: 8 }}>
                  <div className="text-sm text-gray">Recommendation</div>
                  <div className="text-sm font-semibold mt-1">{prediction.recommendedAction}</div>
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="grid grid-4 gap-4 animate-fadeIn">
          <div className="stat-card" style={{ borderLeftColor: '#10B981' }}>
            <div className="stat-icon" style={{ background: '#10B98115', color: '#10B981' }}><span className="icon">event_available</span></div>
            <div><div className="stat-value">{stats.attendancePercentage}%</div><div className="stat-label">Attendance</div></div>
          </div>
          <div className="stat-card" style={{ borderLeftColor: '#F59E0B' }}>
            <div className="stat-icon" style={{ background: '#F59E0B15', color: '#F59E0B' }}><span className="icon">emoji_events</span></div>
            <div>
              <div className="stat-value">
                {recentResults.length ? `${Math.round(recentResults.reduce((a: any, b: any) => a + Number(b.marksObtained), 0) / recentResults.length)}%` : '--'}
              </div>
              <div className="stat-label">Avg Grade</div>
            </div>
          </div>
          <div className="stat-card" style={{ borderLeftColor: '#EF4444' }}>
            <div className="stat-icon" style={{ background: '#EF444415', color: '#EF4444' }}><span className="icon">payments</span></div>
            <div><div className="stat-value">₹{stats.pendingFeesTotal?.toLocaleString() || 0}</div><div className="stat-label">Pending Fees</div></div>
          </div>
          <div className="stat-card" style={{ borderLeftColor: '#5048E5' }}>
            <div className="stat-icon" style={{ background: '#5048E515', color: '#5048E5' }}><span className="icon">local_library</span></div>
            <div><div className="stat-value">{stats.issuedBooksCount} issued</div><div className="stat-label">Library Books</div></div>
          </div>
        </div>

        <div className="grid grid-2 gap-4 mt-6">
          <div className="card"><div className="card-body">
            <h3 className="mb-4"><span className="icon icon-sm text-primary">calendar_month</span> Today&apos;s Timetable</h3>
            {timetable && timetable.length > 0 ? (
              timetable.map((s: any, i: number) => (
                <div key={i} style={{ display: 'flex', gap: 12, padding: '10px 0', borderBottom: i < timetable.length - 1 ? '1px solid var(--gray-100)' : 'none', alignItems: 'center' }}>
                  <span className="badge badge-gray" style={{ minWidth: 50, justifyContent: 'center' }}>{s.startTime}</span>
                  <div>
                    <div className="font-semibold" style={{ fontSize: '0.875rem' }}>{s.subject?.name}</div>
                    {s.subject?.teachers?.[0]?.staff && <div className="text-xs text-gray">{s.subject.teachers[0].staff.firstName} {s.subject.teachers[0].staff.lastName}</div>}
                  </div>
                </div>
              ))
            ) : (
              <div className="text-center text-gray italic py-4">No classes scheduled for today.</div>
            )}
          </div></div>

          <div className="card"><div className="card-body">
            <h3 className="mb-4"><span className="icon icon-sm text-primary">analytics</span> Recent Results</h3>
            {recentResults && recentResults.length > 0 ? (
              <>
                <div className="table-wrapper">
                  <table className="table">
                    <thead><tr><th>Subject</th><th>Marks</th><th>Grade</th></tr></thead>
                    <tbody>
                      {recentResults.map((r: any, i: number) => (
                        <tr key={i}>
                          <td className="font-semibold">{r.examSubject?.subject?.name || 'Unknown'}</td>
                          <td>{Number(r.marksObtained)}/{r.examSubject?.maxMarks || 100}</td>
                          <td><span className={`badge ${r.grade?.startsWith('A') ? 'badge-success' : 'badge-info'}`}>{r.grade || 'N/A'}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="flex justify-between items-center mt-4 pt-4" style={{ borderTop: '1px solid var(--gray-100)' }}>
                  <div className="flex gap-2 items-center">
                    <button className="btn btn-sm btn-secondary" onClick={getPrediction}><span className="icon icon-sm text-primary">auto_awesome</span> AI Insights</button>
                  </div>
                </div>
              </>
            ) : (
              <div className="text-center text-gray italic py-4">No recent exam results found.</div>
            )}
          </div></div>
        </div>

        <div className="grid grid-2 gap-4 mt-6">
          <div className="card"><div className="card-body"><h3 className="mb-4"><span className="icon icon-sm text-primary">payments</span> Fee Status</h3>
            {student.feeInvoices && student.feeInvoices.length > 0 ? (
              <>
                {student.feeInvoices.filter((f: any) => f.status === 'PENDING').slice(0, 3).map((f: any, i: number) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderBottom: i < 2 ? '1px solid var(--gray-100)' : 'none', alignItems: 'center' }}>
                    <div><div className="font-semibold" style={{ fontSize: '0.875rem' }}>Invoice #{f.invoiceNo}</div><div className="text-xs text-gray">Due: {new Date(f.dueDate).toLocaleDateString()}</div></div>
                    <div className="flex items-center gap-3"><span className="font-bold">₹{(Number(f.totalAmount) - Number(f.paidAmount)).toLocaleString()}</span><span className={`badge badge-warning`}>Pending</span></div>
                  </div>
                ))}
                <button className="btn btn-primary mt-4 w-full" style={{ justifyContent: 'center' }} onClick={() => { startLoading('Connecting to payment gateway...'); setTimeout(() => { stopLoading(); alert('Online payment gateway integration pending'); }, 1500); }}><span className="icon icon-sm">payments</span>Pay Pending Fees</button>
              </>
            ) : (
              <div className="text-center text-gray italic py-4">No pending fee invoices. All caught up!</div>
            )}
          </div></div>

          <div className="card"><div className="card-body"><h3 className="mb-4"><span className="icon icon-sm text-primary">campaign</span> Announcements</h3>
            {announcements && announcements.length > 0 ? (
              announcements.map((a: any, i: number) => (
                <div key={i} style={{ display: 'flex', gap: 12, padding: '10px 0', borderBottom: i < announcements.length - 1 ? '1px solid var(--gray-100)' : 'none' }}>
                  <span className="icon" style={{ color: 'var(--primary)', fontSize: 18, marginTop: 2 }}>campaign</span>
                  <div>
                    <div className="font-semibold" style={{ fontSize: '0.875rem' }}>{a.title}</div>
                    <div className="text-xs text-gray">{new Date(a.createdAt).toLocaleString()}</div>
                  </div>
                </div>
              ))
            ) : (
              <div className="text-center text-gray italic py-4">No recent announcements.</div>
            )}
          </div></div>
        </div>
      </div>
    </>
  );
}

/* ─── Parent Dashboard ─── */
function ParentDashboard() {
  const { startLoading, stopLoading } = useLoading();
  const { user } = useAuth();
  return (
    <>
      <Topbar title="Parent Dashboard" subtitle={`Welcome, ${user?.name || 'Parent'}`} />
      <div className={styles.content}>
        {/* Child selector */}
        <div className="card mb-6"><div className="card-body flex items-center gap-4">
          <div className="avatar avatar-lg" style={{ background: '#EEF0FF', color: '#5048E5' }}>AS</div>
          <div style={{ flex: 1 }}><h3>Aarav Singh</h3><p className="text-sm text-gray">Class 10-A • Admission No: DPS-2025-0001</p></div>
          <select className="select" style={{ width: 200 }}><option>Aarav Singh (Class 10-A)</option></select>
        </div></div>

        <div className="grid grid-4 gap-4 animate-fadeIn">
          {[{ l: 'Attendance', v: '94%', i: 'event_available', c: '#10B981' }, { l: 'Class Rank', v: '#3 / 32', i: 'emoji_events', c: '#F59E0B' }, { l: 'Pending Fees', v: '₹5,000', i: 'payments', c: '#EF4444' }, { l: 'Overall Grade', v: 'A', i: 'grade', c: '#5048E5' }].map(s => (
            <div key={s.l} className="stat-card" style={{ borderLeftColor: s.c }}>
              <div className="stat-icon" style={{ background: s.c + '15', color: s.c }}><span className="icon">{s.i}</span></div>
              <div><div className="stat-value">{s.v}</div><div className="stat-label">{s.l}</div></div>
            </div>
          ))}
        </div>

        <div className="grid grid-2 gap-4 mt-6">
          <div className="card"><div className="card-body">
            <h3 className="mb-4"><span className="icon icon-sm text-primary">analytics</span> Academic Performance</h3>
            <div className="table-wrapper"><table className="table"><thead><tr><th>Subject</th><th>Teacher</th><th>Marks</th><th>Grade</th></tr></thead><tbody>
              {[{ sub: 'Mathematics', teacher: 'Priya Sharma', marks: '92/100', grade: 'A+' }, { sub: 'Science', teacher: 'Rajesh Kumar', marks: '88/100', grade: 'A' }, { sub: 'English', teacher: 'Anita Verma', marks: '85/100', grade: 'A' }, { sub: 'Hindi', teacher: 'Suresh Patel', marks: '78/100', grade: 'B+' }, { sub: 'Social Science', teacher: 'Meena Gupta', marks: '90/100', grade: 'A+' }].map((r, i) => (
                <tr key={i}><td className="font-semibold">{r.sub}</td><td className="text-sm text-gray">{r.teacher}</td><td>{r.marks}</td><td><span className={`badge ${r.grade.startsWith('A') ? 'badge-success' : 'badge-info'}`}>{r.grade}</span></td></tr>
              ))}
            </tbody></table></div>
          </div></div>
          <div className="card"><div className="card-body">
            <h3 className="mb-4"><span className="icon icon-sm text-primary">event_available</span> Attendance This Month</h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 4 }}>
              {Array.from({ length: 31 }, (_, i) => {
                const status = i < 10 ? (i % 6 === 0 ? 'absent' : 'present') : i === 10 ? 'late' : 'present'; return (
                  <div key={i} style={{
                    width: '100%', aspectRatio: '1', borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.6875rem', fontWeight: 600,
                    background: status === 'present' ? '#D1FAE5' : status === 'absent' ? '#FEE2E2' : '#FEF3C7', color: status === 'present' ? '#065F46' : status === 'absent' ? '#991B1B' : '#92400E'
                  }}>{i + 1}</div>
                );
              })}
            </div>
            <div className="flex gap-4 mt-4">{[{ l: 'Present', c: '#D1FAE5' }, { l: 'Absent', c: '#FEE2E2' }, { l: 'Late', c: '#FEF3C7' }].map(x => (<div key={x.l} className="flex items-center gap-2"><div style={{ width: 12, height: 12, borderRadius: 3, background: x.c }}></div><span className="text-xs text-gray">{x.l}</span></div>))}</div>
          </div></div>
        </div>

        <div className="grid grid-2 gap-4 mt-6">
          <div className="card"><div className="card-body"><h3 className="mb-4"><span className="icon icon-sm text-primary">payments</span> Fee Summary</h3>
            {[{ type: 'Tuition Fee (March)', amt: '₹5,000', status: 'Pending' }, { type: 'Tuition Fee (Feb)', amt: '₹5,000', status: 'Paid' }, { type: 'Bus Fee (Q1)', amt: '₹7,500', status: 'Paid' }, { type: 'Development Fee', amt: '₹15,000', status: 'Upcoming' }].map((f, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderBottom: i < 3 ? '1px solid var(--gray-100)' : 'none' }}>
                <span className="font-semibold" style={{ fontSize: '0.875rem' }}>{f.type}</span>
                <div className="flex gap-3 items-center"><span className="font-bold">{f.amt}</span><span className={`badge ${f.status === 'Paid' ? 'badge-success' : f.status === 'Pending' ? 'badge-warning' : 'badge-gray'}`}>{f.status}</span></div>
              </div>
            ))}
            <button className="btn btn-primary mt-4 w-full" style={{ justifyContent: 'center' }} onClick={() => { startLoading('Connecting to payment gateway...'); setTimeout(() => { stopLoading(); alert('Online payment gateway integration pending'); }, 1500); }}><span className="icon icon-sm">payments</span>Pay ₹5,000</button>
          </div></div>
          <div className="card"><div className="card-body"><h3 className="mb-4"><span className="icon icon-sm text-primary">event</span> Upcoming</h3>
            {[{ t: 'Parent-Teacher Meet', d: 'Mar 15, 2026 • 10 AM', i: 'event' }, { t: 'Annual Sports Day', d: 'Mar 22, 2026 • 9 AM', i: 'sports_soccer' }, { t: 'Next Fee Due Date', d: 'Apr 10, 2026', i: 'payments' }].map((e, i) => (
              <div key={i} style={{ display: 'flex', gap: 12, padding: '12px 0', borderBottom: i < 2 ? '1px solid var(--gray-100)' : 'none', alignItems: 'center' }}>
                <div style={{ width: 40, height: 40, borderRadius: 8, background: 'var(--primary-50)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><span className="icon" style={{ color: 'var(--primary)', fontSize: 18 }}>{e.i}</span></div>
                <div><div className="font-semibold" style={{ fontSize: '0.875rem' }}>{e.t}</div><div className="text-xs text-gray">{e.d}</div></div>
              </div>
            ))}
          </div></div>
        </div>
      </div>
    </>
  );
}

/* ─── Finance Dashboard ─── */
function FinanceDashboard() {
  const { user } = useAuth();
  return (
    <>
      <Topbar title="Finance Dashboard" subtitle={`Welcome, ${user?.name || 'Finance Officer'}`} />
      <div className={styles.content}>
        <div className="grid grid-4 gap-4 animate-fadeIn">
          {[{ l: 'Monthly Revenue', v: '₹18.5L', i: 'trending_up', c: '#10B981', ch: '+12%' }, { l: 'Monthly Expenses', v: '₹12.3L', i: 'trending_down', c: '#EF4444', ch: '+5%' }, { l: 'Payroll Due', v: '₹8.2L', i: 'account_balance_wallet', c: '#F59E0B', ch: '124 staff' }, { l: 'Outstanding Fees', v: '₹4.8L', i: 'warning', c: '#5048E5', ch: '86 students' }].map(s => (
            <div key={s.l} className="stat-card" style={{ borderLeftColor: s.c }}><div className="stat-icon" style={{ background: s.c + '15', color: s.c }}><span className="icon">{s.i}</span></div><div><div className="stat-value">{s.v}</div><div className="stat-label">{s.l}</div><div className="stat-change positive"><span className="icon icon-sm">info</span> {s.ch}</div></div></div>
          ))}
        </div>
        <div className="grid grid-2 gap-4 mt-6">
          <div className="card"><div className="card-body"><h3 className="mb-4"><span className="icon icon-sm text-primary">account_balance</span> Recent Transactions</h3>
            {[{ desc: 'Fee Payment — Aarav Singh', amt: '+₹5,000', time: '2h ago', type: 'credit' }, { desc: 'Electricity Bill — March', amt: '-₹45,000', time: '5h ago', type: 'debit' }, { desc: 'Fee Payment — Diya Patel', amt: '+₹5,000', time: '1d ago', type: 'credit' }, { desc: 'Staff Salary Advance — R. Kumar', amt: '-₹15,000', time: '1d ago', type: 'debit' }, { desc: 'Bus Fee Collection — Batch', amt: '+₹1,50,000', time: '2d ago', type: 'credit' }].map((t, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderBottom: i < 4 ? '1px solid var(--gray-100)' : 'none', alignItems: 'center' }}>
                <div className="flex items-center gap-3"><div style={{ width: 36, height: 36, borderRadius: 8, background: t.type === 'credit' ? '#D1FAE5' : '#FEE2E2', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><span className="icon icon-sm" style={{ color: t.type === 'credit' ? '#10B981' : '#EF4444' }}>{t.type === 'credit' ? 'arrow_downward' : 'arrow_upward'}</span></div><div><div className="font-semibold" style={{ fontSize: '0.875rem' }}>{t.desc}</div><div className="text-xs text-gray">{t.time}</div></div></div>
                <span className="font-bold" style={{ color: t.type === 'credit' ? '#10B981' : '#EF4444' }}>{t.amt}</span>
              </div>
            ))}
          </div></div>
          <div className="card"><div className="card-body"><h3 className="mb-4"><span className="icon icon-sm text-primary">rocket_launch</span> Quick Actions</h3>
            <div className={styles.quickGrid}>
              {[{ l: 'Collect Fee', i: 'payments', h: '/dashboard/fees' }, { l: 'Record Expense', i: 'receipt_long', h: '/dashboard/expenses' }, { l: 'Process Payroll', i: 'account_balance_wallet', h: '/dashboard/payroll' }, { l: 'Generate Invoice', i: 'description', h: '/dashboard/invoicing' }, { l: 'View Reports', i: 'assessment', h: '/dashboard/financial-reports' }, { l: 'Manage Budgets', i: 'savings', h: '/dashboard/budgets' }].map(a => (
                <a key={a.l} href={a.h} className={styles.quickAction}><span className="icon" style={{ color: 'var(--primary)', fontSize: 22 }}>{a.i}</span><span>{a.l}</span></a>
              ))}
            </div>
          </div></div>
        </div>
      </div>
    </>
  );
}

/* ─── Main Dashboard Router ─── */
export default function DashboardPage() {
  const { user } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!user) router.push('/');
  }, [user, router]);

  if (!user) return null;

  switch (user.role) {
    case 'TEACHER': return <TeacherDashboard />;
    case 'STUDENT': return <StudentDashboard />;
    case 'PARENT': return <ParentDashboard />;
    case 'FINANCE': return <FinanceDashboard />;
    default: return <AdminDashboard />;
  }
}

