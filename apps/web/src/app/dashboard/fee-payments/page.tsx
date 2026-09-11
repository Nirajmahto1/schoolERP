'use client';
import Topbar from '@/components/Topbar';
import { useState, useEffect, useCallback } from 'react';
import { feeApi } from '@/lib/api';
import { useLoading } from '@/context/LoadingContext';

export default function FeePaymentsPage() {
  const { startLoading, stopLoading } = useLoading();
  const [invoices, setInvoices] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [payingId, setPayingId] = useState<string | null>(null);
  const [payForm, setPayForm] = useState({ amount: '', mode: 'Cash', date: new Date().toISOString().split('T')[0] });
  const [processing, setProcessing] = useState(false);

  const fetchInvoices = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Phase 2.5: InvoiceStatus is DRAFT | ISSUED | PARTIALLY_PAID | PAID.
      const result = await feeApi.getInvoices({ limit: 50, status: 'ISSUED' });
      const partial = await feeApi.getInvoices({ limit: 50, status: 'PARTIALLY_PAID' });
      setInvoices([...result.data, ...partial.data]);
    } catch (err: any) {
      setError(err?.detail || err?.message || 'Failed to load invoices. Please ensure the backend is running.');
      setInvoices([]);
    }
    setLoading(false);
  }, []);

  useEffect(() => { fetchInvoices(); }, [fetchInvoices]);

  const recordPayment = async (inv: any) => {
    const amount = parseFloat(payForm.amount) || 0;
    if (amount <= 0) { alert('Please enter a valid payment amount.'); return; }
    setProcessing(true);
    startLoading('Processing payment...');
    try {
      // Phase 2.5 payment contract: studentId + academicYearId + amount + method
      // (+ invoiceIds for explicit allocation); the route rejects invoiceId alone.
      await feeApi.recordPayment({
        studentId: inv.studentId,
        academicYearId: inv.academicYearId,
        amount,
        method: payForm.mode.toUpperCase(),
        invoiceIds: [inv.id],
      });
      await fetchInvoices();
    } catch (err: any) { alert(err.detail || 'Payment failed. Please try again.'); }
    setPayingId(null);
    setPayForm({ amount: '', mode: 'Cash', date: new Date().toISOString().split('T')[0] });
    setProcessing(false);
    stopLoading();
  };

  const totalPending = invoices.reduce((s, i) => s + (Number(i.totalAmount) - Number(i.paidAmount || 0)), 0);

  const statusBadge = (status: string) => {
    const map: Record<string, string> = { PAID: 'badge-success', ISSUED: 'badge-warning', PARTIALLY_PAID: 'badge-primary', DRAFT: 'badge-gray', OVERDUE: 'badge-danger' };
    return map[status] || 'badge-gray';
  };

  return (
    <>
      <Topbar title="Fee Payments" subtitle="Collect and record student fee payments" />
      <div style={{ padding: '24px 32px' }}>
        <div className="grid grid-3 gap-4 mb-6">
          {[
            { l: 'Total Pending', v: `₹${totalPending.toLocaleString('en-IN')}`, c: '#F59E0B' },
            { l: 'Pending Invoices', v: String(invoices.filter(i => i.status === 'ISSUED').length), c: '#5048E5' },
            { l: 'Overdue', v: String(invoices.filter(i => i.status === 'OVERDUE').length), c: '#EF4444' },
          ].map(s => (
            <div key={s.l} className="stat-card" style={{ borderLeftColor: s.c }}><div className="stat-icon" style={{ background: s.c + '15', color: s.c }}><span className="icon">payments</span></div><div><div className="stat-value">{s.v}</div><div className="stat-label">{s.l}</div></div></div>
          ))}
        </div>

        {payingId && (
          <div className="card mb-4 animate-fadeIn"><div className="card-body">
            <h3 className="mb-4">Record Payment — {invoices.find(i => i.id === payingId)?.student?.firstName} {invoices.find(i => i.id === payingId)?.student?.lastName}</h3>
            <div className="grid grid-3 gap-4">
              <div className="input-group"><label className="input-label">Amount (₹)</label><input className="input" type="number" value={payForm.amount} onChange={e => setPayForm({ ...payForm, amount: e.target.value })} /></div>
              <div className="input-group"><label className="input-label">Payment Mode</label><select className="select" value={payForm.mode} onChange={e => setPayForm({ ...payForm, mode: e.target.value })}><option>Cash</option><option>UPI</option><option>Bank Transfer</option><option>Cheque</option><option>Online</option></select></div>
              <div className="input-group"><label className="input-label">Date</label><input className="input" type="date" value={payForm.date} onChange={e => setPayForm({ ...payForm, date: e.target.value })} /></div>
            </div>
            <div className="flex gap-3 mt-4">
              <button className="btn btn-success" disabled={processing} onClick={() => recordPayment(invoices.find(i => i.id === payingId))}>
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
            <p style={{ marginTop: 12, color: '#6B7280' }}>Loading pending payments...</p>
          </div>
        ) : !error && (
          <div className="card">
            <div className="table-wrapper"><table className="table"><thead><tr><th>Invoice</th><th>Student</th><th>Fee Type</th><th>Total</th><th>Paid</th><th>Balance</th><th>Due Date</th><th>Status</th><th>Action</th></tr></thead><tbody>
              {invoices.map(inv => {
                const balance = Number(inv.totalAmount) - Number(inv.paidAmount || 0);
                return (
                  <tr key={inv.id}>
                    <td className="text-sm font-semibold text-primary">{inv.invoiceNo}</td>
                    <td><div className="flex items-center gap-3"><div className="avatar avatar-sm">{inv.student?.firstName?.[0]}{inv.student?.lastName?.[0]}</div><span className="font-semibold">{inv.student?.firstName} {inv.student?.lastName}</span></div></td>
                    <td className="text-sm">{inv.lines?.find?.((l: any) => l.feeHeadId)?.feeHead?.name || inv.lines?.[0]?.feeHead?.name || 'Tuition'}</td>
                    <td className="font-semibold">₹{Number(inv.totalAmount).toLocaleString('en-IN')}</td>
                    <td className="text-sm">₹{Number(inv.paidAmount || 0).toLocaleString('en-IN')}</td>
                    <td className="font-semibold" style={{ color: '#EF4444' }}>₹{balance.toLocaleString('en-IN')}</td>
                    <td className="text-sm">{new Date(inv.dueDate).toLocaleDateString('en-IN')}</td>
                    <td><span className={`badge ${statusBadge(inv.status)}`}>{inv.status}</span></td>
                    <td>
                      <button className="btn btn-sm btn-success" onClick={() => {
                        setPayingId(inv.id);
                        setPayForm({ ...payForm, amount: String(balance) });
                      }}><span className="icon icon-sm">payment</span>Pay Now</button>
                    </td>
                  </tr>
                );
              })}
              {invoices.length === 0 && <tr><td colSpan={9} style={{ textAlign: 'center', padding: 24, color: '#9CA3AF' }}>No pending payments found</td></tr>}
            </tbody></table></div>
          </div>
        )}
      </div>
    </>
  );
}
