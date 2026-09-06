'use client';
import Topbar from '@/components/Topbar';
import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { studentApi, academicApi, parentApi } from '@/lib/api';
import { useLoading } from '@/context/LoadingContext';

export default function StudentsPage() {
  const router = useRouter();
  const { startLoading, stopLoading } = useLoading();
  const [students, setStudents] = useState<any[]>([]);
  const [classes, setClasses] = useState<any[]>([]);
  const [parents, setParents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  const [search, setSearch] = useState('');
  const [filterClass, setFilterClass] = useState('All');
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [totalCount, setTotalCount] = useState(0);

  const [parentMode, setParentMode] = useState<'new'|'existing'>('new');
  const [parentSearch, setParentSearch] = useState('');

  const [newStudent, setNewStudent] = useState({ 
    firstName: '', 
    lastName: '', 
    dateOfBirth: '',
    classId: '', 
    sectionId: '', 
    gender: 'Male', 
    email: '', 
    phone: '',
    studentPassword: '',
    
    // Parent info
    parentId: '',
    fatherName: '',
    fatherPhone: '',
    parentDob: '',
    parentPassword: '',
    address: 'New Delhi'
  });

  const fetchInitialData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [studentsRes, classesRes, parentsRes] = await Promise.all([
        studentApi.list({ search: search || undefined, limit: 50 }),
        academicApi.getClasses(),
        parentApi.list()
      ]);
      setStudents(studentsRes.data);
      setTotalCount(studentsRes.meta.total);
      
      const academicClasses = classesRes.data || [];
      setClasses(academicClasses);
      setParents(parentsRes.data || []);

      if (academicClasses.length > 0) {
        setNewStudent(prev => {
          if (prev.classId) return prev;
          return {
            ...prev,
            classId: academicClasses[0].id,
            sectionId: academicClasses[0].sections?.[0]?.id || '',
          };
        });
      }

    } catch (err: any) {
      setError(err?.detail || err?.message || 'Failed to load directory. Please ensure backend services are running.');
      setStudents([]);
      setTotalCount(0);
    }
    setLoading(false);
  }, [search]); 

  useEffect(() => { fetchInitialData(); }, [fetchInitialData]);

  // Handle Parent Search debouncing manually
  useEffect(() => {
    if (!parentSearch) {
      parentApi.list().then(res => setParents(res.data || [])).catch(()=>null);
      return;
    }
    const timer = setTimeout(() => {
      parentApi.list(parentSearch).then(res => setParents(res.data || [])).catch(()=>null);
    }, 500);
    return () => clearTimeout(timer);
  }, [parentSearch]);

  const filtered = students.filter(s => {
    const name = `${s.firstName} ${s.lastName}`.toLowerCase();
    const matchSearch = name.includes(search.toLowerCase()) || s.admissionNo.toLowerCase().includes(search.toLowerCase());
    const matchClass = filterClass === 'All' || s.classId === filterClass;
    return matchSearch && matchClass;
  });

  const autoGenPassword = (type: 'student' | 'parent') => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789@#$';
    let pwd = '';
    for(let i=0; i<8; i++) pwd += chars.charAt(Math.floor(Math.random() * chars.length));
    if (type === 'student') setNewStudent(prev => ({...prev, studentPassword: pwd}));
    else setNewStudent(prev => ({...prev, parentPassword: pwd}));
  };

  const addStudent = async () => {
    if (!newStudent.firstName || !newStudent.lastName) { alert('Please enter both First and Last Name.'); return; }
    if (!newStudent.classId || !newStudent.sectionId) { alert('Please select a valid Class and Section.'); return; }
    if (!newStudent.dateOfBirth) { alert('Please enter student Date of Birth.'); return; }
    
    if (parentMode === 'new' && (!newStudent.fatherName || !newStudent.fatherPhone)) { 
      alert('Please enter newly assigned parent details.'); return; 
    }
    if (parentMode === 'existing' && !newStudent.parentId) {
      alert('Please select an existing parent from the list.'); return;
    }

    startLoading('Registering new student...');
    try {
      const payload: any = {
        admissionNo: `DPS-${Date.now()}`,
        firstName: newStudent.firstName,
        lastName: newStudent.lastName,
        dateOfBirth: new Date(newStudent.dateOfBirth).toISOString(),
        gender: newStudent.gender.toUpperCase(),
        classId: newStudent.classId,
        sectionId: newStudent.sectionId,
        address: newStudent.address,
        phone: newStudent.phone,
        email: newStudent.email || `${newStudent.firstName.toLowerCase()}@student.dps.edu.in`,
        admissionDate: new Date().toISOString(),
      };

      if (newStudent.studentPassword) payload.studentPassword = newStudent.studentPassword;

      if (parentMode === 'existing') {
        payload.parentId = newStudent.parentId;
      } else {
        payload.parent = {
          fatherName: newStudent.fatherName,
          fatherPhone: newStudent.fatherPhone,
          address: newStudent.address,
        };
        if (newStudent.parentDob) payload.parent.dateOfBirth = new Date(newStudent.parentDob).toISOString();
        if (newStudent.parentPassword) payload.parentPassword = newStudent.parentPassword;
      }

      await studentApi.create(payload);
      await fetchInitialData();
      setShowAdd(false);
      setNewStudent({ 
        firstName: '', lastName: '', dateOfBirth: '', classId: classes[0]?.id || '', sectionId: classes[0]?.sections?.[0]?.id || '', 
        gender: 'Male', email: '', phone: '', studentPassword: '', 
        parentId: '', fatherName: '', fatherPhone: '', parentDob: '', parentPassword: '', address: 'New Delhi' 
      });
    } catch (err: any) {
      alert(err.detail || 'Failed to register student');
    }
    stopLoading();
  };

  const deleteStudent = async (id: string) => {
    if (!confirm('Delete this student?')) return;
    startLoading('Deleting student...');
    try {
      await studentApi.delete(id);
      await fetchInitialData();
    } catch (err: any) { alert(err.detail || 'Failed to delete'); }
    stopLoading();
  };

  const toggleStatus = async (id: string) => {
    const student = students.find(s => s.id === id);
    if (!student) return;
    startLoading('Updating status...');
    try {
      await studentApi.update(id, { isActive: !student.isActive });
      await fetchInitialData();
    } catch (err: any) { alert(err.detail || 'Failed to update'); }
    stopLoading();
  };

  return (
    <>
      <Topbar title="Students Directory" subtitle="Manage student records and enrollment" />
      <div style={{ padding: '24px 32px' }}>
        {/* Stats */}
        <div className="grid grid-4 gap-4 mb-6">
          {[
            { l: 'Total Students', v: String(totalCount || students.length), c: '#5048E5' },
            { l: 'Active', v: String(students.filter(s => s.isActive).length), c: '#10B981' },
            { l: 'Class 10', v: String(students.filter(s => s.class?.name?.includes('10')).length), c: '#F59E0B' },
            { l: 'Inactive', v: String(students.filter(s => !s.isActive).length), c: '#EF4444' }
          ].map(s => (
            <div key={s.l} className="stat-card" style={{ borderLeftColor: s.c }}><div className="stat-icon" style={{ background: s.c + '15', color: s.c }}><span className="icon">group</span></div><div><div className="stat-value">{s.v}</div><div className="stat-label">{s.l}</div></div></div>
          ))}
        </div>

        {/* Search & Add */}
        <div className="flex items-center justify-between mb-4" style={{ flexWrap: 'wrap', gap: 12 }}>
          <div className="flex gap-3 items-center" style={{ flexWrap: 'wrap' }}>
            <div className="search-bar"><span className="icon">search</span><input placeholder="Search by name, admission no..." value={search} onChange={e => setSearch(e.target.value)} /></div>
            <select className="select" style={{ width: 130 }} value={filterClass} onChange={e => setFilterClass(e.target.value)}>
              <option value="All">All Classes</option>
              {classes.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <button className="btn btn-primary" onClick={() => { setShowAdd(!showAdd); setEditId(null); }}><span className="icon icon-sm">{showAdd ? 'close' : 'person_add'}</span>{showAdd ? 'Cancel' : 'Register Student'}</button>
        </div>

        {/* Add Form */}
        {showAdd && (
          <div className="card mb-6 animate-fadeIn" style={{ border: '2px solid var(--primary)' }}>
            <div className="card-body">
              <h3 className="mb-4 flex items-center gap-2 pb-4 border-b"><span className="icon text-primary">person_add</span> {editId ? 'Edit Student' : 'New Student Admission'}</h3>
              
              <h4 className="text-sm font-bold text-gray mb-3 uppercase tracking-wide">1. Student Details</h4>
              <div className="grid grid-3 gap-4 mb-4">
                <div className="input-group"><label className="input-label">First Name *</label><input className="input" value={newStudent.firstName} onChange={e => setNewStudent({ ...newStudent, firstName: e.target.value })} placeholder="Ex: Rahul" /></div>
                <div className="input-group"><label className="input-label">Last Name *</label><input className="input" value={newStudent.lastName} onChange={e => setNewStudent({ ...newStudent, lastName: e.target.value })} placeholder="Ex: Sharma" /></div>
                <div className="input-group"><label className="input-label">Date of Birth *</label><input type="date" className="input" value={newStudent.dateOfBirth} onChange={e => setNewStudent({ ...newStudent, dateOfBirth: e.target.value })} /></div>
              </div>

              <div className="grid grid-3 gap-4 mb-4">
                <div className="input-group"><label className="input-label">Gender</label>
                  <select className="select" value={newStudent.gender} onChange={e => setNewStudent({ ...newStudent, gender: e.target.value })}>
                    <option>Male</option><option>Female</option><option>Other</option>
                  </select>
                </div>
                <div className="input-group"><label className="input-label">Class *</label>
                  <select className="select" value={newStudent.classId} onChange={e => {
                    const cls = classes.find(c => c.id === e.target.value);
                    setNewStudent({ ...newStudent, classId: e.target.value, sectionId: cls?.sections?.[0]?.id || '' });
                  }}>
                    {classes.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
                <div className="input-group"><label className="input-label">Section *</label>
                  <select className="select" value={newStudent.sectionId} onChange={e => setNewStudent({ ...newStudent, sectionId: e.target.value })}>
                    {classes.find(c => c.id === newStudent.classId)?.sections?.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </div>
              </div>

              <div className="grid grid-3 gap-4 mb-6">
                <div className="input-group"><label className="input-label">Student Phone</label><input className="input" value={newStudent.phone} onChange={e => setNewStudent({ ...newStudent, phone: e.target.value })} placeholder="(Optional)" /></div>
                <div className="input-group" style={{ gridColumn: 'span 2' }}>
                  <label className="input-label">Student App Password <span className="text-gray" style={{fontWeight:400}}>(Default: student123)</span></label>
                  <div className="flex gap-2">
                    <input className="input" style={{flex:1}} value={newStudent.studentPassword} onChange={e => setNewStudent({ ...newStudent, studentPassword: e.target.value })} placeholder="Enter custom password..." />
                    <button className="btn btn-secondary" onClick={() => autoGenPassword('student')}><span className="icon icon-sm">password</span>Auto-Gen</button>
                  </div>
                </div>
              </div>

              {/* PARENT SECTION */}
              <div style={{ padding: '24px', background: 'var(--gray-50)', borderRadius: 12, border: '1px solid #E5E7EB', marginBottom: 24 }}>
                <div className="flex items-center justify-between mb-4">
                  <h4 className="text-sm font-bold text-gray uppercase tracking-wide m-0">2. Parent Information</h4>
                  <div className="flex gap-2 bg-white rounded flex-wrap" style={{ padding: 4, border: '1px solid #E5E7EB' }}>
                    <button style={{ border: 'none', background: parentMode === 'new' ? '#EFF6FF' : 'transparent', color: parentMode === 'new' ? '#3B82F6' : '#6B7280', padding: '4px 12px', borderRadius: 4, fontWeight: 600, fontSize: 13, cursor: 'pointer' }} onClick={() => setParentMode('new')}>New Parent</button>
                    <button style={{ border: 'none', background: parentMode === 'existing' ? '#EFF6FF' : 'transparent', color: parentMode === 'existing' ? '#3B82F6' : '#6B7280', padding: '4px 12px', borderRadius: 4, fontWeight: 600, fontSize: 13, cursor: 'pointer' }} onClick={() => setParentMode('existing')}>Select Existing (Sibling)</button>
                  </div>
                </div>

                {parentMode === 'existing' ? (
                  <div className="grid gap-4">
                    <div className="input-group">
                      <label className="input-label">Search Database for Parent Profile</label>
                      <input className="input mb-2" placeholder="Search by Father/Mother Name or Phone..." value={parentSearch} onChange={e => setParentSearch(e.target.value)} />
                      <div style={{ maxHeight: 200, overflowY: 'auto', border: '1px solid #E5E7EB', background: '#fff', borderRadius: 8 }}>
                        {parents.length === 0 ? <div className="p-4 text-center text-sm text-gray">No parents found. try searching...</div> : parents.map(p => (
                          <div key={p.id} onClick={() => setNewStudent({...newStudent, parentId: p.id})} style={{ padding: '12px 16px', borderBottom: '1px solid #F3F4F6', cursor: 'pointer', background: newStudent.parentId === p.id ? '#EFF6FF' : 'transparent' }} className="hover:bg-gray-50 flex justify-between items-center">
                            <div>
                               <div className="font-semibold text-sm">{p.fatherName}</div>
                               <div className="text-xs text-gray">{p.fatherPhone} • Prev Siblings: {p.students?.length||0}</div>
                            </div>
                            {newStudent.parentId === p.id && <span className="icon text-primary icon-sm">check_circle</span>}
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="grid grid-3 gap-4 mb-4">
                      <div className="input-group"><label className="input-label">Father's Name *</label><input className="input" value={newStudent.fatherName} onChange={e => setNewStudent({ ...newStudent, fatherName: e.target.value })} placeholder="Ex: Rakesh Sharma" /></div>
                      <div className="input-group"><label className="input-label">Father's Phone *</label><input className="input" value={newStudent.fatherPhone} onChange={e => setNewStudent({ ...newStudent, fatherPhone: e.target.value })} placeholder="10-digit number" /></div>
                      <div className="input-group"><label className="input-label">Parent Date of Birth</label><input type="date" className="input" value={newStudent.parentDob} onChange={e => setNewStudent({ ...newStudent, parentDob: e.target.value })} /></div>
                    </div>
                    <div className="grid grid-3 gap-4">
                      <div className="input-group" style={{ gridColumn: 'span 1' }}><label className="input-label">Home Address</label><input className="input" value={newStudent.address} onChange={e => setNewStudent({ ...newStudent, address: e.target.value })} placeholder="Complete residential address" /></div>
                      <div className="input-group" style={{ gridColumn: 'span 2' }}>
                        <label className="input-label">Parent Web Portal Password <span className="text-gray" style={{fontWeight:400}}>(Optional)</span></label>
                        <div className="flex gap-2">
                          <input className="input" style={{flex:1}} value={newStudent.parentPassword} onChange={e => setNewStudent({ ...newStudent, parentPassword: e.target.value })} placeholder="Enter custom password..." />
                          <button className="btn btn-secondary" onClick={() => autoGenPassword('parent')}><span className="icon icon-sm">password</span>Auto-Gen</button>
                        </div>
                      </div>
                    </div>
                  </>
                )}
              </div>

              <div className="flex justify-end gap-3 pt-4 border-t">
                 <button className="btn btn-secondary" onClick={() => setShowAdd(false)}>Cancel</button>
                 <button className="btn btn-primary" onClick={addStudent}><span className="icon icon-sm">save</span>Complete Admission</button>
              </div>

            </div>
          </div>
        )}

        {/* Error State */}
        {error && (
          <div className="card mb-4" style={{ padding: 24, background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 12 }}>
            <div className="flex items-center gap-3">
              <span className="icon" style={{ color: '#EF4444' }}>error</span>
              <div>
                <div style={{ fontWeight: 600, color: '#991B1B' }}>Connection Error</div>
                <div style={{ fontSize: 14, color: '#B91C1C' }}>{error}</div>
              </div>
              <button className="btn btn-sm btn-secondary" style={{ marginLeft: 'auto' }} onClick={fetchInitialData}><span className="icon icon-sm">refresh</span>Retry</button>
            </div>
          </div>
        )}

        {/* Loading State */}
        {loading ? (
          <div className="card" style={{ padding: 48, textAlign: 'center' }}>
            <span className="icon" style={{ fontSize: 32, color: '#5048E5', animation: 'spin 1s linear infinite' }}>progress_activity</span>
            <p style={{ marginTop: 12, color: '#6B7280' }}>Loading directory...</p>
          </div>
        ) : !error && (
          <div className="card animate-fadeIn">
            <div className="table-wrapper"><table className="table"><thead><tr><th>#</th><th>Student Name</th><th>Admission No</th><th>Class</th><th>Gender</th><th>Parent Contact</th><th>Status</th><th>Actions</th></tr></thead><tbody>
              {filtered.map((s, i) => {
                const name = `${s.firstName} ${s.lastName}`;
                const cls = s.class ? `${s.class.name.replace('Class ', '')}-${s.section?.name || 'A'}` : 'N/A';
                const email = `${s.firstName?.toLowerCase()}.${s.lastName?.toLowerCase()}@student.dps.edu.in`;
                return (
                  <tr key={s.id}><td>{i + 1}</td>
                    <td><div className="flex items-center gap-3"><div className="avatar avatar-sm">{s.firstName?.[0]}{s.lastName?.[0]}</div><div><span className="font-semibold">{name}</span><div className="text-xs text-gray">{email}</div></div></div></td>
                    <td className="text-sm font-semibold text-primary">{s.admissionNo}</td><td><span className="badge badge-primary">{cls}</span></td><td className="text-sm">{s.gender === 'MALE' ? 'Male' : s.gender === 'FEMALE' ? 'Female' : 'Other'}</td>
                    <td>
                      <div className="text-sm font-medium">{s.parent?.fatherName || '—'}</div>
                      <div className="text-xs text-gray">{s.parent?.fatherPhone || '—'}</div>
                    </td>
                    <td><button className={`badge ${s.isActive ? 'badge-success' : 'badge-gray'}`} style={{ cursor: 'pointer', border: 'none' }} onClick={() => toggleStatus(s.id)}>{s.isActive ? 'Active' : 'Inactive'}</button></td>
                    <td><div className="flex gap-2">
                      <button className="btn btn-sm btn-ghost" title="View" onClick={() => router.push(`/dashboard/students/${s.id}`)}><span className="icon icon-sm text-primary">visibility</span></button>
                      <button className="btn btn-sm btn-ghost" title="Delete" onClick={() => deleteStudent(s.id)}><span className="icon icon-sm text-danger">delete</span></button>
                    </div></td>
                  </tr>
                );
              })}
              {filtered.length === 0 && <tr><td colSpan={8} style={{ textAlign: 'center', padding: 24, color: '#9CA3AF' }}>No students match your search</td></tr>}
            </tbody></table></div>
            <div className="card-footer pagination"><span className="pagination-info">Showing {filtered.length} of {totalCount || students.length} students</span>
              <div className="pagination-buttons">{[1, 2, 3].map(p => <button key={p} className={`pagination-btn ${p === page ? 'active' : ''}`} onClick={() => setPage(p)}>{p}</button>)}</div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
