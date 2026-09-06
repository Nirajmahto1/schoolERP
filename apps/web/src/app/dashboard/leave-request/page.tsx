'use client';
import Topbar from '@/components/Topbar';
import { useState, useEffect } from 'react';
import { teacherApi } from '@/lib/api';

export default function LeaveRequestPage() {
  const [leaveType, setLeaveType] = useState('Casual');
  const [startDate, setStartDate] = useState(new Date().toISOString().split('T')[0]);
  const [endDate, setEndDate] = useState(new Date().toISOString().split('T')[0]);
  const [reason, setReason] = useState('');
  const [history, setHistory] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const loadData = async () => {
    try {
      const res = await teacherApi.getLeaveRequests();
      setHistory(res || []);
    } catch (error) { console.error(error); }
    setLoading(false);
  };

  useEffect(() => { loadData(); }, []);

  const submit = async () => {
    if (!reason || !startDate || !endDate) return alert('Please fill required fields.');
    setSubmitting(true);
    try {
      await teacherApi.createLeaveRequest({ leaveType, startDate, endDate, reason });
      setReason('');
      await loadData();
    } catch { alert('Failed to submit leave request'); }
    setSubmitting(false);
  };

  const getDays = (start: string, end: string) => Math.max(1, Math.ceil((new Date(end).getTime() - new Date(start).getTime()) / (1000 * 3600 * 24)) + 1);

  const casualTaken = history.filter(h => h.leaveType === 'Casual' && h.status === 'APPROVED').reduce((acc, h) => acc + getDays(h.startDate, h.endDate), 0);
  const sickTaken = history.filter(h => h.leaveType === 'Sick' && h.status === 'APPROVED').reduce((acc, h) => acc + getDays(h.startDate, h.endDate), 0);
  const earnedTaken = history.filter(h => h.leaveType === 'Earned' && h.status === 'APPROVED').reduce((acc, h) => acc + getDays(h.startDate, h.endDate), 0);
  const pendingCount = history.filter(h => h.status === 'PENDING').length;

  return (
    <>
      <Topbar title="Leave Request" subtitle="Apply for leave and view history" />
      <div style={{ padding: '24px 32px' }}>
        <div className="grid grid-4 gap-4 mb-6">
          {[
            { l: 'Casual Leave', v: `${casualTaken}/12`, c: '#5048E5' }, 
            { l: 'Sick Leave', v: `${sickTaken}/10`, c: '#10B981' }, 
            { l: 'Earned Leave', v: `${earnedTaken}/15`, c: '#F59E0B' }, 
            { l: 'Pending', v: String(pendingCount), c: '#EF4444' }
          ].map(s => (
            <div key={s.l} className="stat-card" style={{ borderLeftColor: s.c }}>
              <div className="stat-icon" style={{ background: s.c + '15', color: s.c }}><span className="icon">event_busy</span></div>
              <div><div className="stat-value">{s.v}</div><div className="stat-label">{s.l}</div></div>
            </div>
          ))}
        </div>

        <div className="grid grid-2 gap-6">
          <div className="card"><div className="card-body">
            <h3 className="mb-4"><span className="icon icon-sm text-primary">add_circle</span> New Leave Request</h3>
            <div className="input-group"><label className="input-label">Leave Type</label>
              <select className="select" value={leaveType} onChange={e => setLeaveType(e.target.value)}><option value="Casual">Casual Leave</option><option value="Sick">Sick Leave</option><option value="Earned">Earned Leave</option><option value="Half Day">Half Day</option></select>
            </div>
            <div className="grid grid-2 gap-4">
              <div className="input-group"><label className="input-label">From Date</label><input className="input" type="date" value={startDate} onChange={e => setStartDate(e.target.value)} /></div>
              <div className="input-group"><label className="input-label">To Date</label><input className="input" type="date" value={endDate} onChange={e => setEndDate(e.target.value)} /></div>
            </div>
            <div className="input-group"><label className="input-label">Reason</label><textarea className="input" rows={3} placeholder="Enter reason for leave..." style={{ resize: 'vertical' }} value={reason} onChange={e => setReason(e.target.value)}></textarea></div>
            <button className="btn btn-primary w-full" style={{ justifyContent: 'center' }} onClick={submit} disabled={submitting}><span className="icon icon-sm">{submitting ? 'hourglass_empty' : 'send'}</span>{submitting ? 'Submitting...' : 'Submit Request'}</button>
          </div></div>

          <div className="card"><div className="card-body">
            <h3 className="mb-4"><span className="icon icon-sm text-primary">history</span> Leave History</h3>
            {loading ? <div className="text-center py-8 text-gray">Loading history...</div> : history.length === 0 ? <div className="text-center py-8 text-gray">No leave requests found.</div> : history.map((l, i) => (
              <div key={l.id || i} style={{ padding: '12px 0', borderBottom: i < history.length - 1 ? '1px solid var(--gray-100)' : 'none' }}>
                <div className="flex items-center justify-between"><span className="font-semibold" style={{ fontSize: '0.875rem' }}>{l.leaveType} Leave</span><span className={`badge ${l.status === 'APPROVED' ? 'badge-success' : l.status === 'REJECTED' ? 'badge-danger' : 'badge-warning'}`}>{l.status || 'Draft'}</span></div>
                <div className="text-sm text-gray mt-1">{new Date(l.startDate).toLocaleDateString()} — {new Date(l.endDate).toLocaleDateString()}</div>
                <div className="text-xs text-gray mt-1">{l.reason}</div>
              </div>
            ))}
          </div></div>
        </div>
      </div>
    </>
  );
}
