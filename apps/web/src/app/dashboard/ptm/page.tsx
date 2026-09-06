'use client';
import Topbar from '@/components/Topbar';
import { useEffect, useState } from 'react';
import { communicationApi } from '@/lib/api';

export default function PTMPage() {
  const [events, setEvents] = useState<any[]>([]);

  useEffect(() => {
    (async () => {
      try {
        const res = await communicationApi.getAnnouncements();
        const rows = (res.data || []).filter(
          (a: any) =>
            String(a.type || '').toUpperCase() === 'EVENT' ||
            String(a.title || '').toLowerCase().includes('ptm') ||
            String(a.content || '').toLowerCase().includes('parent-teacher'),
        );
        setEvents(rows);
      } catch {
        setEvents([]);
      }
    })();
  }, []);

  const primary = events[0];

  return (
    <>
      <Topbar title="PTM Schedule" subtitle="Parent-Teacher Meetings" />
      <div style={{ padding: '24px 32px' }}>
        <div className="card mb-6"><div className="card-body" style={{ background: 'linear-gradient(135deg,#EEF0FF,#F5F3FF)', borderRadius: 'var(--radius)' }}>
          <div className="flex items-center justify-between" style={{ flexWrap: 'wrap', gap: 12 }}>
            <div>
              <span className="badge badge-primary mb-2">From announcements</span>
              <h2>{primary?.title || 'No PTM announcements yet'}</h2>
              {primary && <p className="text-sm text-gray mt-1" style={{ whiteSpace: 'pre-wrap' }}>{primary.content}</p>}
            </div>
          </div>
        </div></div>

        <h3 className="mb-4">All school events & notices</h3>
        <div className="card"><div className="table-wrapper"><table className="table"><thead><tr><th>Title</th><th>Type</th><th>Posted</th></tr></thead><tbody>
          {events.length ? events.map((a: any) => (
            <tr key={a.id}><td className="font-semibold">{a.title}</td><td><span className="badge badge-primary">{a.type}</span></td><td className="text-sm text-gray">{new Date(a.createdAt).toLocaleString()}</td></tr>
          )) : <tr><td colSpan={3} className="text-center py-8 text-gray">No event announcements. Check Communication for general notices.</td></tr>}
        </tbody></table></div></div>
      </div>
    </>
  );
}
