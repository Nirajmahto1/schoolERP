'use client';
import Topbar from '@/components/Topbar';
import { useEffect, useState } from 'react';
import { parentApi } from '@/lib/api';

export default function ChildOverviewPage() {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const res = await parentApi.getMeChildrenSummary();
        setData(res);
      } catch (e: any) {
        setError(e?.detail || e?.message || 'Could not load child overview.');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) {
    return (
      <>
        <Topbar title="Child Overview" subtitle="Monitor your child&apos;s academic progress" />
        <div className="p-12 text-center text-primary animate-pulse">Loading…</div>
      </>
    );
  }

  if (error || !data?.students?.length) {
    return (
      <>
        <Topbar title="Child Overview" subtitle="Monitor your child&apos;s academic progress" />
        <div style={{ padding: '24px 32px' }} className="card"><div className="card-body text-gray">{error || 'No linked student found. Ask the school to link your account to a parent profile.'}</div></div>
      </>
    );
  }

  const child = data.students[0];
  const cls = `${child.class?.name || ''}-${child.section?.name || ''}`.replace(/^-|-$/g, '');
  const subjectRows = (child.examResults || []).slice(0, 8).map((er: any) => ({
    sub: er.examSubject?.subject?.name || 'Subject',
    marks: Math.round(Number(er.marksObtained) || 0),
  }));

  return (
    <>
      <Topbar title="Child Overview" subtitle="Monitor your child&apos;s academic progress" />
      <div style={{ padding: '24px 32px' }}>
        <div className="card mb-6"><div className="card-body flex items-center gap-4">
          <div className="avatar avatar-lg" style={{ background: '#EEF0FF', color: '#5048E5' }}>{(child.firstName?.[0] || '') + (child.lastName?.[0] || '')}</div>
          <div style={{ flex: 1 }}><h3>{child.firstName} {child.lastName}</h3><p className="text-sm text-gray">Class {cls} • Roll: {child.rollNo || '—'} • Admission: {child.admissionNo}</p></div>
          <div style={{ textAlign: 'right' }}><div className="stat-value" style={{ fontSize: '1.25rem', color: 'var(--primary)' }}>{data.stats.attendancePct}%</div><div className="text-xs text-gray">attendance</div></div>
        </div></div>

        <div className="grid grid-4 gap-4 mb-6">
          {[
            { l: 'Attendance', v: `${data.stats.attendancePct}%`, c: '#10B981' },
            { l: 'Pending Fees', v: `₹${Math.round(data.stats.pendingFees).toLocaleString()}`, c: '#EF4444' },
            { l: 'Books Issued', v: String(data.stats.booksIssued), c: '#F59E0B' },
            { l: 'Results on file', v: String((child.examResults || []).length), c: '#5048E5' },
          ].map(s => (
            <div key={s.l} className="stat-card" style={{ borderLeftColor: s.c }}><div className="stat-icon" style={{ background: s.c + '15', color: s.c }}><span className="icon">check_circle</span></div><div><div className="stat-value">{s.v}</div><div className="stat-label">{s.l}</div></div></div>
          ))}
        </div>

        <div className="grid grid-2 gap-6">
          <div className="card"><div className="card-body">
            <h3 className="mb-4">Recent results</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {subjectRows.length ? subjectRows.map((s: { sub: string; marks: number }) => (
                <div key={s.sub}>
                  <div className="flex justify-between items-center"><span className="font-semibold" style={{ fontSize: '0.875rem' }}>{s.sub}</span><span className="font-bold">{s.marks}</span></div>
                  <div style={{ height: 8, background: 'var(--gray-100)', borderRadius: 4, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${Math.min(100, s.marks)}%`, borderRadius: 4, background: s.marks >= 80 ? '#10B981' : '#3B82F6', transition: 'width 0.5s ease' }} />
                  </div>
                </div>
              )) : <p className="text-sm text-gray">No exam results yet.</p>}
            </div>
          </div></div>

          <div className="card"><div className="card-body">
            <h3 className="mb-4">Issued books</h3>
            {(child.bookIssues || []).length ? (child.bookIssues || []).map((bi: any) => (
              <div key={bi.id} className="text-sm py-2 border-b border-gray-100">{bi.book?.title || 'Book'}</div>
            )) : <p className="text-sm text-gray">No active book issues.</p>}
          </div></div>
        </div>
      </div>
    </>
  );
}
