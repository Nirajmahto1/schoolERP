'use client';
import Topbar from '@/components/Topbar';
import { useState, useEffect, useCallback } from 'react';
import { feeApi } from '@/lib/api';
import { useLoading } from '@/context/LoadingContext';

// Gateway base for direct file downloads (the receipt PDF is binary, so it
// bypasses the JSON apiRequest helper and streams via fetch + blob).
const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api/v1';

function authHeaders(): HeadersInit {
  if (typeof window === 'undefined') return {};
  const token = window.localStorage.getItem('erp_token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

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

  // 4.1.4: find the most recent SUCCESS payment on this invoice, then open
  // its rendered PDF. The PDF renders (and caches) on first fetch.
  const openReceipt = async (invoiceId: string) => {
    startLoading('Opening receipt...');
    try {
      const { data } = await feeApi.getInvoiceReceipt(invoiceId);
      if (!data?.length) { alert('No successful payment found for this invoice yet.'); return; }
      const res = await fetch(`${API_BASE}/fees/payments/${data[0].id}/receipt.pdf`, { headers: authHeaders() });
      if (!res.ok) { alert('Could not render the receipt. Please try again.'); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err: any) { alert(err?.detail || 'Failed to open receipt.'); }
    finally { stopLoading(); }
  };

  // 4.1.4: queue the receipt to the guardians' email + WhatsApp.
  const sendReceipt = async (invoiceId: string) => {
    startLoading('Sending receipt...');
    try {
      const { data } = await feeApi.getInvoiceReceipt(invoiceId);
      if (!data?.length) { alert('No successful payment found for this invoice yet.'); return; }
      const result = await feeApi.sendReceipt(data[0].id);
      alert(`Receipt queued to ${result.guardians} guardian(s) over ${result.channels.join(' + ')}.`);
    } catch (err: any) { alert(err?.detail || 'Failed to send receipt.'); }
    finally { stopLoading(); }
  };

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

  // ── Razorpay checkout (BUILD_PLAN 4.1) ──
  // order → open Razorpay's modal → the browser hands back the signature →
  // /checkout/verify captures server-side. The webhook may also arrive first;
  // capture is idempotent, so both paths credit exactly once.
  const payOnline = async (inv: any) => {
    setProcessing(true);
    startLoading('Opening Razorpay checkout...');
    try {
      const order = await feeApi.createCheckoutOrder({
        studentId: inv.studentId,
        academicYearId: inv.academicYearId,
        invoiceIds: [inv.id],
      });
      stopLoading();
      const w = window as unknown as { Razorpay?: new (opts: Record<string, unknown>) => { open: () => void } };
      if (!w.Razorpay) {
        alert('Razorpay checkout is not loaded. Add the checkout script to app/layout.tsx and set NEXT_PUBLIC_RAZORPAY_KEY_ID.');
        setProcessing(false);
        return;
      }
      const rzp = new w.Razorpay({
        key: order.keyId ?? process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID,
        amount: order.amount * 100,
        currency: order.currency,
        name: 'School Fees',
        description: `Invoice ${inv.invoiceNo}`,
        order_id: order.orderId,
        prefill: { name: `${inv.student?.firstName ?? ''} ${inv.student?.lastName ?? ''}`.trim() },
        theme: { color: '#5048E5' },
        handler: async (response: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }) => {
          startLoading('Verifying payment...');
          try {
            const result = await feeApi.verifyCheckout(response);
            if (result.captured) {
              alert(`Payment captured — receipt ${result.payment?.receiptNo ?? ''}`);
              await fetchInvoices();
            } else {
              alert(result.reason === 'ALREADY_CAPTURED' ? 'This payment was already recorded.' : `Verification failed: ${result.reason ?? 'unknown'}`);
            }
          } catch (err: any) {
            alert(err?.detail || 'Payment verification failed. The reconciliation job will pick it up if money was captured.');
          }
          stopLoading();
        },
        modal: { ondismiss: () => setProcessing(false) },
      });
      rzp.open();
    } catch (err: any) {
      alert(err?.detail || 'Could not start the online payment. Razorpay may not be configured on this deployment.');
      setProcessing(false);
    }
    stopLoading();
  };

  const collected = invoices.reduce((s, i) => s + Number(i.paidAmount || 0), 0);
  // Phase 2.5 statuses: DRAFT | ISSUED | PARTIALLY_PAID | PAID.
  const pending = invoices.filter(i => ['ISSUED', 'PARTIALLY_PAID'].includes(i.status)).reduce((s, i) => s + Number(i.totalAmount) - Number(i.paidAmount || 0), 0);
  const overdue = invoices.filter(i => i.status !== 'PAID' && new Date(i.dueDate) < new Date()).reduce((s, i) => s + Number(i.totalAmount) - Number(i.paidAmount || 0), 0);

  const statusBadge = (status: string) => {
    const map: Record<string, string> = { PAID: 'badge-success', ISSUED: 'badge-warning', PARTIALLY_PAID: 'badge-primary', DRAFT: 'badge-gray' };
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
            <option value="All">All Status</option><option value="ISSUED">Issued</option><option value="PARTIALLY_PAID">Partial</option><option value="PAID">Paid</option><option value="DRAFT">Draft</option>
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
              <button className="btn btn-primary" onClick={() => payOnline(invoices.find(i => i.id === payingId))} disabled={processing}>
                <span className="icon icon-sm">account_balance_wallet</span>Pay Online (Razorpay)
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
            <div className="table-wrapper"><table className="table"><thead><tr><th>Invoice</th><th>Student</th><th>Fee Type</th><th>Amount</th><th>Paid</th><th>Due Date</th><th>Status</th><th>Actions</th></tr></thead><tbody>
              {filtered.map(inv => (
                <tr key={inv.id}>
                  <td className="text-sm font-semibold text-primary">{inv.invoiceNo}</td>
                  <td><div className="flex items-center gap-3"><div className="avatar avatar-sm">{inv.student?.firstName?.[0]}{inv.student?.lastName?.[0]}</div><span className="font-semibold">{inv.student?.firstName} {inv.student?.lastName}</span></div></td>
                  <td className="text-sm">{inv.lines?.[0]?.feeHead?.name || 'Tuition'}</td>
                  <td className="font-semibold">₹{Number(inv.totalAmount).toLocaleString('en-IN')}</td>
                  <td className="text-sm">₹{Number(inv.paidAmount || 0).toLocaleString('en-IN')}</td>
                  <td className="text-sm">{new Date(inv.dueDate).toLocaleDateString('en-IN')}</td>
                  <td><span className={`badge ${statusBadge(inv.status)}`}>{inv.status}</span></td>
                  <td>
                    {['ISSUED', 'PARTIALLY_PAID'].includes(inv.status) ? (
                      <button className="btn btn-sm btn-success" onClick={() => {
                        setPayingId(inv.id);
                        setPayForm({ ...payForm, amount: String(Number(inv.totalAmount) - Number(inv.paidAmount)) });
                      }}><span className="icon icon-sm">payment</span>Pay</button>
                    ) : (
                      <span className="flex gap-2">
                        <button className="btn btn-sm btn-ghost" onClick={() => openReceipt(inv.id)}><span className="icon icon-sm">receipt</span>Receipt</button>
                        <button className="btn btn-sm btn-secondary" onClick={() => sendReceipt(inv.id)} title="Email + WhatsApp to guardians"><span className="icon icon-sm">send</span>Send</button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && <tr><td colSpan={8} style={{ textAlign: 'center', padding: 24, color: '#9CA3AF' }}>No invoices found</td></tr>}
            </tbody></table></div>
          </div>
        )}
      </div>
    </>
  );
}
