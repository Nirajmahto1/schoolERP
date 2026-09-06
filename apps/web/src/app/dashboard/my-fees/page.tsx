'use client';
import Topbar from '@/components/Topbar';
import { useState, useEffect } from 'react';
import { useLoading } from '@/context/LoadingContext';
import { studentApi } from '@/lib/api';

export default function MyFeesPage() {
  const { startLoading, stopLoading } = useLoading();
  const [invoices, setInvoices] = useState<any[]>([]);
  const [loadingInitial, setLoadingInitial] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const data = await studentApi.getMyFees();
        setInvoices(data);
      } catch (err) {
        console.error('Failed to load fees', err);
      } finally { setLoadingInitial(false); }
    };
    load();
  }, []);

  const handlePay = (inv: string) => {
    startLoading(`Opening payment gateway for ${inv}...`);
    setTimeout(() => {
      stopLoading();
      alert('Payment successful! This is a demo transaction.');
      setInvoices(invoices.map(i => i.inv === inv ? { ...i, status: 'Paid' } : i));
    }, 1500);
  };
  if (loadingInitial) {
    return <div className="p-12 text-center text-primary animate-pulse">Loading fee records...</div>;
  }

  const totalDueArr = invoices.filter(i => i.status !== 'Paid').map(i => parseInt(i.amt.replace(/[^0-9]/g, ''), 10) || 0);
  const totalDue = totalDueArr.reduce((a, b) => a + b, 0);

  const totalPaidArr = invoices.filter(i => i.status === 'Paid').map(i => parseInt(i.amt.replace(/[^0-9]/g, ''), 10) || 0);
  const totalPaid = totalPaidArr.reduce((a, b) => a + b, 0);

  return (
    <>
      <Topbar title="My Fees" subtitle="View and pay your fee invoices" />
      <div style={{ padding: '24px 32px' }}>
        <div className="grid grid-3 gap-4 mb-6">
          {[{ l: 'Total Due', v: `₹${totalDue.toLocaleString()}`, c: '#EF4444' }, { l: 'Total Paid (This Year)', v: `₹${totalPaid.toLocaleString()}`, c: '#10B981' }, { l: 'Next Due Date', v: invoices.find(i => i.status !== 'Paid')?.due || 'None', c: '#F59E0B' }].map(s => (
            <div key={s.l} className="stat-card" style={{ borderLeftColor: s.c }}>
              <div className="stat-icon" style={{ background: s.c + '15', color: s.c }}><span className="icon">payments</span></div>
              <div><div className="stat-value">{s.v}</div><div className="stat-label">{s.l}</div></div>
            </div>
          ))}
        </div>

        <div className="card">
          <div className="card-body"><h3>Fee Invoices</h3></div>
          <div className="table-wrapper">
            <table className="table">
              <thead><tr><th>Invoice</th><th>Fee Type</th><th>Amount</th><th>Due Date</th><th>Status</th><th>Action</th></tr></thead>
              <tbody>
                {invoices.length === 0 ? (
                  <tr><td colSpan={6} className="text-center py-6 text-gray">No invoices generated</td></tr>
                ) : invoices.map((f, i) => (
                  <tr key={i}><td className="font-semibold text-sm">{f.inv}</td><td>{f.type}</td><td className="font-bold">{f.amt}</td><td className="text-sm">{f.due}</td>
                    <td><span className={`badge ${f.status === 'Paid' ? 'badge-success' : 'badge-warning'}`}>{f.status}</span></td>
                    <td>{f.status !== 'Paid' ? <button className="btn btn-sm btn-primary" onClick={() => handlePay(f.inv)}><span className="icon icon-sm">payments</span>Pay Now</button> : <button className="btn btn-sm btn-secondary"><span className="icon icon-sm">download</span>Receipt</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}
