'use client';
import Topbar from '@/components/Topbar';
import { useState, useEffect, useCallback } from 'react';
import { communicationApi, studentApi, teacherApi } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import { useLoading } from '@/context/LoadingContext';

const typeColors: Record<string, string> = { EVENT: '#5048E5', ACADEMIC: '#F59E0B', GENERAL: '#3B82F6' };

function timeAgo(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const h = Math.floor(diff / 3600000);
  if (h < 1) return 'Just now';
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function CommunicationPage() {
  const { user } = useAuth();
  const { startLoading, stopLoading } = useLoading();
  const [announcements, setAnnouncements] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [showCompose, setShowCompose] = useState(false);
  const [newAnn, setNewAnn] = useState({ title: '', content: '', type: 'GENERAL', target: 'All' });
  const [tab, setTab] = useState('Announcements');

  const fetchAnnouncements = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (user?.role === 'STUDENT') {
        const data = await studentApi.getMyAnnouncements();
        setAnnouncements(data);
      } else if (user?.role === 'TEACHER') {
        const data = await teacherApi.getMyAnnouncements();
        setAnnouncements(data);
      } else {
        const result = await communicationApi.getAnnouncements();
        setAnnouncements(result.data);
      }
    } catch (err: any) {
      setError(err?.detail || err?.message || 'Failed to load announcements. Please ensure the backend is running.');
      setAnnouncements([]);
    }
    setLoading(false);
  }, [user]);

  useEffect(() => { fetchAnnouncements(); }, [fetchAnnouncements]);

  const filtered = announcements.filter(a => a.title.toLowerCase().includes(search.toLowerCase()) || a.content.toLowerCase().includes(search.toLowerCase()));

  const addAnnouncement = async () => {
    if (!newAnn.title || !newAnn.content) { alert('Please provide both title and content for the announcement.'); return; }
    startLoading('Publishing announcement...');
    try {
      const roleMap: Record<string, string> = { All: '', Students: 'STUDENT', Parents: 'PARENT', Teachers: 'TEACHER' };
      const key = newAnn.target as keyof typeof roleMap;
      const mapped = roleMap[key];
      const roles = mapped === '' || mapped === undefined ? [] : [mapped];
      await communicationApi.createAnnouncement({ title: newAnn.title, content: newAnn.content, type: newAnn.type, targetRoles: roles });
      await fetchAnnouncements();
    } catch (err: any) { alert(err.detail || 'Failed to publish'); }
    setNewAnn({ title: '', content: '', type: 'GENERAL', target: 'All' });
    setShowCompose(false);
    stopLoading();
  };

  const deleteAnnouncement = async (id: string) => {
    startLoading('Deleting announcement...');
    try { await communicationApi.deleteAnnouncement(id); await fetchAnnouncements(); } catch (err: any) { alert(err.detail || 'Failed'); }
    stopLoading();
  };

  return (
    <>
      <Topbar title="Communication Hub" subtitle="Announcements, messages, and notifications" />
      <div style={{ padding: '24px 32px' }}>
        <div className="flex items-center justify-between mb-4" style={{ flexWrap: 'wrap', gap: 12 }}>
          <div className="tabs"><button className={`tab ${tab === 'Announcements' ? 'active' : ''}`} onClick={() => setTab('Announcements')}>Announcements</button><button className={`tab ${tab === 'Messages' ? 'active' : ''}`} onClick={() => setTab('Messages')}>Messages</button><button className={`tab ${tab === 'Events' ? 'active' : ''}`} onClick={() => setTab('Events')}>Events Calendar</button></div>
          <div className="flex gap-3"><div className="search-bar"><span className="icon">search</span><input placeholder="Search..." value={search} onChange={e => setSearch(e.target.value)} /></div>
          {user?.role !== 'STUDENT' && <button className="btn btn-primary" onClick={() => setShowCompose(!showCompose)}><span className="icon icon-sm">{showCompose ? 'close' : 'add'}</span>{showCompose ? 'Cancel' : 'New Announcement'}</button>}
          </div>
        </div>

        {showCompose && (
          <div className="card mb-4 animate-fadeIn"><div className="card-body"><h3 className="mb-4">Compose Announcement</h3>
            <div className="grid grid-2 gap-4">
              <div className="input-group"><label className="input-label">Title *</label><input className="input" value={newAnn.title} onChange={e => setNewAnn({ ...newAnn, title: e.target.value })} placeholder="e.g. Annual Sports Meet" /></div>
              <div className="grid grid-2 gap-4"><div className="input-group"><label className="input-label">Type</label><select className="select" value={newAnn.type} onChange={e => setNewAnn({ ...newAnn, type: e.target.value })}><option value="GENERAL">General</option><option value="ACADEMIC">Academic</option><option value="EVENT">Event</option></select></div>
                <div className="input-group"><label className="input-label">Target Audience</label><select className="select" value={newAnn.target} onChange={e => setNewAnn({ ...newAnn, target: e.target.value })}><option>All</option><option>Students</option><option>Parents</option><option>Teachers</option></select></div></div>
            </div>
            <div className="input-group"><label className="input-label">Content *</label><textarea className="input" rows={3} value={newAnn.content} onChange={e => setNewAnn({ ...newAnn, content: e.target.value })} placeholder="Write your announcement..." style={{ resize: 'vertical' }}></textarea></div>
            <div className="flex gap-3"><button className="btn btn-primary" onClick={addAnnouncement}><span className="icon icon-sm">send</span>Publish</button></div>
          </div></div>
        )}

        {error && (
          <div className="card mb-4" style={{ padding: 24, background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 12 }}>
            <div className="flex items-center gap-3">
              <span className="icon" style={{ color: '#EF4444' }}>error</span>
              <div><div style={{ fontWeight: 600, color: '#991B1B' }}>Connection Error</div><div style={{ fontSize: 14, color: '#B91C1C' }}>{error}</div></div>
              <button className="btn btn-sm btn-secondary" style={{ marginLeft: 'auto' }} onClick={fetchAnnouncements}><span className="icon icon-sm">refresh</span>Retry</button>
            </div>
          </div>
        )}

        {loading ? (
          <div className="card" style={{ padding: 48, textAlign: 'center' }}><span className="icon" style={{ fontSize: 32, color: '#5048E5', animation: 'spin 1s linear infinite' }}>progress_activity</span><p style={{ marginTop: 12, color: '#6B7280' }}>Loading announcements...</p></div>
        ) : !error && (
          <div className="flex flex-col gap-4">
            {filtered.map(a => (
              <div key={a.id} className="card"><div className="card-body">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-3"><span className="badge" style={{ background: (typeColors[a.type] || '#3B82F6') + '15', color: typeColors[a.type] || '#3B82F6' }}>{a.type}</span><h4>{a.title}</h4></div>
                  <div className="flex items-center gap-3"><span className="text-xs text-gray">{timeAgo(a.createdAt)}</span>
                  {user?.role !== 'STUDENT' && <button className="btn btn-sm btn-ghost" onClick={() => deleteAnnouncement(a.id)}><span className="icon icon-sm text-danger">delete</span></button>}
                  </div>
                </div>
                <p className="text-sm" style={{ color: 'var(--gray-600)', lineHeight: 1.6 }}>{a.content}</p>
                <div className="flex items-center gap-4 mt-3"><span className="text-xs text-gray"><span className="icon icon-sm">person</span> {a.createdByUser?.email?.split('@')[0] || 'Admin'}</span><span className="text-xs text-gray"><span className="icon icon-sm">group</span> {a.targetRoles?.length > 0 ? a.targetRoles.join(', ') : 'All'}</span></div>
              </div></div>
            ))}
            {filtered.length === 0 && <div className="card" style={{ padding: 24, textAlign: 'center', color: '#9CA3AF' }}>No announcements found</div>}
          </div>
        )}
      </div>
    </>
  );
}
