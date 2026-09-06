'use client';
import Topbar from '@/components/Topbar';
import { useState } from 'react';

export default function BudgetsPage() {
  const [budgets, setBudgets] = useState([
    { id: 1, name: 'Staff Salaries', allocated: 1000000, spent: 820000, category: 'Recurring' },
    { id: 2, name: 'Utilities & Maintenance', allocated: 200000, spent: 150000, category: 'Recurring' },
    { id: 3, name: 'Academic Resources', allocated: 300000, spent: 185000, category: 'Academic' },
    { id: 4, name: 'Infrastructure Upgrades', allocated: 500000, spent: 125000, category: 'Capital' },
    { id: 5, name: 'Sports & Activities', allocated: 150000, spent: 52000, category: 'Extracurricular' },
    { id: 6, name: 'Technology & IT', allocated: 250000, spent: 180000, category: 'Infrastructure' },
  ]);
  const totalAllocated = budgets.reduce((a, b) => a + b.allocated, 0);
  const totalSpent = budgets.reduce((a, b) => a + b.spent, 0);

  return (
    <>
      <Topbar title="Budget Management" subtitle="Allocate and track school budgets" />
      <div style={{ padding: '24px 32px' }}>
        <div className="grid grid-3 gap-4 mb-6">
          {[{ l: 'Total Budget', v: `₹${(totalAllocated / 100000).toFixed(0)}L`, c: '#5048E5' }, { l: 'Total Spent', v: `₹${(totalSpent / 100000).toFixed(1)}L`, c: '#EF4444' }, { l: 'Remaining', v: `₹${((totalAllocated - totalSpent) / 100000).toFixed(1)}L`, c: '#10B981' }].map(s => (
            <div key={s.l} className="stat-card" style={{ borderLeftColor: s.c }}><div className="stat-icon" style={{ background: s.c + '15', color: s.c }}><span className="icon">savings</span></div><div><div className="stat-value">{s.v}</div><div className="stat-label">{s.l}</div></div></div>
          ))}
        </div>
        <div className="grid grid-2 gap-6">
          {budgets.map(b => { const pct = Math.round((b.spent / b.allocated) * 100); const color = pct >= 90 ? '#EF4444' : pct >= 70 ? '#F59E0B' : '#10B981'; return (
            <div key={b.id} className="card"><div className="card-body">
              <div className="flex items-center justify-between"><h3>{b.name}</h3><span className="badge badge-primary">{b.category}</span></div>
              <div className="flex justify-between items-center mt-4"><span className="text-sm text-gray">₹{(b.spent / 1000).toFixed(0)}K / ₹{(b.allocated / 1000).toFixed(0)}K</span><span className="font-bold" style={{ color }}>{pct}%</span></div>
              <div style={{ height: 10, background: 'var(--gray-100)', borderRadius: 5, marginTop: 8 }}><div style={{ height: '100%', width: `${pct}%`, borderRadius: 5, background: color, transition: 'width 0.5s' }}></div></div>
              <div className="flex justify-between mt-3"><span className="text-xs text-gray">Remaining: ₹{((b.allocated - b.spent) / 1000).toFixed(0)}K</span>
                <button className="btn btn-sm btn-secondary" onClick={() => setBudgets(budgets.map(x => x.id === b.id ? { ...x, allocated: x.allocated + 50000 } : x))}><span className="icon icon-sm">add</span>+₹50K</button>
              </div>
            </div></div>
          ); })}
        </div>
      </div>
    </>
  );
}
