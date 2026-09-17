'use client';
import Topbar from '@/components/Topbar';
import { useState, useEffect, useCallback, useRef } from 'react';
import { hrApi, analyticsApi } from '@/lib/api';
import { API_BASE } from '@/lib/api';
import { useLoading } from '@/context/LoadingContext';

const ROLES = ['Teacher', 'Principal', 'Accountant', 'Librarian', 'Transport Manager', 'Lab Assistant', 'Clerk', 'Peon', 'Security'];
const DEPARTMENTS = ['Mathematics', 'Science', 'English', 'Hindi', 'Social Science', 'Computer Science', 'Physical Ed.', 'Arts', 'Administration', 'Finance', 'Library', 'Transport'];
const GENDERS = ['MALE', 'FEMALE', 'OTHER'];

export default function StaffPage() {
  const { startLoading, stopLoading } = useLoading();
  const [staff, setStaff] = useState<any[]>([]);
  const [workload, setWorkload] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filterDept, setFilterDept] = useState('All');
  const [showAdd, setShowAdd] = useState(false);
  // Eye-button detail view: full HR record fetched on open.
  const [viewing, setViewing] = useState<any | null>(null);
  const [viewLoading, setViewLoading] = useState(false);
  const [viewError, setViewError] = useState<string | null>(null);

  const [staffDocs, setStaffDocs] = useState<any[]>([]);

  const viewStaff = async (id: string) => {
    setViewing(null); setViewLoading(true); setViewError(null); setStaffDocs([]);
    try {
      const [{ data }, docs] = await Promise.all([
        hrApi.get(id),
        hrApi.documents(id).catch(() => ({ data: [] })),
      ]);
      setViewing(data);
      setStaffDocs(docs.data ?? []);
    } catch (err: any) {
      setViewError(err?.detail || err?.message || 'Failed to load staff details.');
    }
    setViewLoading(false);
  };

  const defaultForm = {
    firstName: '', lastName: '', role: 'Teacher', dept: 'Mathematics',
    phone: '', email: '', gender: 'MALE', dateOfBirth: '',
    address: '', password: '',
    qualification: '', experience: '0',
    identityType: 'Aadhar', identityNumber: '',
    // Academic leadership ticks — in addition to the base role. A HOD is
    // usually still a teacher; these grant the academics permissions.
    isHod: false,
    isAcademicHead: false,
  };
  // Identity-proof file — uploaded to the document store after the staff row
  // exists (the create endpoint is JSON; the upload is its own multipart call).
  const [identityFile, setIdentityFile] = useState<File | null>(null);
  const identityInputRef = useRef<HTMLInputElement>(null);
  // Qualification certificate (Teacher/Lab section) — same document store,
  // typed as OTHER with a descriptive title.
  const [qualFile, setQualFile] = useState<File | null>(null);
  const qualInputRef = useRef<HTMLInputElement>(null);
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

  // Teaching load from analytics-service — periods/week per teacher from the
  // live timetable, joined to the HR list by employeeId.
  useEffect(() => {
    analyticsApi.getTeacherWorkload()
      .then((rows) => setWorkload(rows ?? []))
      .catch(() => setWorkload([])); // workload is enrichment — never block the HR list
  }, []);

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

  const pickIdentityFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    if (!file) { setIdentityFile(null); return; }
    const ok = ['application/pdf', 'image/jpeg', 'image/png'].includes(file.type);
    if (!ok) { alert('The ID proof must be a PDF, JPG or PNG file.'); e.target.value = ''; setIdentityFile(null); return; }
    if (file.size > 5 * 1024 * 1024) { alert('The ID proof must be 5 MB or smaller.'); e.target.value = ''; setIdentityFile(null); return; }
    setIdentityFile(file);
  };

  const clearIdentityFile = () => {
    setIdentityFile(null);
    if (identityInputRef.current) identityInputRef.current.value = '';
  };

  const pickQualFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    if (!file) { setQualFile(null); return; }
    const ok = ['application/pdf', 'image/jpeg', 'image/png'].includes(file.type);
    if (!ok) { alert('The certificate must be a PDF, JPG or PNG file.'); e.target.value = ''; setQualFile(null); return; }
    if (file.size > 5 * 1024 * 1024) { alert('The certificate must be 5 MB or smaller.'); e.target.value = ''; setQualFile(null); return; }
    setQualFile(file);
  };

  const clearQualFile = () => {
    setQualFile(null);
    if (qualInputRef.current) qualInputRef.current.value = '';
  };

  const addStaff = async () => {
    if (!form.firstName || !form.lastName) { alert('Please enter both First and Last name.'); return; }
    if (!form.dateOfBirth) { alert('Please enter Date of Birth.'); return; }
    if (!form.phone) { alert('Please enter Phone number.'); return; }

    startLoading('Adding staff member...');
    try {
      // /hr create contract (staffSchema): employeeId is unique per branch.
      const created = await hrApi.create({
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
        // The password the admin chose (or auto-generated) — the account is
        // usable at once. Server defaults to 'staff123' when omitted.
        password: form.password || undefined,
        // Leadership ticks → extra role assignments on the account.
        isHod: form.isHod || undefined,
        isAcademicHead: form.isAcademicHead || undefined,
      });
      // Documents upload after the row exists — a failed upload must not roll
      // back the staff record, but the user hears about it honestly.
      const uploadFailures: string[] = [];
      if (identityFile) {
        try {
          await hrApi.uploadDocument(created.id, identityFile, 'AADHAAR');
        } catch (upErr: any) {
          uploadFailures.push(`ID proof: ${upErr?.detail || upErr?.message || 'unknown error'}`);
        }
        clearIdentityFile();
      }
      if (qualFile) {
        try {
          await hrApi.uploadDocument(created.id, qualFile, 'OTHER');
        } catch (upErr: any) {
          uploadFailures.push(`Certificate: ${upErr?.detail || upErr?.message || 'unknown error'}`);
        }
        clearQualFile();
      }
      if (uploadFailures.length) {
        alert(`Staff saved, but some uploads failed:\n${uploadFailures.join('\n')}\nRe-upload from the staff profile.`);
      }
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

        {workload.length > 0 && (
          <div className="card mb-6 animate-fadeIn"><div className="card-body">
            <div className="flex items-center justify-between mb-4">
              <h3 className="m-0"><span className="icon icon-sm text-primary">balance</span> Teaching Load — periods/week from the live timetable</h3>
              <span className="text-sm text-gray">{workload.filter(w => w.periods_per_week > 0).length} teaching · {workload.length} total staff</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 12 }}>
              {workload.filter(w => w.periods_per_week > 0).map((w) => {
                const pct = Math.min(100, Math.round((Number(w.periods_per_week) / 36) * 100));
                const color = pct > 85 ? '#EF4444' : pct > 60 ? '#F59E0B' : '#10B981';
                return (
                  <div key={w.employeeId ?? w.teacher} style={{ padding: '10px 14px', background: 'var(--gray-50)', borderRadius: 10, border: '1px solid var(--gray-100)' }}>
                    <div className="flex justify-between items-center">
                      <span className="font-semibold" style={{ fontSize: '0.8125rem' }}>{w.teacher}</span>
                      <span className="font-bold" style={{ fontSize: '0.8125rem', color }}>{w.periods_per_week}/wk</span>
                    </div>
                    <div style={{ height: 5, background: 'var(--gray-100)', borderRadius: 3, marginTop: 6 }}>
                      <div style={{ height: '100%', width: `${Math.max(pct, 4)}%`, borderRadius: 3, background: color }}></div>
                    </div>
                    <div className="text-xs text-gray" style={{ marginTop: 4 }}>{w.subjects} subject{w.subjects === 1 ? '' : 's'} · {w.teaching_days} day{w.teaching_days === 1 ? '' : 's'}</div>
                  </div>
                );
              })}
            </div>
          </div></div>
        )}

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

              {/* Academic leadership — grants timetable builder, academics
                  and exam management on top of the base role. */}
              <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', padding: '12px 16px', background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 10, marginBottom: 24 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600, color: '#166534' }}>
                  <input
                    type="checkbox"
                    checked={form.isHod}
                    onChange={e => set('isHod', e.target.checked ? 'true' : '')}
                    style={{ width: 16, height: 16, accentColor: '#16A34A' }}
                  />
                  Head of Department (HOD) — can edit timetable & manage their department's academics
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600, color: '#166534' }}>
                  <input
                    type="checkbox"
                    checked={form.isAcademicHead}
                    onChange={e => set('isAcademicHead', e.target.checked ? 'true' : '')}
                    style={{ width: 16, height: 16, accentColor: '#16A34A' }}
                  />
                  Academic Head — oversees the whole academic program
                </label>
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
                    <div className="input-group"><label className="input-label">Qualification Proof (PDF/JPG/PNG, ≤ 5 MB)</label>
                      <input
                        ref={qualInputRef}
                        type="file"
                        accept="application/pdf,image/jpeg,image/png"
                        className="input"
                        style={{ padding: '8px', fontSize: 13 }}
                        onChange={pickQualFile}
                      />
                      {qualFile && (
                        <div className="flex items-center gap-2" style={{ marginTop: 4 }}>
                          <span className="text-xs text-gray" style={{ wordBreak: 'break-all' }}>{qualFile.name} ({Math.round(qualFile.size / 1024)} KB)</span>
                          <button type="button" className="btn btn-sm btn-ghost" onClick={clearQualFile}><span className="icon icon-sm text-danger">close</span></button>
                        </div>
                      )}
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
                  <div className="input-group"><label className="input-label">{form.identityType} Upload (PDF/JPG/PNG, ≤ 5 MB)</label>
                    <input
                      ref={identityInputRef}
                      type="file"
                      accept="application/pdf,image/jpeg,image/png"
                      className="input"
                      style={{ padding: '8px', fontSize: 13 }}
                      onChange={pickIdentityFile}
                    />
                    {identityFile && (
                      <div className="flex items-center gap-2" style={{ marginTop: 4 }}>
                        <span className="text-xs text-gray" style={{ wordBreak: 'break-all' }}>{identityFile.name} ({Math.round(identityFile.size / 1024)} KB)</span>
                        <button type="button" className="btn btn-sm btn-ghost" onClick={clearIdentityFile}><span className="icon icon-sm text-danger">close</span></button>
                      </div>
                    )}
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
                <td><div className="flex gap-2"><button className="btn btn-sm btn-ghost" title="View profile" onClick={() => viewStaff(s.id)}><span className="icon icon-sm text-primary">visibility</span></button><button className="btn btn-sm btn-ghost" onClick={() => deleteStaffMember(s.id)}><span className="icon icon-sm text-danger">delete</span></button></div></td>
              </tr>
            ))}
            {filtered.length === 0 && <tr><td colSpan={8} style={{ textAlign: 'center', padding: 24, color: '#9CA3AF' }}>No staff found</td></tr>}
          </tbody></table></div></div>
        )}

        {/* ── Staff detail modal (eye button) ── */}
        {(viewLoading || viewError || viewing) && (
          <div
            style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
            onClick={() => { setViewing(null); setViewError(null); }}
          >
            <div
              className="card"
              style={{ width: '100%', maxWidth: 640, maxHeight: '86vh', overflowY: 'auto', margin: 0 }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="card-body">
                {viewLoading && (
                  <div style={{ textAlign: 'center', padding: 32 }}>
                    <span className="icon" style={{ fontSize: 32, color: '#5048E5', animation: 'spin 1s linear infinite' }}>progress_activity</span>
                    <p style={{ marginTop: 12, color: '#6B7280' }}>Loading profile…</p>
                  </div>
                )}
                {viewError && (
                  <div style={{ textAlign: 'center', padding: 24 }}>
                    <span className="icon" style={{ fontSize: 32, color: '#EF4444' }}>error</span>
                    <p style={{ marginTop: 12, color: '#B91C1C' }}>{viewError}</p>
                    <button className="btn btn-secondary" onClick={() => { setViewing(null); setViewError(null); }}>Close</button>
                  </div>
                )}
                {viewing && (
                  <>
                    <div className="flex items-center gap-3 mb-4">
                      <div className="avatar">{viewing.firstName?.[0]}{viewing.lastName?.[0]}</div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <h3 className="m-0">{viewing.firstName} {viewing.lastName}</h3>
                        <div className="text-sm text-gray">{viewing.employeeId} · {viewing.designation} · {viewing.department}</div>
                      </div>
                      <button className="btn btn-sm btn-ghost" title="Close" onClick={() => setViewing(null)}>
                        <span className="icon">close</span>
                      </button>
                    </div>

                    <div className="grid grid-2 gap-4 mb-4">
                      <div><div className="text-xs text-gray uppercase">Gender</div><div className="font-semibold">{viewing.gender === 'MALE' ? 'Male' : viewing.gender === 'FEMALE' ? 'Female' : 'Other'}</div></div>
                      <div><div className="text-xs text-gray uppercase">Date of Birth</div><div className="font-semibold">{viewing.dateOfBirth ? new Date(viewing.dateOfBirth).toLocaleDateString('en-IN') : '—'}</div></div>
                      <div><div className="text-xs text-gray uppercase">Phone</div><div className="font-semibold">{viewing.phone || '—'}</div></div>
                      <div><div className="text-xs text-gray uppercase">Email</div><div className="font-semibold" style={{ wordBreak: 'break-all' }}>{viewing.email || '—'}</div></div>
                      <div><div className="text-xs text-gray uppercase">Joined</div><div className="font-semibold">{viewing.joinDate ? new Date(viewing.joinDate).toLocaleDateString('en-IN') : '—'}</div></div>
                      <div><div className="text-xs text-gray uppercase">Status</div><div><span className={`badge ${viewing.isActive ? 'badge-success' : 'badge-warning'}`}>{viewing.isActive ? 'Active' : 'On Leave'}</span></div></div>
                      <div style={{ gridColumn: 'span 2' }}><div className="text-xs text-gray uppercase">Address</div><div className="font-semibold">{viewing.address || '—'}</div></div>
                      <div><div className="text-xs text-gray uppercase">Qualification</div><div className="font-semibold">{viewing.qualification || '—'}</div></div>
                      <div><div className="text-xs text-gray uppercase">Experience</div><div className="font-semibold">{viewing.experience != null ? `${viewing.experience} year${viewing.experience === 1 ? '' : 's'}` : '—'}</div></div>
                      <div style={{ gridColumn: 'span 2' }}><div className="text-xs text-gray uppercase">Branches</div><div className="font-semibold">{(viewing.branchAssignments || []).map((ba: any) => ba.branch?.name).filter(Boolean).join(', ') || '—'}</div></div>
                    </div>

                    {/* Identity documents on file — download is access-logged. */}
                    <div className="mb-4">
                      <h4 className="text-sm font-bold text-gray uppercase mb-2">Identity Documents</h4>
                      {staffDocs.length === 0 && <span className="text-sm text-gray">No documents uploaded.</span>}
                      {staffDocs.map((d) => (
                        <div key={d.id} className="flex justify-between items-center" style={{ padding: '8px 0', borderBottom: '1px solid var(--gray-100)' }}>
                          <div style={{ minWidth: 0 }}>
                            <div className="text-sm font-semibold">{d.title}</div>
                            <div className="text-xs text-gray">{d.mimeType} · {d.sizeBytes ? `${Math.round(d.sizeBytes / 1024)} KB` : '—'} · {new Date(d.createdAt).toLocaleDateString('en-IN')}</div>
                          </div>
                          <a
                            className="btn btn-sm btn-secondary"
                            href={`${API_BASE.replace('/api/v1', '')}/api/v1/hr/documents/file/${d.s3Key.split('/').pop()}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            <span className="icon icon-sm">download</span> View
                          </a>
                        </div>
                      ))}
                    </div>

                    {viewing.leaveRequests?.length > 0 && (
                      <div className="mb-4">
                        <h4 className="text-sm font-bold text-gray uppercase mb-2">Recent Leave Requests</h4>
                        {viewing.leaveRequests.map((lr: any) => (
                          <div key={lr.id} className="flex justify-between items-center" style={{ padding: '8px 0', borderBottom: '1px solid var(--gray-100)' }}>
                            <span className="text-sm">{new Date(lr.startDate).toLocaleDateString('en-IN')} → {new Date(lr.endDate).toLocaleDateString('en-IN')}</span>
                            <span className={`badge ${lr.status === 'APPROVED' ? 'badge-success' : lr.status === 'REJECTED' ? 'badge-danger' : 'badge-warning'}`}>{lr.status}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {viewing.payrolls?.length > 0 && (
                      <div>
                        <h4 className="text-sm font-bold text-gray uppercase mb-2">Recent Payroll</h4>
                        {viewing.payrolls.map((p: any) => (
                          <div key={p.id} className="flex justify-between items-center" style={{ padding: '8px 0', borderBottom: '1px solid var(--gray-100)' }}>
                            <span className="text-sm">{p.month}/{p.year}</span>
                            <span className="font-semibold">₹{Number(p.netPay ?? p.grossSalary ?? 0).toLocaleString('en-IN')} <span className={`badge ${p.status === 'PAID' ? 'badge-success' : 'badge-warning'}`}>{p.status}</span></span>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
