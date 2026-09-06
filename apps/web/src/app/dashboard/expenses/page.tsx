'use client';
import Topbar from '@/components/Topbar';
import { useState } from 'react';

const initialExpenses = [
  { id: 1, desc: 'Electricity Bill — March', category: 'Utilities', amt: 45000, date: '2026-03-05', vendor: 'BSES Delhi', status: 'Paid' },
  { id: 2, desc: 'Staff Room Furniture', category: 'Infrastructure', amt: 125000, date: '2026-03-03', vendor: 'Urban Furnish', status: 'Pending' },
  { id: 3, desc: 'Science Lab Equipment', category: 'Academic', amt: 85000, date: '2026-02-28', vendor: 'LabChem India', status: 'Paid' },
  { id: 4, desc: 'Bus Diesel — Feb', category: 'Transport', amt: 68000, date: '2026-02-25', vendor: 'Indian Oil', status: 'Paid' },
  { id: 5, desc: 'Annual Sports Equipment', category: 'Sports', amt: 52000, date: '2026-02-20', vendor: 'Decathlon', status: 'Approved' },
];

export default function ExpensesPage() {
  const [expenses, setExpenses] = useState(initialExpenses);
  const [showForm, setShowForm] = useState(false);
  const [search, setSearch] = useState('');
  const [newExp, setNewExp] = useState({ desc: '', category: 'Utilities', amt: '', vendor: '' });

  const filtered = expenses.filter(e => e.desc.toLowerCase().includes(search.toLowerCase()) || e.vendor.toLowerCase().includes(search.toLowerCase()));
  const totalSpent = expenses.filter(e => e.status === 'Paid').reduce((a, b) => a + b.amt, 0);

  const addExpense = () => {
    if (!newExp.desc || !newExp.amt) return;
    setExpenses([{ id: Date.now(), desc: newExp.desc, category: newExp.category, amt: Number(newExp.amt), date: new Date().toISOString().split('T')[0], vendor: newExp.vendor, status: 'Pending' }, ...expenses]);
    setNewExp({ desc: '', category: 'Utilities', amt: '', vendor: '' });
    setShowForm(false);
  };

  return (
    <>
      <Topbar title="Expense Tracker" subtitle="Track and manage school expenses" />
      <div style={{ padding: '24px 32px' }}>
        <div className="grid grid-3 gap-4 mb-6">
          {[{ l: 'Total Expenses (Month)', v: `₹${(totalSpent / 100000).toFixed(1)}L`, c: '#EF4444' }, { l: 'Pending Approval', v: expenses.filter(e => e.status === 'Pending').length.toString(), c: '#F59E0B' }, { l: 'Categories', v: new Set(expenses.map(e => e.category)).size.toString(), c: '#5048E5' }].map(s => (
            <div key={s.l} className="stat-card" style={{ borderLeftColor: s.c }}><div className="stat-icon" style={{ background: s.c + '15', color: s.c }}><span className="icon">receipt_long</span></div><div><div className="stat-value">{s.v}</div><div className="stat-label">{s.l}</div></div></div>
          ))}
        </div>
        <div className="flex items-center justify-between mb-4" style={{ flexWrap: 'wrap', gap: 12 }}>
          <div className="search-bar"><span className="icon">search</span><input placeholder="Search expenses..." value={search} onChange={e => setSearch(e.target.value)} /></div>
          <button className="btn btn-primary" onClick={() => setShowForm(!showForm)}><span className="icon icon-sm">{showForm ? 'close' : 'add'}</span>{showForm ? 'Cancel' : 'Add Expense'}</button>
        </div>
        {showForm && (
          <div className="card mb-4"><div className="card-body"><h3 className="mb-4">New Expense</h3>
            <div className="grid grid-2 gap-4">
              <div className="input-group"><label className="input-label">Description</label><input className="input" value={newExp.desc} onChange={e => setNewExp({ ...newExp, desc: e.target.value })} placeholder="e.g. Electricity Bill" /></div>
              <div className="input-group"><label className="input-label">Category</label><select className="select" value={newExp.category} onChange={e => setNewExp({ ...newExp, category: e.target.value })}><option>Utilities</option><option>Infrastructure</option><option>Academic</option><option>Transport</option><option>Sports</option><option>Maintenance</option><option>Other</option></select></div>
              <div className="input-group"><label className="input-label">Amount (₹)</label><input className="input" type="number" value={newExp.amt} onChange={e => setNewExp({ ...newExp, amt: e.target.value })} placeholder="0" /></div>
              <div className="input-group"><label className="input-label">Vendor</label><input className="input" value={newExp.vendor} onChange={e => setNewExp({ ...newExp, vendor: e.target.value })} placeholder="Vendor name" /></div>
            </div>
            <button className="btn btn-primary mt-2" onClick={addExpense}><span className="icon icon-sm">save</span>Save Expense</button>
          </div></div>
        )}
        <div className="card"><div className="table-wrapper"><table className="table"><thead><tr><th>Description</th><th>Category</th><th>Amount</th><th>Date</th><th>Vendor</th><th>Status</th><th>Actions</th></tr></thead><tbody>
          {filtered.map(e => (
            <tr key={e.id}><td className="font-semibold">{e.desc}</td><td><span className="badge badge-primary">{e.category}</span></td><td className="font-bold">₹{e.amt.toLocaleString()}</td><td className="text-sm">{e.date}</td><td className="text-sm">{e.vendor}</td>
              <td><span className={`badge ${e.status === 'Paid' ? 'badge-success' : e.status === 'Pending' ? 'badge-warning' : 'badge-info'}`}>{e.status}</span></td>
              <td><div className="flex gap-2">{e.status === 'Pending' && <button className="btn btn-sm btn-success" onClick={() => setExpenses(expenses.map(x => x.id === e.id ? { ...x, status: 'Paid' } : x))}><span className="icon icon-sm">check</span></button>}<button className="btn btn-sm btn-ghost" onClick={() => setExpenses(expenses.filter(x => x.id !== e.id))}><span className="icon icon-sm text-danger">delete</span></button></div></td>
            </tr>
          ))}
        </tbody></table></div></div>
      </div>
    </>
  );
}
