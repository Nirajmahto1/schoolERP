'use client';
import Topbar from '@/components/Topbar';
import { useState, useEffect, useCallback, Fragment } from 'react';
import { feeApi, studentApi, API_BASE } from '@/lib/api';
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

  // ── Razorpay settlements (§4.1.6) ──
  const [tab, setTab] = useState<'collections' | 'settlements' | 'counter'>('collections');
  const [settleFrom, setSettleFrom] = useState(() => { const d = new Date(); d.setDate(1); return d.toISOString().split('T')[0]; });
  const [settleTo, setSettleTo] = useState(() => new Date().toISOString().split('T')[0]);
  const [settleDays, setSettleDays] = useState<any[]>([]);
  const [settleTotals, setSettleTotals] = useState<{ count: number; gross: number; netCredited: number } | null>(null);
  const [settleLoading, setSettleLoading] = useState(false);
  const [settleError, setSettleError] = useState<string | null>(null);
  const [openDay, setOpenDay] = useState<string | null>(null);

  // ── Late fees + advance collection (counter features) ──
  const [lfRules, setLfRules] = useState<any[]>([]);
  const [lfForm, setLfForm] = useState({ label: '', minDays: '', maxDays: '', amount: '', isPercent: false });
  const [lfBusy, setLfBusy] = useState(false);
  const [lfMsg, setLfMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [lfReport, setLfReport] = useState<Array<{ studentId: string; invoiceNo: string; rule: string; amount: number; daysOverdue: number }> | null>(null);
  const [advStudent, setAdvStudent] = useState<{ id: string; name: string } | null>(null);
  const [advSearch, setAdvSearch] = useState('');
  const [advResults, setAdvResults] = useState<any[]>([]);
  const [advMonths, setAdvMonths] = useState(3);
  const [advPreview, setAdvPreview] = useState<any>(null);
  const [advBusy, setAdvBusy] = useState(false);
  const [advMsg, setAdvMsg] = useState<{ ok: boolean; text: string } | null>(null);

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

  // Day-by-day Razorpay settlement report (§4.1.6): the accountant ticks
  // each IST day off against the payout shown in the Razorpay dashboard.
  const fetchSettlements = useCallback(async (from?: string, to?: string) => {
    setSettleLoading(true);
    setSettleError(null);
    try {
      const res = await feeApi.getSettlements({ from: from ?? settleFrom, to: to ?? settleTo });
      setSettleDays(res.days ?? []);
      setSettleTotals(res.totals ?? null);
      setOpenDay(null);
    } catch (err: any) {
      setSettleError(err?.detail || 'Failed to load the settlements report.');
      setSettleDays([]);
    }
    setSettleLoading(false);
  }, [settleFrom, settleTo]);

  useEffect(() => { fetchInvoices(); fetchPayments(); }, [fetchInvoices, fetchPayments]);

  // Late-fee rules load with the page (cheap; the tab needs them).
  const fetchLfRules = useCallback(async () => {
    try { setLfRules((await feeApi.getLateFeeRules()).data ?? []); } catch { /* tab shows the error */ }
  }, []);
  useEffect(() => { fetchLfRules(); }, [fetchLfRules]);

  const addLfRule = async () => {
    setLfBusy(true); setLfMsg(null);
    try {
      await feeApi.createLateFeeRule({
        label: lfForm.label || `Late fee after ${lfForm.minDays} days`,
        minDays: Number(lfForm.minDays),
        maxDays: lfForm.maxDays ? Number(lfForm.maxDays) : null,
        amount: Number(lfForm.amount),
        isPercent: lfForm.isPercent,
      });
      setLfForm({ label: '', minDays: '', maxDays: '', amount: '', isPercent: false });
      setLfMsg({ ok: true, text: 'Slab added.' });
      await fetchLfRules();
    } catch (err: any) {
      setLfMsg({ ok: false, text: err?.detail || 'Could not add the slab.' });
    }
    setLfBusy(false);
  };

  const removeLfRule = async (id: string) => {
    try { await feeApi.deleteLateFeeRule(id); await fetchLfRules(); } catch { /* noop */ }
  };

  const runLateFees = async (dryRun: boolean) => {
    setLfBusy(true); setLfMsg(null); setLfReport(null);
    try {
      const res = await feeApi.applyLateFees(dryRun);
      setLfReport(res.applied ?? []);
      setLfMsg({
        ok: true,
        text: dryRun
          ? `Dry run: ${res.applied.length} fine(s) would be applied across ${res.scanned} overdue invoice(s), ${res.skipped} already fined or skipped.`
          : `Applied ${res.applied.length} late fee(s) across ${res.scanned} overdue invoice(s), ${res.skipped} skipped (already fined or zero balance).`,
      });
      if (!dryRun) { await fetchInvoices(); }
    } catch (err: any) {
      setLfMsg({ ok: false, text: err?.detail || 'Apply failed.' });
    }
    setLfBusy(false);
  };

  // Advance: type a student name, pick, preview, collect.
  useEffect(() => {
    if (!advSearch.trim() || advSearch.trim().length < 2) { setAdvResults([]); return; }
    const t = setTimeout(async () => {
      try { setAdvResults((await studentApi.list({ search: advSearch.trim(), limit: 8 })).data ?? []); } catch { setAdvResults([]); }
    }, 300);
    return () => clearTimeout(t);
  }, [advSearch]);

  const fetchAdvPreview = async (studentId: string, months: number) => {
    setAdvBusy(true); setAdvMsg(null);
    try { setAdvPreview(await feeApi.previewAdvance(studentId, months)); }
    catch (err: any) { setAdvPreview(null); setAdvMsg({ ok: false, text: err?.detail || 'Preview failed.' }); }
    setAdvBusy(false);
  };

  const collectNow = async () => {
    if (!advStudent || !advPreview?.total) return;
    if (!confirm(`Collect ₹${advPreview.total.toLocaleString('en-IN')} in CASH for ${advStudent.name} — ${advMonths} month(s) advance? A numbered receipt will be minted.`)) return;
    setAdvBusy(true); setAdvMsg(null);
    try {
      const res = await feeApi.collectAdvance({ studentId: advStudent.id, months: advMonths });
      setAdvMsg({ ok: true, text: `Collected ₹${res.payment.amount.toLocaleString('en-IN')} — receipt ${res.payment.receiptNo ?? 'pending'} (${res.generatedInvoices} advance invoice(s) generated).` });
      setAdvPreview(null); setAdvStudent(null); setAdvSearch('');
      await fetchInvoices(); await fetchPayments();
    } catch (err: any) {
      setAdvMsg({ ok: false, text: err?.detail || 'Collection failed.' });
    }
    setAdvBusy(false);
  };

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

  const reconcileNow = async () => {
    startLoading('Running reconciliation...');
    try {
      const res = await feeApi.runReconcile();
      alert(`Reconcile: checked ${res.checked} pending intent(s) — ${res.captured?.length ?? 0} captured, ${res.mismatches?.length ?? 0} mismatched.`);
      await fetchSettlements();
    } catch (err: any) { alert(err?.detail || 'Reconcile failed.'); }
    stopLoading();
  };

  const exportSettlementsCsv = () => {
    const rows: string[] = ['Date (IST),Payments,Gross INR,Receipts'];
    for (const d of settleDays) {
      const receipts = d.payments.map((p: any) => p.receiptNo ?? '').join(' ');
      rows.push(`${d.date},${d.count},${d.gross},"${receipts}"`);
    }
    rows.push(`TOTAL,${settleTotals?.count ?? 0},${settleTotals?.gross ?? 0},`);
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `razorpay-settlements-${settleFrom}-to-${settleTo}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
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
            <div className="flex gap-2 mb-4" style={{ flexWrap: 'wrap' }}>
              {([
                ['collections', 'receipt', 'Collections'],
                ['settlements', 'account_balance', 'Razorpay Settlements'],
                ['counter', 'payments', 'Late Fees & Advance'],
              ] as const).map(([key, icon, label]) => (
                <button key={key} className={`btn ${tab === key ? 'btn-primary' : 'btn-secondary'}`} onClick={() => { setTab(key); if (key === 'settlements' && !settleDays.length) fetchSettlements(); }}>
                  <span className="icon icon-sm">{icon}</span>{label}
                </button>
              ))}
            </div>

            {tab === 'collections' && (<>
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
            </>)}

            {tab === 'settlements' && (
              <div className="card">
                <div style={{ padding: '16px 20px 0' }} className="flex items-center gap-3">
                  <h3>Razorpay Settlements</h3>
                  <span style={{ marginLeft: 'auto', fontSize: 12, color: '#6B7280' }}>Captured online payments grouped by IST day — tick each day off against the payout in the Razorpay dashboard.</span>
                </div>
                <div className="card-body">
                  <div className="flex gap-3 items-end" style={{ flexWrap: 'wrap' }}>
                    <div className="input-group"><label className="input-label">From</label><input className="input" type="date" value={settleFrom} onChange={(e) => setSettleFrom(e.target.value)} /></div>
                    <div className="input-group"><label className="input-label">To</label><input className="input" type="date" value={settleTo} onChange={(e) => setSettleTo(e.target.value)} /></div>
                    <button className="btn btn-primary" disabled={settleLoading} onClick={() => fetchSettlements(settleFrom, settleTo)}>
                      <span className="icon icon-sm">{settleLoading ? 'hourglass_empty' : 'search'}</span>{settleLoading ? 'Loading…' : 'Apply'}
                    </button>
                    <button className="btn btn-secondary" onClick={reconcileNow}><span className="icon icon-sm">sync</span>Run reconcile</button>
                    <button className="btn btn-secondary" disabled={!settleDays.length} onClick={exportSettlementsCsv}><span className="icon icon-sm">download</span>Export CSV</button>
                  </div>

                  {settleTotals && (
                    <div className="grid grid-3 gap-4 mt-4">
                      <div className="stat-card" style={{ borderLeftColor: '#5048E5' }}><div className="stat-icon" style={{ background: '#5048E515', color: '#5048E5' }}><span className="icon">receipt_long</span></div><div><div className="stat-value">{settleTotals.count}</div><div className="stat-label">Captured Payments</div></div></div>
                      <div className="stat-card" style={{ borderLeftColor: '#10B981' }}><div className="stat-icon" style={{ background: '#10B98115', color: '#10B981' }}><span className="icon">currency_rupee</span></div><div><div className="stat-value">₹{settleTotals.gross.toLocaleString('en-IN')}</div><div className="stat-label">Gross Captured</div></div></div>
                      <div className="stat-card" style={{ borderLeftColor: '#F59E0B' }} title="Razorpay nets its charges at payout — import the payout report to reconcile to the bank credit."><div className="stat-icon" style={{ background: '#F59E0B15', color: '#F59E0B' }}><span className="icon">account_balance</span></div><div><div className="stat-value">₹{settleTotals.netCredited.toLocaleString('en-IN')}</div><div className="stat-label">To Reconcile (pre-charges)</div></div></div>
                    </div>
                  )}

                  {settleError && <div style={{ padding: 12, borderRadius: 8, background: '#FEF2F2', border: '1px solid #FECACA', color: '#B91C1C', marginTop: 12 }}>{settleError}</div>}

                  <div className="table-wrapper mt-4"><table className="table"><thead><tr><th></th><th>Date (IST)</th><th>Payments</th><th>Gross</th><th>Receipts</th></tr></thead><tbody>
                    {settleDays.map((d) => (
                      <Fragment key={d.date}>
                        <tr style={{ cursor: 'pointer' }} onClick={() => setOpenDay(openDay === d.date ? null : d.date)}>
                          <td><span className="icon icon-sm">{openDay === d.date ? 'expand_more' : 'chevron_right'}</span></td>
                          <td className="font-semibold">{new Date(d.date + 'T00:00:00+05:30').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</td>
                          <td>{d.count}</td>
                          <td className="font-semibold">₹{d.gross.toLocaleString('en-IN')}</td>
                          <td className="text-sm" style={{ color: '#6B7280' }}>{d.payments.map((p: any) => p.receiptNo ?? '—').join(', ')}</td>
                        </tr>
                        {openDay === d.date && (
                          <tr>
                            <td></td>
                            <td colSpan={4} style={{ background: '#F9FAFB', padding: '12px 16px' }}>
                              {d.payments.map((p: any) => (
                                <div key={p.id} className="flex items-center gap-3" style={{ padding: '6px 0', borderBottom: '1px solid #F3F4F6' }}>
                                  <span className="badge badge-success">{p.receiptNo ?? 'no receipt'}</span>
                                  <span className="text-sm" style={{ fontFamily: 'monospace' }}>{p.gatewayPaymentId ?? '—'}</span>
                                  <span className="text-sm">{p.method}</span>
                                  <span className="text-sm" style={{ marginLeft: 'auto', color: '#6B7280' }}>{p.paidAt ? new Date(p.paidAt).toLocaleTimeString('en-IN') : ''}</span>
                                  <span className="font-semibold" style={{ marginLeft: 12 }}>₹{Number(p.amount).toLocaleString('en-IN')}</span>
                                </div>
                              ))}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    ))}
                    {settleDays.length === 0 && !settleLoading && <tr><td colSpan={5} style={{ textAlign: 'center', padding: 24, color: '#9CA3AF' }}>No online payments captured in this range</td></tr>}
                  </tbody></table></div>
                </div>
              </div>
            )}

            {tab === 'counter' && (
              <>
                <div className="grid grid-2 gap-4">
                  {/* ── Late-fee slabs ── */}
                  <div className="card">
                    <div style={{ padding: '16px 20px 0' }}>
                      <h3>Late-Fee Slabs</h3>
                      <p className="text-sm" style={{ color: '#6B7280', marginTop: 4 }}>
                        Fines by days overdue — e.g. 15–29 days → ₹50, 30+ days → ₹200 or 2%. Applied as proper fee invoices
                        (LATE_FEE ledger), so receipts, allocation and reports all include them. Re-running never double-fines.
                      </p>
                    </div>
                    <div className="card-body">
                      <div className="flex gap-3 items-end" style={{ flexWrap: 'wrap' }}>
                        <div className="input-group" style={{ minWidth: 150 }}><label className="input-label">Label</label><input className="input" placeholder="e.g. 15–29 days" value={lfForm.label} onChange={(e) => setLfForm({ ...lfForm, label: e.target.value })} /></div>
                        <div className="input-group" style={{ width: 110 }}><label className="input-label">From (days)</label><input className="input" type="number" min="1" value={lfForm.minDays} onChange={(e) => setLfForm({ ...lfForm, minDays: e.target.value })} /></div>
                        <div className="input-group" style={{ width: 110 }}><label className="input-label">To (blank = ∞)</label><input className="input" type="number" min="1" value={lfForm.maxDays} onChange={(e) => setLfForm({ ...lfForm, maxDays: e.target.value })} /></div>
                        <div className="input-group" style={{ width: 120 }}><label className="input-label">{lfForm.isPercent ? '% of outstanding' : 'Fine ₹'}</label><input className="input" type="number" min="0" value={lfForm.amount} onChange={(e) => setLfForm({ ...lfForm, amount: e.target.value })} /></div>
                        <label className="text-sm flex items-center gap-1" style={{ paddingBottom: 8 }}><input type="checkbox" checked={lfForm.isPercent} onChange={(e) => setLfForm({ ...lfForm, isPercent: e.target.checked })} /> percent</label>
                        <button className="btn btn-primary" disabled={lfBusy || !lfForm.minDays || !lfForm.amount} onClick={addLfRule}><span className="icon icon-sm">add</span>Add slab</button>
                      </div>

                      <div className="table-wrapper mt-4"><table className="table"><thead><tr><th>Slab</th><th>Days overdue</th><th>Fine</th><th></th></tr></thead><tbody>
                        {lfRules.map((r) => (
                          <tr key={r.id}>
                            <td className="font-semibold">{r.label}</td>
                            <td>{r.minDays}{r.maxDays != null ? `–${r.maxDays}` : '+'} days</td>
                            <td>{r.isPercent ? `${Number(r.amount)}% of outstanding` : `₹${Number(r.amount).toLocaleString('en-IN')} flat`}</td>
                            <td><button className="btn btn-sm btn-secondary" onClick={() => removeLfRule(r.id)}><span className="icon icon-sm">delete</span></button></td>
                          </tr>
                        ))}
                        {lfRules.length === 0 && <tr><td colSpan={4} style={{ textAlign: 'center', padding: 16, color: '#9CA3AF' }}>No slabs yet — add one above (e.g. From 15, To 29, ₹50).</td></tr>}
                      </tbody></table></div>

                      <div className="flex gap-3 mt-4">
                        <button className="btn btn-secondary" disabled={lfBusy || lfRules.length === 0} onClick={() => runLateFees(true)}><span className="icon icon-sm">preview</span>Dry run</button>
                        <button className="btn btn-primary" disabled={lfBusy || lfRules.length === 0} onClick={() => runLateFees(false)}><span className="icon icon-sm">gavel</span>Apply late fees now</button>
                      </div>
                      {lfMsg && <div className="mt-3" style={{ padding: 12, borderRadius: 8, background: lfMsg.ok ? '#ECFDF5' : '#FEF2F2', border: `1px solid ${lfMsg.ok ? '#A7F3D0' : '#FECACA'}`, color: lfMsg.ok ? '#065F46' : '#B91C1C' }}>{lfMsg.text}</div>}
                      {lfReport && lfReport.length > 0 && (
                        <div className="table-wrapper mt-3"><table className="table"><thead><tr><th>Invoice</th><th>Slab</th><th>Days overdue</th><th>Fine</th></tr></thead><tbody>
                          {lfReport.map((a, i) => (
                            <tr key={`${a.invoiceNo}-${i}`}><td className="font-mono text-sm">{a.invoiceNo}</td><td>{a.rule}</td><td>{a.daysOverdue}</td><td className="font-semibold">₹{a.amount.toLocaleString('en-IN')}</td></tr>
                          ))}
                        </tbody></table></div>
                      )}
                    </div>
                  </div>

                  {/* ── Advance cash collection ── */}
                  <div className="card">
                    <div style={{ padding: '16px 20px 0' }}>
                      <h3>Advance Collection (Cash)</h3>
                      <p className="text-sm" style={{ color: '#6B7280', marginTop: 4 }}>
                        Collect the next 1–12 months of a student&apos;s monthly fees at the counter. Advance months are generated
                        as real invoices and settled with ONE cash payment + numbered receipt. Cash ≥ ₹2,00,000/day is refused
                        (Income-tax §269ST).
                      </p>
                    </div>
                    <div className="card-body">
                      {!advStudent ? (
                        <>
                          <div className="input-group"><label className="input-label">Find student</label><input className="input" placeholder="Type a name…" value={advSearch} onChange={(e) => setAdvSearch(e.target.value)} /></div>
                          {advResults.length > 0 && (
                            <div className="mt-2" style={{ border: '1px solid #E5E7EB', borderRadius: 8, overflow: 'hidden' }}>
                              {advResults.map((s) => (
                                <div key={s.id} className="flex items-center gap-2" style={{ padding: '10px 14px', cursor: 'pointer', borderBottom: '1px solid #F3F4F6' }} onClick={() => { setAdvStudent({ id: s.id, name: `${s.firstName ?? ''} ${s.lastName ?? ''}`.trim() }); setAdvResults([]); setAdvSearch(`${s.firstName ?? ''} ${s.lastName ?? ''}`.trim()); fetchAdvPreview(s.id, advMonths); }}>
                                  <span className="icon icon-sm" style={{ color: '#5048E5' }}>person</span>
                                  <span className="font-semibold">{s.firstName} {s.lastName}</span>
                                  <span className="text-sm" style={{ color: '#6B7280' }}>{s.admissionNo}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </>
                      ) : (
                        <>
                          <div className="flex items-center gap-3 mb-3">
                            <span className="icon" style={{ color: '#5048E5' }}>person</span>
                            <strong>{advStudent.name}</strong>
                            <button className="btn btn-sm btn-secondary" style={{ marginLeft: 'auto' }} onClick={() => { setAdvStudent(null); setAdvPreview(null); setAdvSearch(''); }}>Change</button>
                          </div>
                          <div className="flex gap-3 items-end" style={{ flexWrap: 'wrap' }}>
                            <div className="input-group" style={{ width: 140 }}><label className="input-label">Months in advance</label>
                              <select className="input" value={advMonths} onChange={(e) => { const m = Number(e.target.value); setAdvMonths(m); fetchAdvPreview(advStudent.id, m); }}>
                                {[1, 2, 3, 4, 5, 6, 9, 12].map((m) => <option key={m} value={m}>{m} month{m > 1 ? 's' : ''}</option>)}
                              </select>
                            </div>
                            <button className="btn btn-secondary" disabled={advBusy} onClick={() => fetchAdvPreview(advStudent.id, advMonths)}><span className="icon icon-sm">refresh</span>Re-preview</button>
                          </div>
                          {advBusy && <p className="mt-3" style={{ color: '#6B7280' }}><span className="icon icon-sm">hourglass_empty</span> Working…</p>}
                          {advPreview && (
                            <div className="mt-3">
                              <div className="stat-card" style={{ borderLeftColor: '#10B981' }}>
                                <div className="stat-icon" style={{ background: '#10B98115', color: '#10B981' }}><span className="icon">currency_rupee</span></div>
                                <div><div className="stat-value">₹{Number(advPreview.total).toLocaleString('en-IN')}</div><div className="stat-label">Cash to collect — {advPreview.months} month(s) @ ₹{Number(advPreview.perMonth).toLocaleString('en-IN')}/mo</div></div>
                              </div>
                              <div className="table-wrapper mt-3"><table className="table"><thead><tr><th>Month</th><th>Invoice</th><th>Amount</th></tr></thead><tbody>
                                {advPreview.generatedMonths.map((m: any) => (
                                  <tr key={m.periodStart}><td className="font-semibold">{m.periodStart}</td><td className="font-mono text-sm">{m.invoiceNo}{m.alreadyInvoiced && <span className="badge badge-secondary" style={{ marginLeft: 6 }}>existing</span>}</td><td>₹{Number(m.amount).toLocaleString('en-IN')}</td></tr>
                                ))}
                              </tbody></table></div>
                              <button className="btn btn-primary mt-3" disabled={advBusy || !advPreview.total} onClick={collectNow}><span className="icon icon-sm">paid</span>Collect ₹{Number(advPreview.total).toLocaleString('en-IN')} in cash</button>
                            </div>
                          )}
                        </>
                      )}
                      {advMsg && <div className="mt-3" style={{ padding: 12, borderRadius: 8, background: advMsg.ok ? '#ECFDF5' : '#FEF2F2', border: `1px solid ${advMsg.ok ? '#A7F3D0' : '#FECACA'}`, color: advMsg.ok ? '#065F46' : '#B91C1C' }}>{advMsg.text}</div>}
                    </div>
                  </div>
                </div>
              </>
            )}
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
