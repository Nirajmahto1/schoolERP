'use client';
import Topbar from '@/components/Topbar';
import { useState, useEffect, useCallback } from 'react';
import { feeApi, API_BASE } from '@/lib/api';
import { useLoading } from '@/context/LoadingContext';

function authHeaders(): HeadersInit {
  if (typeof window === 'undefined') return {};
  const token = window.localStorage.getItem('erp_token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export default function FeePaymentsPage() {
  const { startLoading, stopLoading } = useLoading();
  const [invoices, setInvoices] = useState<any[]>([]);
  const [payments, setPayments] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [payingId, setPayingId] = useState<string | null>(null);
  const [payForm, setPayForm] = useState({ amount: '', mode: 'Cash', date: new Date().toISOString().split('T')[0] });
  const [processing, setProcessing] = useState(false);

  // ── Online collection (BUILD_PLAN 4.1) ──
  const [onlineFor, setOnlineFor] = useState<any>(null);
  const [onlineAmount, setOnlineAmount] = useState<number | null>(null);
  const [onlineBusy, setOnlineBusy] = useState(false);
  const [onlineResult, setOnlineResult] = useState<{ ok: boolean; msg: string } | null>(null);

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

  const fetchPayments = useCallback(async () => {
    try {
      // Success payments of the last 30 days — the accountant's collection feed.
      const { data } = await feeApi.getPayments({ status: 'SUCCESS', limit: 20 });
      setPayments(data ?? []);
    } catch { /* the table below hides itself when empty */ }
  }, []);

  useEffect(() => { fetchInvoices(); fetchPayments(); }, [fetchInvoices, fetchPayments]);

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
      await Promise.all([fetchInvoices(), fetchPayments()]);
    } catch (err: any) { alert(err.detail || 'Payment failed. Please try again.'); }
    setPayingId(null);
    setPayForm({ amount: '', mode: 'Cash', date: new Date().toISOString().split('T')[0] });
    setProcessing(false);
    stopLoading();
  };

  // 4.1 online path: server mints a Razorpay order for the student's open
  // dues; the amount always comes from the DB, never from the client. When
  // Razorpay is not configured, /orders answers 503 and we say so honestly.
  const startOnlineCollection = async (inv: any) => {
    setOnlineFor(inv);
    setOnlineResult(null);
    setOnlineBusy(true);
    try {
      const order = await feeApi.createCheckoutOrder({ studentId: inv.studentId });
      setOnlineAmount(order.amount);
      setOnlineFor({ ...inv, order });
    } catch (err: any) {
      setOnlineResult({ ok: false, msg: err?.detail || 'Could not create the payment order.' });
      setOnlineAmount(null);
    }
    setOnlineBusy(false);
  };

  const confirmOnlineCollected = async () => {
    if (!onlineFor?.order) return;
    setOnlineBusy(true);
    try {
      const checked = await feeApi.runReconcile();
      const hit = checked.captured?.find((c) => c.paymentId === onlineFor.order.paymentId);
      setOnlineResult(hit
        ? { ok: true, msg: `Captured. Receipt issued — payment ${onlineFor.order.orderId} is settled.` }
        : { ok: false, msg: `No captured payment yet for ${onlineFor.order.orderId}. The parent hasn't completed checkout (or the webhook hasn't landed — the reconcile job will pick it up).` });
      if (hit) await Promise.all([fetchInvoices(), fetchPayments()]);
    } catch (err: any) {
      setOnlineResult({ ok: false, msg: err?.detail || 'Reconcile failed — try again.' });
    }
    setOnlineBusy(false);
  };

  const refundPayment = async (p: any) => {
    if (!confirm(`Refund the ₹${Number(p.amount).toLocaleString('en-IN')} online payment ${p.gatewayPaymentId || ''} back through Razorpay? This posts reversal ledger entries.`)) return;
    startLoading('Refunding via gateway...');
    try {
      const res = await fetch(`${API_BASE}/fees/refunds/gateway`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ paymentId: p.id, reason: 'Refunded from fee-payments console' }),
      });
      if (res.ok) { await fetchPayments(); await fetchInvoices(); }
      else { const j = await res.json().catch(() => ({})); alert(j.detail || 'Refund failed.'); }
    } catch { alert('Refund failed — network error.'); }
    stopLoading();
  };

  const openReceipt = async (paymentId: string) => {
    startLoading('Opening receipt...');
    try {
      const res = await fetch(`${API_BASE}/fees/payments/${paymentId}/receipt.pdf`, { headers: authHeaders() });
      if (!res.ok) { alert('Could not render the receipt.'); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } finally { stopLoading(); }
  };

  const totalPending = invoices.reduce((s, i) => s + (Number(i.totalAmount) - Number(i.paidAmount || 0)), 0);
  const onlineToday = payments.filter((p) => p.gatewayProvider === 'RAZORPAY' && p.paidAt && new Date(p.paidAt).toDateString() === new Date().toDateString());
  const onlineCollectedToday = onlineToday.reduce((s, p) => s + Number(p.amount), 0);

  const statusBadge = (status: string) => {
    const map: Record<string, string> = { PAID: 'badge-success', ISSUED: 'badge-warning', PARTIALLY_PAID: 'badge-primary', DRAFT: 'badge-gray', OVERDUE: 'badge-danger' };
    return map[status] || 'badge-gray';
  };

  const methodBadge = (p: any) => {
    if (p.gatewayProvider === 'RAZORPAY') return <span className="badge badge-primary" title={p.gatewayPaymentId || ''}>Online · UPI/Card</span>;
    if (p.method === 'CHEQUE') return <span className="badge badge-gray">Cheque</span>;
    if (p.method === 'BANK_TRANSFER') return <span className="badge badge-gray">Bank</span>;
    return <span className="badge badge-gray">{p.method}</span>;
  };

  return (
    <>
      <Topbar title="Fee Payments" subtitle="Collect and record student fee payments — cash at the desk or online via Razorpay" />
      <div style={{ padding: '24px 32px' }}>
        <div className="grid grid-4 gap-4 mb-6">
          {[
            { l: 'Total Pending', v: `₹${totalPending.toLocaleString('en-IN')}`, c: '#F59E0B' },
            { l: 'Pending Invoices', v: String(invoices.filter(i => i.status === 'ISSUED').length), c: '#5048E5' },
            { l: 'Overdue', v: String(invoices.filter(i => i.status === 'OVERDUE').length), c: '#EF4444' },
            { l: 'Online Collected Today', v: `₹${onlineCollectedToday.toLocaleString('en-IN')}`, c: '#10B981' },
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
          <>
            <div className="card">
              <div style={{ padding: '16px 20px 0' }}><h3>Pending Invoices</h3></div>
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
                        <div className="flex gap-2">
                          <button className="btn btn-sm btn-success" onClick={() => {
                            setPayingId(inv.id);
                            setPayForm({ ...payForm, amount: String(balance) });
                          }}><span className="icon icon-sm">payments</span>Collect</button>
                          <button className="btn btn-sm btn-secondary" title="Send a Razorpay payment link — the parent pays online" onClick={() => startOnlineCollection(inv)}>
                            <span className="icon icon-sm">credit_card</span>Online
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {invoices.length === 0 && <tr><td colSpan={9} style={{ textAlign: 'center', padding: 24, color: '#9CA3AF' }}>No pending payments found</td></tr>}
              </tbody></table></div>
            </div>

            <div className="card mt-4">
              <div style={{ padding: '16px 20px 0' }}><h3>Recent Payments</h3></div>
              <div className="table-wrapper"><table className="table"><thead><tr><th>Receipt</th><th>Student</th><th>Amount</th><th>Method</th><th>Status</th><th>Paid At</th><th>Gateway Ref</th><th>Actions</th></tr></thead><tbody>
                {payments.map(p => (
                  <tr key={p.id}>
                    <td className="text-sm font-semibold text-primary">{p.receiptNo || '—'}</td>
                    <td className="text-sm font-semibold">{p.student?.firstName} {p.student?.lastName}</td>
                    <td className="font-semibold">₹{Number(p.amount).toLocaleString('en-IN')}</td>
                    <td>{methodBadge(p)}</td>
                    <td><span className={`badge ${p.status === 'SUCCESS' ? 'badge-success' : 'badge-warning'}`}>{p.status}</span></td>
                    <td className="text-sm">{p.paidAt ? new Date(p.paidAt).toLocaleString('en-IN') : '—'}</td>
                    <td className="text-sm" style={{ fontFamily: 'monospace', fontSize: 12 }}>{p.gatewayPaymentId || '—'}</td>
                    <td>
                      <div className="flex gap-2">
                        <button className="btn btn-sm btn-secondary" onClick={() => openReceipt(p.id)}><span className="icon icon-sm">picture_as_pdf</span>Receipt</button>
                        {p.gatewayProvider === 'RAZORPAY' && (
                          <button className="btn btn-sm" style={{ color: '#EF4444' }} onClick={() => refundPayment(p)}><span className="icon icon-sm">undo</span>Refund</button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
                {payments.length === 0 && <tr><td colSpan={8} style={{ textAlign: 'center', padding: 24, color: '#9CA3AF' }}>No payments recorded yet</td></tr>}
              </tbody></table></div>
            </div>
          </>
        )}

        {onlineFor && (
          <div className="card mt-4 animate-fadeIn" style={{ borderLeft: '4px solid #5048E5' }}>
            <div className="card-body">
              <h3 className="mb-2">Online Collection — {onlineFor.student?.firstName} {onlineFor.student?.lastName}</h3>
              {!onlineResult && (
                onlineBusy ? (
                  <p style={{ color: '#6B7280' }}><span className="icon icon-sm">hourglass_empty</span> Creating the Razorpay order for the open dues…</p>
                ) : (
                  <>
                    <p style={{ color: '#374151', marginBottom: 12 }}>
                      Razorpay order <strong style={{ fontFamily: 'monospace' }}>{onlineFor.order?.orderId}</strong> for
                      <strong> ₹{Number(onlineAmount ?? 0).toLocaleString('en-IN')}</strong> is live against the student&apos;s open invoices.
                      The parent completes checkout from the app/portal — a webhook captures it, allocation runs, and the receipt number is minted automatically.
                    </p>
                    <div className="flex gap-3">
                      <button className="btn btn-primary" disabled={onlineBusy} onClick={confirmOnlineCollected}>
                        <span className="icon icon-sm">{onlineBusy ? 'hourglass_empty' : 'fact_check'}</span>{onlineBusy ? 'Checking…' : 'Parent paid — check & capture'}
                      </button>
                      <button className="btn btn-secondary" onClick={() => { setOnlineFor(null); setOnlineResult(null); }}>Close</button>
                    </div>
                  </>
                )
              )}
              {onlineResult && (
                <>
                  <div style={{ padding: 12, borderRadius: 8, background: onlineResult.ok ? '#ECFDF5' : '#FFFBEB', border: `1px solid ${onlineResult.ok ? '#A7F3D0' : '#FDE68A'}`, color: onlineResult.ok ? '#065F46' : '#92400E', marginBottom: 12 }}>
                    {onlineResult.msg}
                  </div>
                  <button className="btn btn-secondary" onClick={() => { setOnlineFor(null); setOnlineResult(null); }}>Done</button>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
