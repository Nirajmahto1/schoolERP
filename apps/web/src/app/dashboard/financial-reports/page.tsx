'use client';
import Topbar from '@/components/Topbar';
import { useState, useEffect } from 'react';
import { feeApi } from '@/lib/api';

export default function FinancialReportsPage() {
  const [activeTab, setActiveTab] = useState('Overview');
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadReports() {
      try {
        const res = await feeApi.getReports();
        setData(res);
      } catch (err: any) {
        setError(err.detail || err.message || 'Failed to load reports');
      } finally {
        setLoading(false);
      }
    }
    loadReports();
  }, []);

  if (loading) return <div className="p-12 text-center text-primary animate-pulse">Loading financial reports...</div>;
  if (error) return <div className="p-12 text-center text-danger">{error}</div>;

  return (
    <>
      <Topbar title="Financial Reports" subtitle="Income, expense, and financial analysis" />
      <div style={{ padding: '24px 32px' }}>
        <div className="flex items-center justify-between mb-6">
          <div className="tabs">
            {['Overview', 'Income', 'Expenses', 'Profit/Loss'].map(tab => (
              <button 
                key={tab} 
                className={`tab ${activeTab === tab ? 'active' : ''}`}
                onClick={() => setActiveTab(tab)}
              >
                {tab}
              </button>
            ))}
          </div>
          <div className="flex gap-3">
            <select className="select" style={{ width: 160 }}><option>Current Month</option></select>
            <button className="btn btn-secondary"><span className="icon icon-sm">download</span>Export PDF</button>
          </div>
        </div>

        {activeTab === 'Overview' && (
          <>
            <div className="grid grid-4 gap-4 mb-6 animate-fadeIn">
              {[
                {l:'Total Income',v:`₹${(data.totalIncome/100000).toFixed(1)}L`,c:'#10B981',icon:'trending_up'},
                {l:'Total Expenses',v:`₹${(data.totalExpenses/100000).toFixed(1)}L`,c:'#EF4444',icon:'trending_down'},
                {l:'Net Profit',v:`₹${(data.netProfit/100000).toFixed(1)}L`,c:'#5048E5',icon:'account_balance'},
                {l:'YTD Revenue',v:`₹${(data.ytdRevenue/100000).toFixed(1)}L`,c:'#F59E0B',icon:'savings'}
              ].map(s=>(
                <div key={s.l} className="stat-card" style={{borderLeftColor:s.c}}><div className="stat-icon" style={{background:s.c+'15',color:s.c}}><span className="icon">{s.icon}</span></div><div><div className="stat-value">{s.v}</div><div className="stat-label">{s.l}</div></div></div>
              ))}
            </div>
            <div className="grid grid-2 gap-6 animate-fadeIn">
              <div className="card"><div className="card-body"><h3 className="mb-4">Income Breakdown</h3>
                {data.incomeBreakdown.map((r: any) => (
                  <div key={r.cat} style={{marginBottom:12}}>
                    <div className="flex justify-between items-center"><span className="font-semibold" style={{fontSize:'0.875rem'}}>{r.cat}</span><span className="font-bold">₹{(r.amt/100000).toFixed(1)}L ({r.pct}%)</span></div>
                    <div style={{height:8,background:'var(--gray-100)',borderRadius:4,marginTop:4}}><div style={{height:'100%',width:`${r.pct}%`,borderRadius:4,background:'var(--primary)',transition:'width 0.5s'}}></div></div>
                  </div>
                ))}
              </div></div>
              <div className="card"><div className="card-body"><h3 className="mb-4">Expense Breakdown</h3>
                {data.expenseBreakdown.map((r: any) => (
                  <div key={r.cat} style={{marginBottom:12}}>
                    <div className="flex justify-between items-center"><span className="font-semibold" style={{fontSize:'0.875rem'}}>{r.cat}</span><span className="font-bold">₹{(r.amt/100000).toFixed(1)}L ({r.pct}%)</span></div>
                    <div style={{height:8,background:'var(--gray-100)',borderRadius:4,marginTop:4}}><div style={{height:'100%',width:`${r.pct}%`,borderRadius:4,background:'#EF4444',transition:'width 0.5s'}}></div></div>
                  </div>
                ))}
              </div></div>
            </div>
          </>
        )}

        {activeTab === 'Income' && (
          <div className="card animate-fadeIn">
            <div className="table-wrapper">
              <table className="table" style={{ margin: 0 }}>
                <thead>
                  <tr>
                    <th style={{ paddingLeft: '24px' }}>Transaction</th>
                    <th>Date</th>
                    <th>Category</th>
                    <th>Amount</th>
                    <th style={{ paddingRight: '24px' }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td colSpan={5} className="text-center py-8 text-gray">Income details are managed via Fee Collection.</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activeTab === 'Expenses' && (
          <div className="card animate-fadeIn">
            <div className="table-wrapper">
              <table className="table" style={{ margin: 0 }}>
                <thead>
                  <tr>
                    <th style={{ paddingLeft: '24px' }}>Transaction </th>
                    <th>Date</th>
                    <th>Payee / Category</th>
                    <th>Amount</th>
                    <th style={{ paddingRight: '24px' }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td colSpan={5} className="text-center py-8 text-gray">Expense details are managed via Payroll.</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activeTab === 'Profit/Loss' && (
          <div className="card animate-fadeIn">
            <div className="card-body">
              <h3 className="mb-4">Net Profit Margin Summary</h3>
              <div className="table-wrapper">
                <table className="table" style={{ margin: 0 }}>
                  <thead>
                    <tr>
                      <th style={{ paddingLeft: '24px' }}>Month</th>
                      <th>Total Income</th>
                      <th>Total Expenses</th>
                      <th>Net Profit</th>
                      <th style={{ paddingRight: '24px' }}>Margin %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.monthlyData.map((pl: any, i: number) => {
                      const margin = pl.income ? ((pl.profit / pl.income) * 100).toFixed(1) : '0.0';
                      return (
                        <tr key={i}>
                          <td className="font-semibold" style={{ paddingLeft: '24px' }}>{pl.month}</td>
                          <td className="text-success font-medium">₹{(pl.income / 100000).toFixed(2)}L</td>
                          <td className="text-danger font-medium">₹{(pl.expense / 100000).toFixed(2)}L</td>
                          <td className="font-bold text-primary">₹{(pl.profit / 100000).toFixed(2)}L</td>
                          <td style={{ paddingRight: '24px' }}>
                            <span className={`badge ${Number(margin) >= 0 ? 'badge-success' : 'badge-danger'}`}>{margin}%</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
