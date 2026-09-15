'use client';
import Topbar from '@/components/Topbar';
import { useState, useEffect } from 'react';
import { analyticsApi, API_BASE } from '@/lib/api';

// ──────────────────────────────────────────────
// Financial reports — fed by analytics-service (Phase 7.1), not the old stub
// generator. Every number is a real aggregate over the branch's invoices and
// payments; the branch table is the multi-branch management view.
// ──────────────────────────────────────────────

const money = (v: unknown) => `₹${(Number(v ?? 0) / 100000).toFixed(1)}L`;
const rupees = (v: unknown) => `₹${Number(v ?? 0).toLocaleString('en-IN')}`;

/** Authenticated XLSX download — the export endpoints need the bearer token,
 * so a plain <a href> cannot fetch them. */
async function downloadXlsx(path: string, filename: string) {
  const token = typeof window !== 'undefined' ? localStorage.getItem('erp_token') : null;
  const res = await fetch(`${API_BASE}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new Error(`Export failed (${res.status})`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function FinancialReportsPage() {
  const [activeTab, setActiveTab] = useState('Overview');
  const [funnel, setFunnel] = useState<any>(null);
  const [branches, setBranches] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    async function loadReports() {
      try {
        const [f, b] = await Promise.all([
          analyticsApi.getFeeFunnel(),
          analyticsApi.getBranchComparison(),
        ]);
        setFunnel(f);
        setBranches(b ?? []);
      } catch (err: any) {
        setError(err.detail || err.message || 'Failed to load reports');
      } finally {
        setLoading(false);
      }
    }
    loadReports();
  }, []);

  const onExport = async () => {
    setExporting(true);
    try {
      await downloadXlsx(
        analyticsApi.exportBranchComparisonXlsx(),
        `branch-comparison-${new Date().toISOString().slice(0, 10)}.xlsx`,
      );
    } catch (err: any) {
      alert(err.message || 'Export failed');
    } finally {
      setExporting(false);
    }
  };

  if (loading) return <div className="p-12 text-center text-primary animate-pulse">Loading financial reports...</div>;
  if (error) return <div className="p-12 text-center text-danger">{error}</div>;

  const totals = funnel?.totals ?? {};
  const byStatus: Array<{ status: string; invoices: number; invoiced: unknown; collected: unknown; outstanding: unknown }> =
    Object.entries(funnel?.byStatus ?? {}).map(([status, v]: [string, any]) => ({ status, ...v }));

  return (
    <>
      <Topbar title="Financial Reports" subtitle="Fee collection funnel and branch comparison — live from the ledger" />
      <div style={{ padding: '24px 32px' }}>
        <div className="flex items-center justify-between mb-6">
          <div className="tabs">
            {['Overview', 'Fee Funnel', 'Branch Comparison'].map(tab => (
              <button
                key={tab}
                className={`tab ${activeTab === tab ? 'active' : ''}`}
                onClick={() => setActiveTab(tab)}
              >
                {tab}
              </button>
            ))}
          </div>
          <button className="btn btn-secondary" onClick={onExport} disabled={exporting}>
            <span className="icon icon-sm">download</span>{exporting ? 'Exporting…' : 'Export XLSX'}
          </button>
        </div>

        {activeTab === 'Overview' && (
          <>
            <div className="grid grid-4 gap-4 mb-6 animate-fadeIn">
              {[
                { l: 'Total Invoiced', v: money(totals.invoiced), c: '#5048E5', icon: 'request_quote' },
                { l: 'Collected', v: money(totals.collected), c: '#10B981', icon: 'trending_up' },
                { l: 'Outstanding', v: money(Number(totals.invoiced ?? 0) - Number(totals.collected ?? 0)), c: '#EF4444', icon: 'trending_down' },
                { l: 'Collection Rate', v: `${totals.collectionRate ?? 0}%`, c: '#F59E0B', icon: 'savings' },
              ].map(s => (
                <div key={s.l} className="stat-card" style={{ borderLeftColor: s.c }}>
                  <div className="stat-icon" style={{ background: s.c + '15', color: s.c }}><span className="icon">{s.icon}</span></div>
                  <div><div className="stat-value">{s.v}</div><div className="stat-label">{s.l}</div></div>
                </div>
              ))}
            </div>
            <div className="card animate-fadeIn"><div className="card-body">
              <h3 className="mb-4">Money by Invoice Status</h3>
              {byStatus.map(r => {
                const pct = Number(totals.invoiced) > 0 ? Math.round((Number(r.invoiced) / Number(totals.invoiced)) * 100) : 0;
                return (
                  <div key={r.status} style={{ marginBottom: 12 }}>
                    <div className="flex justify-between items-center">
                      <span className="font-semibold" style={{ fontSize: '0.875rem' }}>{r.status.replace(/_/g, ' ')}</span>
                      <span className="font-bold">{money(r.invoiced)} ({pct}%)</span>
                    </div>
                    <div style={{ height: 8, background: 'var(--gray-100)', borderRadius: 4, marginTop: 4 }}>
                      <div style={{ height: '100%', width: `${pct}%`, borderRadius: 4, background: r.status === 'PAID' ? '#10B981' : r.status === 'OVERDUE' ? '#EF4444' : 'var(--primary)', transition: 'width 0.5s' }}></div>
                    </div>
                  </div>
                );
              })}
            </div></div>
          </>
        )}

        {activeTab === 'Fee Funnel' && (
          <div className="card animate-fadeIn">
            <div className="table-wrapper">
              <table className="table" style={{ margin: 0 }}>
                <thead>
                  <tr>
                    <th style={{ paddingLeft: '24px' }}>Status</th>
                    <th>Invoices</th>
                    <th>Invoiced</th>
                    <th>Collected</th>
                    <th style={{ paddingRight: '24px' }}>Outstanding</th>
                  </tr>
                </thead>
                <tbody>
                  {byStatus.map(r => (
                    <tr key={r.status}>
                      <td className="font-semibold" style={{ paddingLeft: '24px' }}>{r.status.replace(/_/g, ' ')}</td>
                      <td>{r.invoices}</td>
                      <td>{money(r.invoiced)}</td>
                      <td className="text-success font-medium">{money(r.collected)}</td>
                      <td className={`font-medium ${Number(r.outstanding) > 0 ? 'text-danger' : ''}`} style={{ paddingRight: '24px' }}>{money(r.outstanding)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activeTab === 'Branch Comparison' && (
          <div className="card animate-fadeIn">
            <div className="card-body">
              <h3 className="mb-4">All Branches — the management-office view</h3>
              <div className="table-wrapper">
                <table className="table" style={{ margin: 0 }}>
                  <thead>
                    <tr>
                      <th style={{ paddingLeft: '24px' }}>Branch</th>
                      <th>Students</th>
                      <th>Staff</th>
                      <th>Revenue</th>
                      <th>Pending Fees</th>
                      <th style={{ paddingRight: '24px' }}>Attendance (30d)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {branches.map(b => (
                      <tr key={b.branch_id}>
                        <td className="font-semibold" style={{ paddingLeft: '24px' }}>{b.branch}</td>
                        <td>{b.students}</td>
                        <td>{b.staff}</td>
                        <td className="text-success font-medium">{money(b.revenue)}</td>
                        <td className={`font-medium ${Number(b.pending_fees) > 0 ? 'text-danger' : ''}`}>{money(b.pending_fees)}</td>
                        <td style={{ paddingRight: '24px' }}>
                          <span className="badge badge-success">{b.attendance_rate_30d ?? 0}%</span>
                        </td>
                      </tr>
                    ))}
                    {branches.length === 0 && (
                      <tr><td colSpan={6} className="text-center py-8 text-gray">No branches found.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div className="mt-4 text-sm text-gray">
                Revenue across branches: {money(branches.reduce((s, b) => s + Number(b.revenue ?? 0), 0))} ·
                Pending: {money(branches.reduce((s, b) => s + Number(b.pending_fees ?? 0), 0))}
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
