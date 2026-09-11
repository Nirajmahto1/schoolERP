'use client';
import Topbar from '@/components/Topbar';
import { useState, useEffect, useCallback } from 'react';
import { hrApi } from '@/lib/api';
import { useLoading } from '@/context/LoadingContext';

const ROLES = ['Teacher', 'Principal', 'Accountant', 'Librarian', 'Transport Manager', 'Lab Assistant', 'Clerk', 'Peon', 'Security'];
const DEPARTMENTS = ['Mathematics', 'Science', 'English', 'Hindi', 'Social Science', 'Computer Science', 'Physical Ed.', 'Arts', 'Administration', 'Finance', 'Library', 'Transport'];
const GENDERS = ['MALE', 'FEMALE', 'OTHER'];

export default function StaffPage() {
  const { startLoading, stopLoading } = useLoading();
  const [staff, setStaff] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filterDept, setFilterDept] = useState('All');
  const [showAdd, setShowAdd] = useState(false);

  const defaultForm = {
    firstName: '', lastName: '', role: 'Teacher', dept: 'Mathematics',
    phone: '', email: '', gender: 'MALE', dateOfBirth: '',
    address: '', password: '',
    qualification: '', experience: '0',
    identityType: 'Aadhar', identityNumber: '',
  };
  const [form, setForm] = useState(defaultForm);
  const set = (k: string, v: string) => setForm(prev => ({ ...prev, [k]: v }));

  const fetchStaff = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      // /hr list supports q + department server-side (q searches name/employeeId).
      const result = await hrApi.list({ q: search || undefined, department: filterDept !== 'All' ? filterDept : undefined });
      setStaff(result.data);
    } catch (err: any) {
      setError(err?.detail || err?.message || 'Failed to load staff.');
      setStaff([]);
    }
    setLoading(false);
  }, [search, filterDept]);

  useEffect(() => { fetchStaff(); }, [fetchStaff]);

  const filtered = staff.filter(s => {
    const name = `${s.firstName} ${s.lastName}`.toLowerCase();
    const matchSearch = name.includes(search.toLowerCase()) || s.employeeId?.toLowerCase().includes(search.toLowerCase());
    return matchSearch;
  });

  const autoGenPassword = () => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789@#$';
    let pwd = '';
    for (let i = 0; i < 10; i++) pwd += chars.charAt(Math.floor(Math.random() * chars.length));
    set('password', pwd);
  };

  const addStaff = async () => {
    if (!form.firstName || !form.lastName) { alert('Please enter both First and Last name.'); return; }
    if (!form.dateOfBirth) { alert('Please enter Date of Birth.'); return; }
    if (!form.phone) { alert('Please enter Phone number.'); return; }

    startLoading('Adding staff member...');
    try {
      // /hr create contract (staffSchema): employeeId is unique per branch.
      await hrApi.create({
        employeeId: `EMP-${Date.now()}`,
        firstName: form.firstName,
        lastName: form.lastName,
        dateOfBirth: new Date(form.dateOfBirth).toISOString(),
        gender: form.gender,
        designation: form.role,
        department: form.dept,
        qualification: form.qualification || undefined,
        experience: parseInt(form.experience) || 0,
        joinDate: new Date().toISOString(),
        salary: 30000,
        address: form.address || 'New Delhi',
        phone: form.phone,
        email: form.email || undefined,
      });
      await fetchStaff();
      setForm(defaultForm);
      setShowAdd(false);
    } catch (err: any) { alert(err.detail || 'Failed to add staff'); }
    stopLoading();
  };

  // HR records are soft-deleted; the /hr list hides deletedAt rows. (A
  // dedicated delete endpoint is a Phase-4 follow-up — hide the action for now.)
  const deleteStaffMember = (_id: string) => {
    alert('Staff records are soft-deleted from the HR console. Contact your administrator for deactivations.');
  };

  const departments = [...new Set(staff.map(s => s.department))];
  const isTeacher = form.role === 'Teacher' || form.role === 'Lab Assistant';

  return (
    <>
      <Topbar title="Staff & HR" subtitle="Manage staff records and HR operations" />
      <div style={{ padding: '24px 32px' }}>
        <div className="grid grid-4 gap-4 mb-6">
          {[{ l: 'Total Staff', v: String(staff.length), c: '#5048E5' }, { l: 'Active', v: String(staff.filter(s => s.isActive).length), c: '#10B981' }, { l: 'On Leave', v: String(staff.filter(s => !s.isActive).length), c: '#F59E0B' }, { l: 'Departments', v: String(departments.length), c: '#3B82F6' }].map(s => (
            <div key={s.l} className="stat-card" style={{ borderLeftColor: s.c }}><div className="stat-icon" style={{ background: s.c + '15', color: s.c }}><span className="icon">badge</span></div><div><div className="stat-value">{s.v}</div><div className="stat-label">{s.l}</div></div></div>
          ))}
        </div>

        <div className="flex items-center justify-between mb-4" style={{ flexWrap: 'wrap', gap: 12 }}>
          <div className="flex gap-3"><div className="search-bar"><span className="icon">search</span><input placeholder="Search staff..." value={search} onChange={e => setSearch(e.target.value)} /></div>
            <select className="select" style={{ width: 160 }} value={filterDept} onChange={e => setFilterDept(e.target.value)}><option value="All">All Departments</option>{departments.map(d => <option key={d}>{d}</option>)}</select>
          </div>
          <button className="btn btn-primary" onClick={() => setShowAdd(!showAdd)}><span className="icon icon-sm">{showAdd ? 'close' : 'person_add'}</span>{showAdd ? 'Cancel' : 'Add Staff'}</button>
        </div>

        {showAdd && (
          <div className="card mb-6 animate-fadeIn" style={{ border: '2px solid var(--primary)' }}>
            <div className="card-body">
              <h3 className="mb-4 flex items-center gap-2 pb-4 border-b"><span className="icon text-primary">person_add</span> New Staff Member</h3>

              {/* 1. Personal Details */}
              <h4 className="text-sm font-bold text-gray mb-3 uppercase tracking-wide">1. Personal Details</h4>
              <div className="grid grid-3 gap-4 mb-4">
                <div className="input-group"><label className="input-label">First Name *</label><input className="input" value={form.firstName} onChange={e => set('firstName', e.target.value)} placeholder="Ex: Sanjay" /></div>
                <div className="input-group"><label className="input-label">Last Name *</label><input className="input" value={form.lastName} onChange={e => set('lastName', e.target.value)} placeholder="Ex: Mahto" /></div>
                <div className="input-group"><label className="input-label">Date of Birth *</label><input type="date" className="input" value={form.dateOfBirth} onChange={e => set('dateOfBirth', e.target.value)} /></div>
              </div>
              <div className="grid grid-3 gap-4 mb-6">
                <div className="input-group"><label className="input-label">Gender</label>
                  <select className="select" value={form.gender} onChange={e => set('gender', e.target.value)}>
                    {GENDERS.map(g => <option key={g} value={g}>{g === 'MALE' ? 'Male' : g === 'FEMALE' ? 'Female' : 'Other'}</option>)}
                  </select>
                </div>
                <div className="input-group"><label className="input-label">Phone *</label><input className="input" value={form.phone} onChange={e => set('phone', e.target.value)} placeholder="10-digit number" /></div>
                <div className="input-group"><label className="input-label">Email</label><input className="input" type="email" value={form.email} onChange={e => set('email', e.target.value)} placeholder="Will auto-generate if blank" /></div>
              </div>

              {/* 2. Role & Department */}
              <h4 className="text-sm font-bold text-gray mb-3 uppercase tracking-wide">2. Role & Department</h4>
              <div className="grid grid-3 gap-4 mb-6">
                <div className="input-group"><label className="input-label">Role *</label>
                  <select className="select" value={form.role} onChange={e => set('role', e.target.value)}>
                    {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                  </select>
                </div>
                <div className="input-group"><label className="input-label">Department</label>
                  <select className="select" value={form.dept} onChange={e => set('dept', e.target.value)}>
                    {DEPARTMENTS.map(d => <option key={d} value={d}>{d}</option>)}
                  </select>
                </div>
                <div className="input-group"><label className="input-label">Address</label><input className="input" value={form.address} onChange={e => set('address', e.target.value)} placeholder="Residential address" /></div>
              </div>

              {/* 3. Conditional: Teacher Qualifications */}
              {isTeacher && (
                <div style={{ padding: '20px 24px', background: '#F0F9FF', borderRadius: 12, border: '1px solid #BAE6FD', marginBottom: 24 }}>
                  <h4 className="text-sm font-bold uppercase tracking-wide m-0 mb-3" style={{ color: '#0369A1' }}>3. Qualification & Proofs (Teacher/Lab)</h4>
                  <div className="grid grid-3 gap-4">
                    <div className="input-group"><label className="input-label">Qualification *</label>
                      <select className="select" value={form.qualification} onChange={e => set('qualification', e.target.value)}>
                        <option value="">Select...</option>
                        <option>B.Ed</option><option>M.Ed</option><option>B.Sc + B.Ed</option><option>M.Sc + B.Ed</option>
                        <option>B.A + B.Ed</option><option>M.A + B.Ed</option><option>Ph.D</option><option>D.El.Ed</option><option>Other</option>
                      </select>
                    </div>
                    <div className="input-group"><label className="input-label">Teaching Experience (years)</label><input className="input" type="number" min="0" value={form.experience} onChange={e => set('experience', e.target.value)} /></div>
                    <div className="input-group"><label className="input-label">Qualification Proof</label>
                      <div style={{ border: '2px dashed #BAE6FD', borderRadius: 8, padding: '10px 16px', textAlign: 'center', cursor: 'pointer', color: '#0284C7', fontSize: 13 }}>
                        <span className="icon icon-sm" style={{ verticalAlign: 'middle' }}>upload_file</span> Upload Certificate
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* 4. Identity Proof */}
              <div style={{ padding: '20px 24px', background: 'var(--gray-50)', borderRadius: 12, border: '1px solid #E5E7EB', marginBottom: 24 }}>
                <h4 className="text-sm font-bold text-gray uppercase tracking-wide m-0 mb-3">{isTeacher ? '4' : '3'}. Identity Proof</h4>
                <div className="grid grid-3 gap-4">
                  <div className="input-group"><label className="input-label">ID Type</label>
                    <select className="select" value={form.identityType} onChange={e => set('identityType', e.target.value)}>
                      <option>Aadhar</option><option>PAN Card</option><option>Voter ID</option><option>Driving License</option><option>Passport</option>
                    </select>
                  </div>
                  <div className="input-group"><label className="input-label">{form.identityType} Number</label><input className="input" value={form.identityNumber} onChange={e => set('identityNumber', e.target.value)} placeholder={`Enter ${form.identityType} number`} /></div>
                  <div className="input-group"><label className="input-label">{form.identityType} Upload</label>
                    <div style={{ border: '2px dashed #D1D5DB', borderRadius: 8, padding: '10px 16px', textAlign: 'center', cursor: 'pointer', color: '#6B7280', fontSize: 13 }}>
                      <span className="icon icon-sm" style={{ verticalAlign: 'middle' }}>upload_file</span> Upload {form.identityType}
                    </div>
                  </div>
                </div>
              </div>

              {/* 5. Login Password */}
              <h4 className="text-sm font-bold text-gray mb-3 uppercase tracking-wide">{isTeacher ? '5' : '4'}. Login Credentials</h4>
              <div className="grid grid-3 gap-4 mb-6">
                <div className="input-group" style={{ gridColumn: 'span 2' }}>
                  <label className="input-label">Portal Password <span className="text-gray" style={{ fontWeight: 400 }}>(Default: staff123)</span></label>
                  <div className="flex gap-2">
                    <input className="input" style={{ flex: 1 }} value={form.password} onChange={e => set('password', e.target.value)} placeholder="Enter custom password or auto-generate..." />
                    <button className="btn btn-secondary" onClick={autoGenPassword}><span className="icon icon-sm">password</span>Auto-Gen</button>
                  </div>
                </div>
              </div>

              <div className="flex justify-end gap-3 pt-4 border-t">
                <button className="btn btn-secondary" onClick={() => { setShowAdd(false); setForm(defaultForm); }}>Cancel</button>
                <button className="btn btn-primary" onClick={addStaff}><span className="icon icon-sm">save</span>Register Staff Member</button>
              </div>
            </div>
          </div>
        )}

        {error && (
          <div className="card mb-4" style={{ padding: 24, background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 12 }}>
            <div className="flex items-center gap-3">
              <span className="icon" style={{ color: '#EF4444' }}>error</span>
              <div><div style={{ fontWeight: 600, color: '#991B1B' }}>Connection Error</div><div style={{ fontSize: 14, color: '#B91C1C' }}>{error}</div></div>
              <button className="btn btn-sm btn-secondary" style={{ marginLeft: 'auto' }} onClick={fetchStaff}><span className="icon icon-sm">refresh</span>Retry</button>
            </div>
          </div>
        )}

        {loading ? (
          <div className="card" style={{ padding: 48, textAlign: 'center' }}><span className="icon" style={{ fontSize: 32, color: '#5048E5', animation: 'spin 1s linear infinite' }}>progress_activity</span><p style={{ marginTop: 12, color: '#6B7280' }}>Loading staff...</p></div>
        ) : !error && (
          <div className="card"><div className="table-wrapper"><table className="table"><thead><tr><th>#</th><th>Name</th><th>Department</th><th>Role</th><th>Contact</th><th>Joined</th><th>Status</th><th>Actions</th></tr></thead><tbody>
            {filtered.map((s, i) => (
              <tr key={s.id}><td>{i + 1}</td>
                <td><div className="flex items-center gap-3"><div className="avatar avatar-sm">{s.firstName?.[0]}{s.lastName?.[0]}</div><div><span className="font-semibold">{s.firstName} {s.lastName}</span><div className="text-xs text-gray">{s.employeeId}</div></div></div></td>
                <td><span className="badge badge-primary">{s.department}</span></td><td className="text-sm">{s.designation}</td><td className="text-sm">{s.phone}</td><td className="text-sm">{new Date(s.joinDate).toLocaleDateString('en-IN')}</td>
                <td><span className={`badge ${s.isActive ? 'badge-success' : 'badge-warning'}`}>{s.isActive ? 'Active' : 'On Leave'}</span></td>
                <td><div className="flex gap-2"><button className="btn btn-sm btn-ghost"><span className="icon icon-sm text-primary">visibility</span></button><button className="btn btn-sm btn-ghost" onClick={() => deleteStaffMember(s.id)}><span className="icon icon-sm text-danger">delete</span></button></div></td>
              </tr>
            ))}
            {filtered.length === 0 && <tr><td colSpan={8} style={{ textAlign: 'center', padding: 24, color: '#9CA3AF' }}>No staff found</td></tr>}
          </tbody></table></div></div>
        )}
      </div>
    </>
  );
}
