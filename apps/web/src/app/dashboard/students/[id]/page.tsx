'use client';
import Topbar from '@/components/Topbar';
import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { studentApi, parentApi, aiApi } from '@/lib/api';
import { useLoading } from '@/context/LoadingContext';

export default function StudentProfilePage() {
  const { id } = useParams();
  const router = useRouter();
  const { startLoading, stopLoading } = useLoading();
  const [student, setStudent] = useState<any>(null);
  const [attendance, setAttendance] = useState<any>(null);
  const [performance, setPerformance] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Edit states
  const [showEditStudent, setShowEditStudent] = useState(false);
  const [editStudentForm, setEditStudentForm] = useState<any>({});
  
  const [showEditParent, setShowEditParent] = useState(false);
  const [editParentForm, setEditParentForm] = useState<any>({});

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const s = await studentApi.get(id as string);
      setStudent(s);

      // Initialize forms safely
      setEditStudentForm({
        firstName: s.firstName || '',
        lastName: s.lastName || '',
        dateOfBirth: s.dateOfBirth ? s.dateOfBirth.split('T')[0] : '',
        gender: s.gender || 'MALE',
        bloodGroup: s.bloodGroup || '',
        phone: s.phone || '',
        address: s.address || ''
      });

      if (s.parent) {
        setEditParentForm({
          fatherName: s.parent.fatherName || '',
          fatherPhone: s.parent.fatherPhone || '',
        });
      }

      if (s.attendances) {
        const total = s.attendances.length;
        const present = s.attendances.filter((a: any) => a.status === 'PRESENT').length;
        setAttendance({ rate: total > 0 ? Math.round((present / total) * 100) : 0, present, total });
      }

      try {
        const perf = await aiApi.getStudentPerformance(id as string);
        setPerformance(perf);
      } catch { setPerformance(null); }
    } catch (err: any) {
      setError(err?.detail || err?.message || 'Failed to load student profile.');
    }
    setLoading(false);
  }, [id]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleUpdateStudent = async () => {
    startLoading('Updating student profile...');
    try {
      await studentApi.update(id as string, {
        firstName: editStudentForm.firstName,
        lastName: editStudentForm.lastName,
        dateOfBirth: editStudentForm.dateOfBirth ? new Date(editStudentForm.dateOfBirth).toISOString() : undefined,
        gender: editStudentForm.gender,
        bloodGroup: editStudentForm.bloodGroup,
        phone: editStudentForm.phone,
        address: editStudentForm.address,
      });
      setShowEditStudent(false);
      await fetchData();
    } catch (err: any) {
      alert(err.detail || 'Failed to update student profile.');
    }
    stopLoading();
  };

  const handleUpdateParent = async () => {
    if (!student?.parent?.id) return;
    startLoading('Updating parent details...');
    try {
      await parentApi.update(student.parent.id, {
        fatherName: editParentForm.fatherName,
        fatherPhone: editParentForm.fatherPhone,
      });
      setShowEditParent(false);
      await fetchData();
    } catch (err: any) {
      alert(err.detail || 'Failed to update parent profile.');
    }
    stopLoading();
  };

  if (loading) return <div style={{ padding: 48, textAlign: 'center' }}><span className="icon" style={{ fontSize: 32, color: '#5048E5', animation: 'spin 1s linear infinite' }}>progress_activity</span><p style={{ marginTop: 12, color: '#6B7280' }}>Loading student profile...</p></div>;

  if (error) return (
    <div style={{ padding: '24px 32px' }}>
      <button className="btn btn-ghost mb-6" onClick={() => router.back()}><span className="icon icon-sm">arrow_back</span>Back</button>
      <div className="card" style={{ padding: 24, background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 12 }}>
        <div className="flex items-center gap-3">
          <span className="icon" style={{ color: '#EF4444' }}>error</span>
          <div><div style={{ fontWeight: 600, color: '#991B1B' }}>Error</div><div style={{ fontSize: 14, color: '#B91C1C' }}>{error}</div></div>
        </div>
      </div>
    </div>
  );

  if (!student) return <div className="p-8 text-center text-gray">Student not found</div>;

  return (
    <>
      <Topbar title={`${student.firstName} ${student.lastName}`} subtitle={`Student Profile • ${student.admissionNo}`} />
      <div style={{ padding: '24px 32px' }}>
        <button className="btn btn-ghost mb-6" onClick={() => router.back()}><span className="icon icon-sm">arrow_back</span>Back to Directory</button>

        <div className="flex gap-6 items-start" style={{ flexWrap: 'wrap' }}>
          <div className="card flex-2" style={{ minWidth: 400 }}>
            <div className="card-body">
              {/* Student Header */}
              <div className="flex items-center justify-between mb-8 pb-8 border-b">
                <div className="flex items-center gap-6">
                  <div className="avatar" style={{ width: 100, height: 100, fontSize: 32 }}>{student.firstName[0]}{student.lastName[0]}</div>
                  <div>
                    <h2 style={{ fontSize: 24, fontWeight: 700, marginBottom: 4 }}>{student.firstName} {student.lastName}</h2>
                    <div className="flex gap-2">
                      <span className="badge badge-primary">{student.class?.name || 'N/A'} - {student.section?.name || 'A'}</span>
                      <span className={`badge ${student.isActive ? 'badge-success' : 'badge-gray'}`}>{student.isActive ? 'Active' : 'Inactive'}</span>
                    </div>
                  </div>
                </div>
                <button className="btn btn-sm btn-secondary" onClick={() => setShowEditStudent(!showEditStudent)}>
                  <span className="icon icon-sm">{showEditStudent ? 'close' : 'edit'}</span>
                  {showEditStudent ? 'Cancel' : 'Edit Profile'}
                </button>
              </div>

              {/* Student Details Form or View */}
              {showEditStudent ? (
                <div className="grid grid-2 gap-4 animate-fadeIn pb-8 border-b mb-8">
                  <div className="input-group"><label className="input-label">First Name</label><input className="input" value={editStudentForm.firstName} onChange={e => setEditStudentForm({...editStudentForm, firstName: e.target.value})} /></div>
                  <div className="input-group"><label className="input-label">Last Name</label><input className="input" value={editStudentForm.lastName} onChange={e => setEditStudentForm({...editStudentForm, lastName: e.target.value})} /></div>
                  <div className="input-group"><label className="input-label">Date of Birth</label><input type="date" className="input" value={editStudentForm.dateOfBirth} onChange={e => setEditStudentForm({...editStudentForm, dateOfBirth: e.target.value})} /></div>
                  <div className="input-group"><label className="input-label">Gender</label>
                    <select className="select" value={editStudentForm.gender} onChange={e => setEditStudentForm({...editStudentForm, gender: e.target.value})}>
                      <option value="MALE">Male</option><option value="FEMALE">Female</option><option value="OTHER">Other</option>
                    </select>
                  </div>
                  <div className="input-group"><label className="input-label">Blood Group</label><input className="input" value={editStudentForm.bloodGroup} onChange={e => setEditStudentForm({...editStudentForm, bloodGroup: e.target.value})} /></div>
                  <div className="input-group"><label className="input-label">Phone</label><input className="input" value={editStudentForm.phone} onChange={e => setEditStudentForm({...editStudentForm, phone: e.target.value})} /></div>
                  <div className="input-group" style={{ gridColumn: 'span 2' }}><label className="input-label">Home Address</label><input className="input" value={editStudentForm.address} onChange={e => setEditStudentForm({...editStudentForm, address: e.target.value})} /></div>
                  <div style={{ gridColumn: 'span 2', display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
                    <button className="btn btn-primary" onClick={handleUpdateStudent}><span className="icon icon-sm">save</span> Save Changes</button>
                  </div>
                </div>
              ) : (
                <div className="grid grid-2 gap-y-6 pb-8 border-b mb-8">
                  <div><div className="text-xs text-gray uppercase font-semibold mb-1">Admission No</div><div className="font-semibold text-primary">{student.admissionNo}</div></div>
                  <div><div className="text-xs text-gray uppercase font-semibold mb-1">Roll Number</div><div className="font-semibold">{student.rollNo || '—'}</div></div>
                  <div><div className="text-xs text-gray uppercase font-semibold mb-1">Date of Birth</div><div className="text-sm">{new Date(student.dateOfBirth).toLocaleDateString('en-IN')}</div></div>
                  <div><div className="text-xs text-gray uppercase font-semibold mb-1">Gender</div><div className="text-sm">{student.gender}</div></div>
                  <div><div className="text-xs text-gray uppercase font-semibold mb-1">Blood Group</div><div className="text-sm">{student.bloodGroup || '—'}</div></div>
                  <div><div className="text-xs text-gray uppercase font-semibold mb-1">Phone</div><div className="text-sm">{student.phone || '—'}</div></div>
                  <div className="col-span-2"><div className="text-xs text-gray uppercase font-semibold mb-1">Home Address</div><div className="text-sm">{student.address}</div></div>
                </div>
              )}

              {/* Parent Details section */}
              {student.parent && (
                <>
                  <div className="flex items-center justify-between mb-4">
                     <h4 className="m-0 text-sm font-bold uppercase text-gray">Parent Details</h4>
                     <button className="btn btn-sm btn-ghost" onClick={() => setShowEditParent(!showEditParent)}>
                       <span className="icon icon-sm">{showEditParent ? 'close' : 'edit'}</span>
                       {showEditParent ? 'Cancel' : 'Edit Parent'}
                     </button>
                  </div>
                  {showEditParent ? (
                    <div className="grid grid-2 gap-4 animate-fadeIn">
                      <div className="input-group"><label className="input-label">Father's Name</label><input className="input" value={editParentForm.fatherName} onChange={e => setEditParentForm({...editParentForm, fatherName: e.target.value})} /></div>
                      <div className="input-group"><label className="input-label">Father's Contact</label><input className="input" value={editParentForm.fatherPhone} onChange={e => setEditParentForm({...editParentForm, fatherPhone: e.target.value})} /></div>
                      <div style={{ gridColumn: 'span 2', display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
                        <button className="btn btn-primary" onClick={handleUpdateParent}><span className="icon icon-sm">save</span> Update Parent</button>
                      </div>
                    </div>
                  ) : (
                    <div className="grid grid-2 gap-y-4">
                      <div><div className="text-xs text-gray font-semibold">Father&apos;s Name</div><div className="text-sm font-semibold">{student.parent.fatherName}</div></div>
                      <div><div className="text-xs text-gray font-semibold">Contact</div><div className="text-sm text-primary">{student.parent.fatherPhone}</div></div>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          <div className="flex-1" style={{ minWidth: 300, display: 'flex', flexDirection: 'column', gap: 24 }}>
            <div className="card">
              <div className="card-body">
                <h3 className="mb-4">Attendance Rate</h3>
                <div style={{ position: 'relative', width: 120, height: 120, margin: '0 auto' }}>
                   <div style={{ border: '8px solid #F3F4F6', borderRadius: '50%', width: '100%', height: '100%' }}></div>
                   <div style={{ border: '8px solid #10B981', borderRadius: '50%', width: '100%', height: '100%', position: 'absolute', top: 0, clipPath: `inset(0 0 0 ${100 - (attendance?.rate || 0)}%)` }}></div>
                   <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', fontWeight: 800, fontSize: 24 }}>{attendance?.rate || 0}%</div>
                </div>
                <div className="flex justify-between mt-6 text-xs font-semibold">
                  <div className="text-gray">PRESENT: {attendance?.present || 0}</div>
                  <div className="text-danger">ABSENT: {(attendance?.total || 0) - (attendance?.present || 0)}</div>
                </div>
              </div>
            </div>

            {performance && (
              <div className="card" style={{ background: 'linear-gradient(135deg, #1A1C2E 0%, #303456 100%)', color: 'white' }}>
                <div className="card-body">
                  <div className="flex items-center gap-2 mb-4">
                    <span className="icon" style={{ color: '#818CF8' }}>auto_awesome</span>
                    <h3 style={{ color: 'white' }}>AI Performance Analytics</h3>
                  </div>
                  <div className="mb-6">
                    <div className="text-4xl font-bold mb-1" style={{ color: '#818CF8' }}>{performance?.predictedFinalGrade || '—'}</div>
                    <div className="text-xs opacity-70 uppercase tracking-wider">Predicted Final Grade</div>
                  </div>
                  <div style={{ background: 'rgba(255,255,255,0.05)', borderRadius: 12, padding: 16 }}>
                    <div className="text-xs font-bold uppercase opacity-50 mb-2">Recommendation</div>
                    <p className="text-sm" style={{ lineHeight: 1.6 }}>{performance?.recommendedAction || 'Analyzing data...'}</p>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
