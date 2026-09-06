'use client';
import Topbar from '@/components/Topbar';
import { useState, useEffect, useCallback } from 'react';
import { transportApi, studentApi, teacherApi } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';

export default function TransportPage() {
  const { user } = useAuth();
  const [routes, setRoutes] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const fetchRoutes = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (user?.role === 'STUDENT') {
        const data = await studentApi.getMyTransport();
        setRoutes(data);
      } else if (user?.role === 'TEACHER') {
        const data = await teacherApi.getMyTransport();
        setRoutes(data);
      } else {
        const result = await transportApi.getRoutes();
        setRoutes(result.data);
      }
    } catch (err: any) {
      setError(err?.detail || err?.message || 'Failed to load routes. Please ensure the backend is running.');
      setRoutes([]);
    }
    setLoading(false);
  }, [user]);

  useEffect(() => { fetchRoutes(); }, [fetchRoutes]);

  const filtered = routes.filter(r => r.name.toLowerCase().includes(search.toLowerCase()) || r.driver.toLowerCase().includes(search.toLowerCase()));
  const totalStudents = routes.reduce((a, b) => a + Number(b.students || 0), 0);

  return (
    <>
      <Topbar title="Transport System" subtitle="Manage bus routes, drivers, and tracking" />
      <div style={{ padding: '24px 32px' }}>
        <div className="grid grid-4 gap-4 mb-6">
          {[{ l: 'Active Routes', v: String(routes.filter(r => r.status === 'Active').length), c: '#5048E5' }, { l: 'Total Buses', v: String(routes.length), c: '#10B981' }, { l: 'Students Using', v: String(totalStudents), c: '#F59E0B' }, { l: 'On Maintenance', v: String(routes.filter(r => r.status === 'Maintenance').length), c: '#EF4444' }].map(s => (
            <div key={s.l} className="stat-card" style={{ borderLeftColor: s.c }}><div className="stat-icon" style={{ background: s.c + '15', color: s.c }}><span className="icon">directions_bus</span></div><div><div className="stat-value">{s.v}</div><div className="stat-label">{s.l}</div></div></div>
          ))}
        </div>

        <div className="flex items-center justify-between mb-4" style={{ flexWrap: 'wrap', gap: 12 }}>
          <div className="search-bar"><span className="icon">search</span><input placeholder="Search route or driver..." value={search} onChange={e => setSearch(e.target.value)} /></div>
        </div>

        {error && (
          <div className="card mb-4" style={{ padding: 24, background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 12 }}>
            <div className="flex items-center gap-3">
              <span className="icon" style={{ color: '#EF4444' }}>error</span>
              <div><div style={{ fontWeight: 600, color: '#991B1B' }}>Connection Error</div><div style={{ fontSize: 14, color: '#B91C1C' }}>{error}</div></div>
              <button className="btn btn-sm btn-secondary" style={{ marginLeft: 'auto' }} onClick={fetchRoutes}><span className="icon icon-sm">refresh</span>Retry</button>
            </div>
          </div>
        )}

        {loading ? (
          <div className="card" style={{ padding: 48, textAlign: 'center' }}><span className="icon" style={{ fontSize: 32, color: '#5048E5', animation: 'spin 1s linear infinite' }}>progress_activity</span><p style={{ marginTop: 12, color: '#6B7280' }}>Loading routes...</p></div>
        ) : !error && (
          <div className="grid grid-2 gap-4">
            {filtered.map(r => (
              <div key={r.id} className="card"><div className="card-body">
                <div className="flex items-center justify-between mb-3"><h3>{r.name}</h3><span className={`badge ${r.status === 'Active' ? 'badge-success' : 'badge-warning'}`}>{r.status}</span></div>
                <div className="grid grid-2 gap-3">
                  <div className="flex items-center gap-2 text-sm"><span className="icon icon-sm text-gray">directions_bus</span><span>{r.bus}</span></div>
                  <div className="flex items-center gap-2 text-sm"><span className="icon icon-sm text-gray">person</span><span>{r.driver}</span></div>
                  <div className="flex items-center gap-2 text-sm"><span className="icon icon-sm text-gray">phone</span><span>{r.phone}</span></div>
                  <div className="flex items-center gap-2 text-sm"><span className="icon icon-sm text-gray">schedule</span><span>Pickup: {r.time}</span></div>
                  <div className="flex items-center gap-2 text-sm"><span className="icon icon-sm text-gray">group</span><span>{r.students || 0} students</span></div>
                  <div className="flex items-center gap-2 text-sm"><span className="icon icon-sm text-gray">location_on</span><span>{r.stops || 0} stops</span></div>
                </div>
                <div className="flex gap-2 mt-4"><button className="btn btn-sm btn-secondary"><span className="icon icon-sm">map</span>View Route</button></div>
              </div></div>
            ))}
            {filtered.length === 0 && <div className="card" style={{ gridColumn: 'span 2', padding: 24, textAlign: 'center', color: '#9CA3AF' }}>No routes found</div>}
          </div>
        )}
      </div>
    </>
  );
}
