'use client';
import Topbar from '@/components/Topbar';
import { useState, useEffect } from 'react';
import { feeApi, studentApi } from '@/lib/api';

export default function InvoicingPage() {
  const [showForm, setShowForm] = useState(false);
  const [activeTab, setActiveTab] = useState('All');
  const [invoices, setInvoices] = useState<any[]>([]);
  const [students, setStudents] = useState<any[]>([]);
  const [structures, setStructures] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  // Form State
  const [studentId, setStudentId] = useState('');
  const [structureId, setStructureId] = useState('');
  const [amount, setAmount] = useState(5000);
  const [dueDate, setDueDate] = useState('');

  useEffect(() => {
    async function loadData() {
      try {
        const [invRes, stuRes, structRes] = await Promise.all([
          feeApi.getInvoices({ limit: 50 }),
          studentApi.list({ limit: 50 }),
          feeApi.getStructures()
        ]);
        setInvoices(invRes.data || []);
        setStudents(stuRes.data || []);
        setStructures(structRes.data || []);
        
        if (stuRes.data?.length > 0) setStudentId(stuRes.data[0].id);
        if (structRes.data?.length > 0) {
          setStructureId(structRes.data[0].id);
          setAmount(structRes.data[0].amount || 0);
        }
        
        const date = new Date();
        date.setDate(date.getDate() + 14);
        setDueDate(date.toISOString().split('T')[0]);
      } catch (err: any) {
        console.error('Failed to load invoicing data', err);
      } finally {
        setLoading(false);
      }
    }
    loadData();
  }, []);

  const handleGenerate = async () => {
    try {
      await feeApi.createInvoice({
        studentId,
        dueDate: new Date(dueDate).toISOString(),
        items: [{
          feeStructureId: structureId,
          amount: Number(amount),
          discount: 0
        }]
      });
      setShowForm(false);
      const res = await feeApi.getInvoices({ limit: 50 });
      setInvoices(res.data);
    } catch {
      alert('Failed to generate invoice');
    }
  };

  const filteredInvoices = invoices.filter(inv => {
    if (activeTab === 'All') return true;
    return (inv.status || 'DRAFT').toUpperCase() === activeTab.toUpperCase();
  });

  if (loading) return <div className="p-12 text-center text-primary animate-pulse">Loading invoices...</div>;

  return (
    <>
      <Topbar title="Invoicing" subtitle="Generate and manage fee invoices" />
      <div style={{ padding: '24px 32px' }}>
        <div className="flex items-center justify-between mb-4">
          <div className="tabs">
            {['All', 'Draft', 'Pending', 'Overdue', 'Paid'].map(tab => (
               <button 
                 key={tab} 
                 className={`tab ${activeTab === tab ? 'active' : ''}`}
                 onClick={() => setActiveTab(tab)}
               >
                 {tab}
               </button>
            ))}
          </div>
          <button className="btn btn-primary" onClick={() => setShowForm(!showForm)}>
            <span className="icon icon-sm">{showForm ? 'close' : 'add'}</span>
            {showForm ? 'Cancel' : 'Generate Invoice'}
          </button>
        </div>
        
        {showForm && (
          <div className="card mb-4 animate-fadeIn"><div className="card-body"><h3 className="mb-4">New Invoice</h3><div className="grid grid-3 gap-4">
            <div className="input-group">
              <label className="input-label">Student</label>
              <select className="select" value={studentId} onChange={e => setStudentId(e.target.value)}>
                {students.map(s => <option key={s.id} value={s.id}>{s.firstName} {s.lastName} ({s.admissionNo})</option>)}
              </select>
            </div>
            <div className="input-group">
              <label className="input-label">Fee Type</label>
              <select className="select" value={structureId} onChange={e => {
                const sId = e.target.value;
                setStructureId(sId);
                const st = structures.find(x => x.id === sId);
                if (st) setAmount(st.amount);
              }}>
                {structures.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div className="input-group">
              <label className="input-label">Amount (₹)</label>
              <input className="input" type="number" value={amount} onChange={e => setAmount(Number(e.target.value))} />
            </div>
            <div className="input-group">
              <label className="input-label">Due Date</label>
              <input className="input" type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} />
            </div>
            <div className="input-group" style={{display:'flex',alignItems:'flex-end'}}>
              <button className="btn btn-primary" onClick={handleGenerate}><span className="icon icon-sm">save</span>Generate</button>
            </div>
          </div></div></div>
        )}
        
        <div className="card animate-fadeIn"><div className="table-wrapper"><table className="table" style={{ margin: 0 }}><thead><tr><th style={{ paddingLeft: '24px' }}>Invoice #</th><th>Student</th><th>Class / Adm No</th><th>Date</th><th>Due Date</th><th>Amount</th><th>Status</th></tr></thead><tbody>
          {filteredInvoices.map(inv => (
            <tr key={inv.id}>
              <td className="font-semibold text-sm text-primary" style={{ paddingLeft: '24px' }}>{inv.invoiceNo}</td>
              <td className="font-medium">{inv.student?.firstName} {inv.student?.lastName}</td>
              <td>{inv.student?.admissionNo}</td>
              <td className="text-sm">{new Date(inv.createdAt).toLocaleDateString()}</td>
              <td className={`text-sm ${inv.status==='OVERDUE' ? 'text-danger font-semibold' : ''}`}>{new Date(inv.dueDate).toLocaleDateString()}</td>
              <td className="font-bold">₹{Number(inv.totalAmount).toLocaleString()}</td>
              <td><span className={`badge ${inv.status==='PAID'?'badge-success':inv.status==='OVERDUE'?'badge-danger':inv.status==='PENDING'?'badge-warning':'badge-gray'}`}>{inv.status || 'DRAFT'}</span></td>
            </tr>
          ))}
          {filteredInvoices.length === 0 && (
            <tr><td colSpan={7} className="text-center text-gray py-8">No invoices found.</td></tr>
          )}
        </tbody></table></div></div>
      </div>
    </>
  );
}
