'use client';
import Topbar from '@/components/Topbar';
import { useState, useEffect, useCallback } from 'react';
import { feeApi } from '@/lib/api';
import { useLoading } from '@/context/LoadingContext';

export default function FeesPage() {
  const { startLoading, stopLoading } = useLoading();
  const [invoices, setInvoices] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('All');
  const [payingId, setPayingId] = useState<string | null>(null);
  const [payForm, setPayForm] = useState({ amount: '', mode: 'Cash', date: new Date().toISOString().split('T')[0] });
  const [processing, setProcessing] = useState(false);

  const fetchInvoices = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params: any = { limit: 50 };
      if (statusFilter !== 'All') params.status = statusFilter;
      const result = await feeApi.getInvoices(params);
      setInvoices(result.data);
    } catch (err: any) {
      setError(err?.detail || err?.message || 'Failed to load invoices. Please ensure the backend is running.');
      setInvoices([]);
    }
    setLoading(false);
  }, [statusFilter]);

  useEffect(() => { fetchInvoices(); }, [fetchInvoices]);

  const filtered = invoices.filter(inv => {
    const name = `${inv.student?.firstName || ''} ${inv.student?.lastName || ''}`.toLowerCase();
    const matchSearch = name.includes(search.toLowerCase()) || inv.invoiceNo.toLowerCase().includes(search.toLowerCase());
    const matchStatus = statusFilter === 'All' || inv.status === statusFilter;
    return matchSearch && matchStatus;
  });

  const recordPayment = async (inv: any) => {
    const amount = parseFloat(payForm.amount) || 0;
    if (amount <= 0) { alert('Please enter a valid payment amount.'); return; }
    setProcessing(true);
    startLoading('Processing payment...');
    try {
      // Phase 2.5 payment contract: studentId + academicYearId + amount + method.
      // The engine allocates across open invoices when invoiceIds is omitted.
      await feeApi.recordPayment({
        studentId: inv.studentId,
        academicYearId: inv.academicYearId,
        amount,
        method: payForm.mode.toUpperCase(),
        invoiceIds: [inv.id],
      });
      await fetchInvoices();
    } catch (err: any) { alert(err.detail || 'Payment failed'); }
    setPayingId(null);
    setPayForm({ amount: '', mode: 'Cash', date: new Date().toISOString().split('T')[0] });
    setProcessing(false);
    stopLoading();
  };

  const collected = invoices.reduce((s, i) => s + Number(i.paidAmount || 0), 0);
  const pending = invoices.filter(i => ['PENDING', 'PARTIAL'].includes(i.status)).reduce((s, i) => s + Number(i.totalAmount) - Number(i.paidAmount || 0), 0);
  const overdue = invoices.filter(i => i.status === 'OVERDUE').reduce((s, i) => s + Number(i.totalAmount) - Number(i.paidAmount || 0), 0);

  const statusBadge = (status: string) => {
    const map: Record<string, string> = { PAID: 'badge-success', PENDING: 'badge-warning', OVERDUE: 'badge-danger', PARTIAL: 'badge-primary' };
    return map[status] || 'badge-gray';
  };

  return (
    <>
      <Topbar title="Fee Management" subtitle="Fee collection and invoice management" />
      <div style={{ padding: '24px 32px' }}>
        <div className="grid grid-4 gap-4 mb-6">
          {[
            { l: 'Total Collected', v: `₹${(collected).toLocaleString('en-IN')}`, c: '#10B981' },
            { l: 'Pending', v: `₹${pending.toLocaleString('en-IN')}`, c: '#F59E0B' },
            { l: 'Overdue', v: `₹${overdue.toLocaleString('en-IN')}`, c: '#EF4444' },
            { l: 'Total Invoices', v: String(invoices.length), c: '#5048E5' },
          ].map(s => (
            <div key={s.l} className="stat-card" style={{ borderLeftColor: s.c }}><div className="stat-icon" style={{ background: s.c + '15', color: s.c }}><span className="icon">receipt_long</span></div><div><div className="stat-value">{s.v}</div><div className="stat-label">{s.l}</div></div></div>
          ))}
        </div>

        <div className="flex gap-3 mb-4 items-center" style={{ flexWrap: 'wrap' }}>
          <div className="search-bar"><span className="icon">search</span><input placeholder="Search student or invoice..." value={search} onChange={e => setSearch(e.target.value)} /></div>
          <select className="select" style={{ width: 130 }} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
            <option value="All">All Status</option><option value="PENDING">Pending</option><option value="PAID">Paid</option><option value="OVERDUE">Overdue</option><option value="PARTIAL">Partial</option>
          </select>
        </div>

        {payingId && (
          <div className="card mb-4 animate-fadeIn"><div className="card-body">
            <h3 className="mb-4">Record Payment — {invoices.find(i => i.id === payingId)?.student?.firstName} {invoices.find(i => i.id === payingId)?.student?.lastName}</h3>
            <div className="grid grid-3 gap-4">
              <div className="input-group"><label className="input-label">Amount</label><input className="input" type="number" value={payForm.amount} onChange={e => setPayForm({ ...payForm, amount: e.target.value })} /></div>
              <div className="input-group"><label className="input-label">Payment Mode</label><select className="select" value={payForm.mode} onChange={e => setPayForm({ ...payForm, mode: e.target.value })}><option>Cash</option><option>UPI</option><option>Bank Transfer</option><option>Cheque</option><option>Online</option></select></div>
              <div className="input-group"><label className="input-label">Date</label><input className="input" type="date" value={payForm.date} onChange={e => setPayForm({ ...payForm, date: e.target.value })} /></div>
            </div>
            <div className="flex gap-3 mt-4">
              <button className="btn btn-success" onClick={() => recordPayment(invoices.find(i => i.id === payingId))} disabled={processing}>
                <span className="icon icon-sm">{processing ? 'hourglass_empty' : 'check_circle'}</span>{processing ? 'Processing...' : 'Confirm Payment'}
              </button>
              <button className="btn btn-secondary" onClick={() => setPayingId(null)}>Cancel</button>
            </div>
          </div></div>
        )}

        {error && (
          <div className="card mb-4" style={{ padding: 24, background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 12 }}>
            <div className="flex items-center gap-3">
              <span className="icon" style={{ color: '#EF4444' }}>error</span>
              <div><div style={{ fontWeight: 600, color: '#991B1B' }}>Connection Error</div><div style={{ fontSize: 14, color: '#B91C1C' }}>{error}</div></div>
              <button className="btn btn-sm btn-secondary" style={{ marginLeft: 'auto' }} onClick={fetchInvoices}><span className="icon icon-sm">refresh</span>Retry</button>
            </div>
          </div>
        )}

        {loading ? (
          <div className="card" style={{ padding: 48, textAlign: 'center' }}>
            <span className="icon" style={{ fontSize: 32, color: '#5048E5', animation: 'spin 1s linear infinite' }}>progress_activity</span>
            <p style={{ marginTop: 12, color: '#6B7280' }}>Loading invoices...</p>
          </div>
        ) : !error && (
          <div className="card">
            <div className="table-wrapper"><table className="table"><thead><tr><th>Invoice</th><th>Student</th><th>Fee Type</th><th>Amount</th><th>Due Date</th><th>Status</th><th>Actions</th></tr></thead><tbody>
              {filtered.map(inv => (
                <tr key={inv.id}>
                  <td className="text-sm font-semibold text-primary">{inv.invoiceNo}</td>
                  <td><div className="flex items-center gap-3"><div className="avatar avatar-sm">{inv.student?.firstName?.[0]}{inv.student?.lastName?.[0]}</div><span className="font-semibold">{inv.student?.firstName} {inv.student?.lastName}</span></div></td>
                  <td className="text-sm">{inv.items?.[0]?.feeStructure?.name || 'Tuition'}</td>
                  <td className="font-semibold">₹{Number(inv.totalAmount).toLocaleString('en-IN')}</td>
                  <td className="text-sm">{new Date(inv.dueDate).toLocaleDateString('en-IN')}</td>
                  <td><span className={`badge ${statusBadge(inv.status)}`}>{inv.status}</span></td>
                  <td>
                    {['PENDING', 'PARTIAL', 'OVERDUE'].includes(inv.status) ? (
                      <button className="btn btn-sm btn-success" onClick={() => {
                        setPayingId(inv.id);
                        setPayForm({ ...payForm, amount: String(Number(inv.totalAmount) - Number(inv.paidAmount)) });
                      }}><span className="icon icon-sm">payment</span>Pay</button>
                    ) : (
                      <button className="btn btn-sm btn-ghost"><span className="icon icon-sm">receipt</span>Receipt</button>
                    )}
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && <tr><td colSpan={7} style={{ textAlign: 'center', padding: 24, color: '#9CA3AF' }}>No invoices found</td></tr>}
            </tbody></table></div>
          </div>
        )}
      </div>
    </>
  );
}
