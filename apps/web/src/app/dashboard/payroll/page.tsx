'use client';
import Topbar from '@/components/Topbar';
import { useState, useEffect } from 'react';
import { staffApi } from '@/lib/api';

export default function PayrollPage() {
  const dateStr = new Date().toISOString().split('T')[0];
  const [month, setMonth] = useState(parseInt(dateStr.split('-')[1]));
  const [year, setYear] = useState(parseInt(dateStr.split('-')[0]));
  
  const [staff, setStaff] = useState<any[]>([]);
  const [payrolls, setPayrolls] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadData() {
      try {
        setLoading(true);
        const [staffRes, payrollRes] = await Promise.all([
          staffApi.list(),
          staffApi.getPayroll({ month, year })
        ]);
        setStaff(staffRes.data || []);
        setPayrolls(payrollRes.data || []);
      } catch (err) {
        console.error('Failed to load payroll data:', err);
      } finally {
        setLoading(false);
      }
    }
    loadData();
  }, [month, year]);

  const handleProcessAll = async () => {
    try {
      setLoading(true);
      const user = JSON.parse(localStorage.getItem('erp_user') || '{}');
      await staffApi.generatePayroll({ month, year, branchId: user.branchId || 'branch1' });
      const payrollRes = await staffApi.getPayroll({ month, year });
      setPayrolls(payrollRes.data || []);
    } catch {
      alert('Failed to process payroll');
    } finally {
      setLoading(false);
    }
  };

  const tableData = staff.map(s => {
    const p = payrolls.find(px => px.staffId === s.id);
    const basic = s.salary || 50000;
    return {
      id: s.id,
      name: `${s.firstName} ${s.lastName}`,
      dept: s.department?.name || 'Academic',
      basic,
      hra: basic * 0.3,
      da: basic * 0.2,
      pf: basic * 0.12,
      tax: basic * 0.1,
      net: p ? p.netSalary : basic * 1.28,
      status: p ? p.status : 'PENDING'
    };
  });

  const totalNet = tableData.reduce((a, b) => a + Number(b.net), 0);
  const processedCount = payrolls.length;

  if (loading) return <div className="p-12 text-center text-primary animate-pulse">Loading payroll data...</div>;

  return (
    <>
      <Topbar title="Payroll Management" subtitle="Process staff salaries and manage compensation" />
      <div style={{ padding: '24px 32px' }}>
        <div className="grid grid-4 gap-4 mb-6">
          {[{ l: 'Total Payroll', v: `₹${(totalNet / 100000).toFixed(1)}L`, c: '#5048E5' }, { l: 'Staff Count', v: String(staff.length), c: '#10B981' }, { l: 'Processed', v: String(processedCount), c: '#F59E0B' }, { l: 'Pending', v: String(staff.length - processedCount), c: '#EF4444' }].map(s => (
            <div key={s.l} className="stat-card" style={{ borderLeftColor: s.c }}><div className="stat-icon" style={{ background: s.c + '15', color: s.c }}><span className="icon">account_balance_wallet</span></div><div><div className="stat-value">{s.v}</div><div className="stat-label">{s.l}</div></div></div>
          ))}
        </div>
        <div className="flex items-center justify-between mb-4" style={{ flexWrap: 'wrap', gap: 12 }}>
          <div className="flex gap-3">
            <select className="select" style={{ width: 140 }} value={month} onChange={e => setMonth(Number(e.target.value))}>
              <option value={1}>January</option><option value={2}>February</option><option value={3}>March</option><option value={4}>April</option>
            </select>
            <select className="select" style={{ width: 100 }} value={year} onChange={e => setYear(Number(e.target.value))}>
              <option value={2025}>2025</option><option value={2026}>2026</option>
            </select>
          </div>
          <div className="flex gap-3">
            <button className="btn btn-secondary" onClick={handleProcessAll} disabled={processedCount === staff.length || staff.length === 0}>
              <span className="icon icon-sm">done_all</span>{processedCount === staff.length ? 'All Processed' : 'Process All'}
            </button>
            <button className="btn btn-primary"><span className="icon icon-sm">download</span>Export Payslips</button>
          </div>
        </div>
        
        <div className="card animate-fadeIn"><div className="table-wrapper"><table className="table"><thead><tr><th>Employee</th><th>Dept</th><th>Basic</th><th>HRA</th><th>DA</th><th>PF (-)</th><th>Tax (-)</th><th>Net Pay</th><th>Status</th></tr></thead><tbody>
          {tableData.map(s => (
            <tr key={s.id}>
              <td><div className="flex items-center gap-3"><div className="avatar avatar-sm">{s.name.split(' ').map((n: string) => n[0]).join('')}</div><span className="font-semibold">{s.name}</span></div></td>
              <td className="text-sm">{s.dept}</td>
              <td>₹{s.basic.toLocaleString()}</td>
              <td className="text-success">+₹{s.hra.toLocaleString()}</td>
              <td className="text-success">+₹{s.da.toLocaleString()}</td>
              <td className="text-danger">-₹{s.pf.toLocaleString()}</td>
              <td className="text-danger">-₹{s.tax.toLocaleString()}</td>
              <td className="font-bold">₹{s.net.toLocaleString()}</td>
              <td><span className={`badge ${s.status === 'PAID' ? 'badge-success' : s.status === 'DRAFT' ? 'badge-info' : 'badge-warning'}`}>{s.status || 'PENDING'}</span></td>
            </tr>
          ))}
          {tableData.length === 0 && (
            <tr><td colSpan={9} className="text-center py-8 text-gray">No staff members found for the active branch.</td></tr>
          )}
        </tbody></table></div></div>
      </div>
    </>
  );
}
