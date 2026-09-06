'use client';
import Topbar from '@/components/Topbar';
import { useState, useEffect, useCallback } from 'react';
import { useLoading } from '@/context/LoadingContext';
import { academicApi, staffApi } from '@/lib/api';

export default function AcademicsPage() {
  const { startLoading, stopLoading } = useLoading();
  const [activeTab, setActiveTab] = useState('Classes');
  
  const [classes, setClasses] = useState<any[]>([]);
  const [subjects, setSubjects] = useState<any[]>([]);
  const [examinations, setExaminations] = useState<any[]>([]);
  const [results, setResults] = useState<any[]>([]);
  const [teachers, setTeachers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Add Class Modal
  const [showAddClass, setShowAddClass] = useState(false);
  const [newClass, setNewClass] = useState({ name: '', numericOrder: 1, academicYearId: '', sections: [{ name: 'A', capacity: 40 }] });

  // Add Subject Modal
  const [showAddSubject, setShowAddSubject] = useState(false);
  const [newSubject, setNewSubject] = useState({ name: '', code: '', classId: '', type: 'THEORY', hodStaffId: '' });

  // Subject filter
  const [filterClassSubject, setFilterClassSubject] = useState('All');

  // Add Exam Modal
  const [showAddExam, setShowAddExam] = useState(false);
  const [newExam, setNewExam] = useState({ name: '', academicYearId: '', startDate: '', endDate: '', examType: 'Unit Test', examSubjects: [] as any[] });

  const fetchAcademics = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [classesRes, teachersRes] = await Promise.all([
        academicApi.getClasses(),
        staffApi.list()
      ]);
      setClasses(classesRes.data);
      setTeachers(teachersRes.data);

      if (activeTab === 'Subjects') {
        const res = await academicApi.getSubjects();
        setSubjects(res.data);
      } else if (activeTab === 'Examinations') {
        const res = await academicApi.getExaminations();
        setExaminations(res.data);
      } else if (activeTab === 'Results') {
        const examsRes = await academicApi.getExaminations();
        if (examsRes.data.length > 0) {
          const res = await academicApi.getResults(examsRes.data[0].id);
          setResults(res.data);
        } else { setResults([]); }
      }
    } catch (err: any) {
      setError(err?.detail || err?.message || 'Failed to load academic data.');
    } finally { setLoading(false); }
  }, [activeTab]);

  useEffect(() => { fetchAcademics(); }, [fetchAcademics]);

  // Get academic year from first class (they all share the same)
  const academicYearId = classes[0]?.academicYearId || '';

  // ── CLASS CRUD ──
  const addClass = async () => {
    if (!newClass.name) { alert('Please enter the class name'); return; }
    startLoading('Creating class...');
    try {
      await academicApi.createClass({
        name: newClass.name,
        numericOrder: newClass.numericOrder,
        academicYearId: academicYearId || newClass.academicYearId,
        sections: newClass.sections.filter(s => s.name),
      });
      setShowAddClass(false);
      setNewClass({ name: '', numericOrder: 1, academicYearId: '', sections: [{ name: 'A', capacity: 40 }] });
      await fetchAcademics();
    } catch (err: any) { alert(err.detail || 'Failed to create class'); }
    stopLoading();
  };

  const deleteClass = async (id: string) => {
    if (!confirm('Delete this class and all its sections/subjects?')) return;
    startLoading('Deleting...');
    try { await academicApi.deleteClass(id); await fetchAcademics(); }
    catch (err: any) { alert(err.detail || 'Failed to delete class'); }
    stopLoading();
  };

  // ── SUBJECT CRUD ──
  const addSubject = async () => {
    if (!newSubject.name || !newSubject.code || !newSubject.classId) { alert('Please fill all required fields.'); return; }
    startLoading('Creating subject...');
    try {
      await academicApi.createSubject(newSubject);
      setShowAddSubject(false);
      setNewSubject({ name: '', code: '', classId: '', type: 'THEORY', hodStaffId: '' });
      await fetchAcademics();
    } catch (err: any) { alert(err.detail || 'Failed to create subject'); }
    stopLoading();
  };

  const deleteSubject = async (id: string) => {
    if (!confirm('Delete this subject?')) return;
    startLoading('Deleting...');
    try { await academicApi.deleteSubject(id); await fetchAcademics(); }
    catch (err: any) { alert(err.detail || 'Failed to delete'); }
    stopLoading();
  };

  // ── EXAM CRUD ──
  const addExam = async () => {
    if (!newExam.name || !newExam.startDate || !newExam.endDate) { alert('Please fill all required fields.'); return; }
    startLoading('Creating examination...');
    try {
      await academicApi.createExamination({
        name: newExam.name,
        academicYearId: academicYearId || newExam.academicYearId,
        startDate: new Date(newExam.startDate).toISOString(),
        endDate: new Date(newExam.endDate).toISOString(),
        examSubjects: newExam.examSubjects.filter(es => es.subjectId),
      });
      setShowAddExam(false);
      setNewExam({ name: '', academicYearId: '', startDate: '', endDate: '', examType: 'Unit Test', examSubjects: [] });
      await fetchAcademics();
    } catch (err: any) { alert(err.detail || 'Failed to create examination'); }
    stopLoading();
  };

  const deleteExam = async (id: string) => {
    if (!confirm('Delete this examination?')) return;
    startLoading('Deleting...');
    try { await academicApi.deleteExamination(id); await fetchAcademics(); }
    catch (err: any) { alert(err.detail || 'Failed to delete'); }
    stopLoading();
  };

  const addSectionField = () => setNewClass(prev => ({ ...prev, sections: [...prev.sections, { name: '', capacity: 40 }] }));
  const removeSectionField = (i: number) => setNewClass(prev => ({ ...prev, sections: prev.sections.filter((_, idx) => idx !== i) }));

  const removeExamSubject = (i: number) => setNewExam(prev => ({ ...prev, examSubjects: prev.examSubjects.filter((_, idx) => idx !== i) }));
  const updateExamSubject = (i: number, field: string, val: any) => setNewExam(prev => ({ ...prev, examSubjects: prev.examSubjects.map((es, idx) => idx === i ? { ...es, [field]: val } : es) }));

  // Flatten all subjects from all classes for exam subject selection
  const allSubjects = classes.flatMap(c => (c.subjects || []).map((s: any) => ({ ...s, className: c.name })));

  const EXAM_TYPES = ['Unit Test', 'Mid Term', 'Final Exam', 'Weekly Test', 'Monthly Test', 'Pre-Board', 'Board Exam', 'Practice Test', 'Viva / Practical'];

  return (
    <>
      <Topbar title="Academics Data Hub" subtitle="Manage classes, subjects, examinations & results" />
      <div style={{ padding: '24px 32px' }}>
        <div className="flex items-center justify-between mb-4" style={{ flexWrap: 'wrap', gap: 12 }}>
          <div className="tabs">
            {['Classes', 'Subjects', 'Examinations', 'Results'].map(tab => (
              <button key={tab} className={`tab ${activeTab === tab ? 'active' : ''}`} onClick={() => { setActiveTab(tab); setShowAddClass(false); setShowAddSubject(false); setShowAddExam(false); }}>{tab}</button>
            ))}
          </div>
          <div className="flex gap-3">
            {activeTab === 'Classes' && <button className="btn btn-primary" onClick={() => setShowAddClass(!showAddClass)}><span className="icon icon-sm">{showAddClass ? 'close' : 'add'}</span>{showAddClass ? 'Cancel' : 'Add Class'}</button>}
            {activeTab === 'Subjects' && <button className="btn btn-primary" onClick={() => setShowAddSubject(!showAddSubject)}><span className="icon icon-sm">{showAddSubject ? 'close' : 'add'}</span>{showAddSubject ? 'Cancel' : 'Add Subject'}</button>}
            {activeTab === 'Examinations' && <button className="btn btn-primary" onClick={() => setShowAddExam(!showAddExam)}><span className="icon icon-sm">{showAddExam ? 'close' : 'add'}</span>{showAddExam ? 'Cancel' : 'Create Exam'}</button>}
          </div>
        </div>

        {error && (
          <div className="card mb-4" style={{ padding: 24, background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 12 }}>
            <div className="flex items-center gap-3"><span className="icon" style={{ color: '#EF4444' }}>error</span><div><div style={{ fontWeight: 600, color: '#991B1B' }}>Error</div><div style={{ fontSize: 14, color: '#B91C1C' }}>{error}</div></div>
              <button className="btn btn-sm btn-secondary" style={{ marginLeft: 'auto' }} onClick={fetchAcademics}><span className="icon icon-sm">refresh</span>Retry</button>
            </div>
          </div>
        )}

        {/* ── ADD CLASS MODAL ── */}
        {showAddClass && (
          <div className="card mb-6 animate-fadeIn" style={{ border: '2px solid var(--primary)' }}>
            <div className="card-body">
              <h3 className="mb-4 flex items-center gap-2 pb-4 border-b"><span className="icon text-primary">class</span> Add New Class</h3>
              <div className="grid grid-3 gap-4 mb-4">
                <div className="input-group"><label className="input-label">Class Name *</label><input className="input" placeholder="Ex: Class 11" value={newClass.name} onChange={e => setNewClass({...newClass, name: e.target.value})} /></div>
                <div className="input-group"><label className="input-label">Numeric Order</label><input type="number" className="input" value={newClass.numericOrder} onChange={e => setNewClass({...newClass, numericOrder: parseInt(e.target.value) || 1})} /></div>
                <div></div>
              </div>
              <h4 className="text-sm font-bold text-gray mb-3 uppercase tracking-wide">Sections</h4>
              {newClass.sections.map((s, i) => (
                <div key={i} className="flex gap-3 mb-2 items-end">
                  <div className="input-group" style={{flex:1}}><label className="input-label">Section Name</label><input className="input" placeholder="A" value={s.name} onChange={e => { const secs = [...newClass.sections]; secs[i] = {...secs[i], name: e.target.value}; setNewClass({...newClass, sections: secs}); }} /></div>
                  <div className="input-group" style={{flex:1}}><label className="input-label">Capacity</label><input type="number" className="input" value={s.capacity} onChange={e => { const secs = [...newClass.sections]; secs[i] = {...secs[i], capacity: parseInt(e.target.value) || 40}; setNewClass({...newClass, sections: secs}); }} /></div>
                  <button className="btn btn-sm btn-ghost" onClick={() => removeSectionField(i)}><span className="icon icon-sm text-danger">remove_circle</span></button>
                </div>
              ))}
              <button className="btn btn-sm btn-secondary mb-4" onClick={addSectionField}><span className="icon icon-sm">add</span>Add Section</button>
              <div className="flex justify-end gap-3 pt-4 border-t">
                <button className="btn btn-secondary" onClick={() => setShowAddClass(false)}>Cancel</button>
                <button className="btn btn-primary" onClick={addClass}><span className="icon icon-sm">save</span>Create Class</button>
              </div>
            </div>
          </div>
        )}

        {/* ── ADD SUBJECT MODAL ── */}
        {showAddSubject && (
          <div className="card mb-6 animate-fadeIn" style={{ border: '2px solid var(--primary)' }}>
            <div className="card-body">
              <h3 className="mb-4 flex items-center gap-2 pb-4 border-b"><span className="icon text-primary">menu_book</span> Add New Subject</h3>
              <div className="grid grid-3 gap-4 mb-4">
                <div className="input-group"><label className="input-label">Subject Name *</label><input className="input" placeholder="Ex: Mathematics" value={newSubject.name} onChange={e => setNewSubject({...newSubject, name: e.target.value})} /></div>
                <div className="input-group"><label className="input-label">Subject Code *</label><input className="input" placeholder="Ex: MATH" value={newSubject.code} onChange={e => setNewSubject({...newSubject, code: e.target.value.toUpperCase()})} /></div>
                <div className="input-group"><label className="input-label">Assign to Class *</label>
                  <select className="select" value={newSubject.classId} onChange={e => setNewSubject({...newSubject, classId: e.target.value})}>
                    <option value="">Select Class...</option>
                    {classes.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
              </div>
              <div className="grid grid-3 gap-4 mb-4">
                <div className="input-group"><label className="input-label">Type</label>
                  <select className="select" value={newSubject.type} onChange={e => setNewSubject({...newSubject, type: e.target.value})}>
                    <option value="THEORY">Theory</option><option value="PRACTICAL">Practical</option><option value="ELECTIVE">Elective</option>
                  </select>
                </div>
                <div className="input-group"><label className="input-label">HOD / Lead Teacher</label>
                  <select className="select" value={newSubject.hodStaffId} onChange={e => setNewSubject({...newSubject, hodStaffId: e.target.value})}>
                    <option value="">None (Assign Later)</option>
                    {teachers.filter(t => t.designation === 'Teacher').map(t => <option key={t.id} value={t.id}>{t.firstName} {t.lastName} — {t.department}</option>)}
                  </select>
                </div>
              </div>
              <div className="flex justify-end gap-3 pt-4 border-t">
                <button className="btn btn-secondary" onClick={() => setShowAddSubject(false)}>Cancel</button>
                <button className="btn btn-primary" onClick={addSubject}><span className="icon icon-sm">save</span>Create Subject</button>
              </div>
            </div>
          </div>
        )}

        {/* ── ADD EXAM MODAL ── */}
        {showAddExam && (
          <div className="card mb-6 animate-fadeIn" style={{ border: '2px solid var(--primary)' }}>
            <div className="card-body">
              <h3 className="mb-4 flex items-center gap-2 pb-4 border-b"><span className="icon text-primary">quiz</span> Create New Examination</h3>
              <div className="grid grid-3 gap-4 mb-4">
                <div className="input-group"><label className="input-label">Exam Name *</label><input className="input" placeholder="Ex: Mid Term 2026" value={newExam.name} onChange={e => setNewExam({...newExam, name: e.target.value})} /></div>
                <div className="input-group"><label className="input-label">Exam Type</label>
                  <select className="select" value={newExam.examType} onChange={e => setNewExam({...newExam, examType: e.target.value, name: e.target.value === newExam.examType ? newExam.name : e.target.value })}>
                    {EXAM_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
                <div></div>
              </div>
              <div className="grid grid-3 gap-4 mb-6">
                <div className="input-group"><label className="input-label">Start Date *</label><input type="date" className="input" value={newExam.startDate} onChange={e => setNewExam({...newExam, startDate: e.target.value})} /></div>
                <div className="input-group"><label className="input-label">End Date *</label><input type="date" className="input" value={newExam.endDate} onChange={e => setNewExam({...newExam, endDate: e.target.value})} /></div>
                <div></div>
              </div>

              {/* Exam Subjects — Class-Based Picker */}
              <div style={{ padding: '20px 24px', background: '#F0F9FF', borderRadius: 12, border: '1px solid #BAE6FD', marginBottom: 24 }}>
                <h4 className="text-sm font-bold uppercase tracking-wide m-0 mb-4" style={{ color: '#0369A1' }}>Exam Subjects Schedule</h4>

                {/* Step 1: Defaults */}
                <div style={{ padding: '12px 16px', background: '#fff', borderRadius: 8, border: '1px solid #E0F2FE', marginBottom: 16 }}>
                  <div className="text-xs font-bold text-gray uppercase mb-2">Default Settings (applied to newly added subjects)</div>
                  <div className="flex gap-3 items-end flex-wrap">
                    <div className="input-group" style={{flex:1, minWidth:90}}><label className="input-label">Start Time</label><input type="time" className="input" defaultValue="09:00" id="exam-default-start" /></div>
                    <div className="input-group" style={{flex:1, minWidth:90}}><label className="input-label">End Time</label><input type="time" className="input" defaultValue="12:00" id="exam-default-end" /></div>
                    <div className="input-group" style={{flex:1, minWidth:80}}><label className="input-label">Max Marks</label><input type="number" className="input" defaultValue="100" id="exam-default-max" /></div>
                    <div className="input-group" style={{flex:1, minWidth:80}}><label className="input-label">Pass Marks</label><input type="number" className="input" defaultValue="33" id="exam-default-pass" /></div>
                  </div>
                </div>

                {/* Step 2: Class-grouped checkboxes */}
                <div className="text-xs font-bold text-gray uppercase mb-2">Select Subjects by Class</div>
                <div style={{ maxHeight: 260, overflowY: 'auto', border: '1px solid #E0F2FE', borderRadius: 8, background: '#fff', marginBottom: 16 }}>
                  {classes.length === 0 && <div className="text-center text-sm text-gray p-4">No classes available. Please create classes first.</div>}
                  {classes.map(cls => {
                    const clsSubjects = cls.subjects || [];
                    if (clsSubjects.length === 0) return null;
                    const selectedIds = newExam.examSubjects.map((es: any) => es.subjectId);
                    const allSelected = clsSubjects.every((s: any) => selectedIds.includes(s.id));
                    const someSelected = clsSubjects.some((s: any) => selectedIds.includes(s.id));

                    const toggleAll = () => {
                      const defStart = (document.getElementById('exam-default-start') as HTMLInputElement)?.value || '09:00';
                      const defEnd = (document.getElementById('exam-default-end') as HTMLInputElement)?.value || '12:00';
                      const defMax = parseInt((document.getElementById('exam-default-max') as HTMLInputElement)?.value) || 100;
                      const defPass = parseInt((document.getElementById('exam-default-pass') as HTMLInputElement)?.value) || 33;

                      if (allSelected) {
                        setNewExam(prev => ({ ...prev, examSubjects: prev.examSubjects.filter(es => !clsSubjects.some((s: any) => s.id === es.subjectId)) }));
                      } else {
                        const toAdd = clsSubjects.filter((s: any) => !selectedIds.includes(s.id)).map((s: any) => ({
                          subjectId: s.id, examDate: newExam.startDate, startTime: defStart, endTime: defEnd, maxMarks: defMax, passingMarks: defPass,
                        }));
                        setNewExam(prev => ({ ...prev, examSubjects: [...prev.examSubjects, ...toAdd] }));
                      }
                    };

                    const toggleOne = (subId: string) => {
                      const defStart = (document.getElementById('exam-default-start') as HTMLInputElement)?.value || '09:00';
                      const defEnd = (document.getElementById('exam-default-end') as HTMLInputElement)?.value || '12:00';
                      const defMax = parseInt((document.getElementById('exam-default-max') as HTMLInputElement)?.value) || 100;
                      const defPass = parseInt((document.getElementById('exam-default-pass') as HTMLInputElement)?.value) || 33;

                      if (selectedIds.includes(subId)) {
                        setNewExam(prev => ({ ...prev, examSubjects: prev.examSubjects.filter(es => es.subjectId !== subId) }));
                      } else {
                        setNewExam(prev => ({ ...prev, examSubjects: [...prev.examSubjects, { subjectId: subId, examDate: newExam.startDate, startTime: defStart, endTime: defEnd, maxMarks: defMax, passingMarks: defPass }] }));
                      }
                    };

                    return (
                      <div key={cls.id} style={{ borderBottom: '1px solid #F3F4F6' }}>
                        <div style={{ padding: '10px 16px', background: '#F8FAFC', display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }} onClick={toggleAll}>
                          <input type="checkbox" checked={allSelected} style={{ accentColor: '#5048E5' }} readOnly ref={el => { if (el) el.indeterminate = someSelected && !allSelected; }} />
                          <span className="icon icon-sm" style={{ color: '#5048E5' }}>school</span>
                          <span className="font-semibold text-sm">{cls.name}</span>
                          <span className="text-xs text-gray">({clsSubjects.length} subjects)</span>
                        </div>
                        <div style={{ padding: '4px 16px 8px 40px', display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                          {clsSubjects.map((sub: any) => {
                            const checked = selectedIds.includes(sub.id);
                            return (
                              <label key={sub.id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 6, background: checked ? '#EFF6FF' : '#F9FAFB', border: `1px solid ${checked ? '#93C5FD' : '#E5E7EB'}`, cursor: 'pointer', fontSize: 13, fontWeight: checked ? 600 : 400, transition: 'all 0.15s' }}>
                                <input type="checkbox" checked={checked} onChange={() => toggleOne(sub.id)} style={{ accentColor: '#5048E5' }} />
                                {sub.name} <span style={{ color: '#9CA3AF', fontWeight: 400 }}>({sub.code})</span>
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Step 3: Schedule table for selected subjects */}
                {newExam.examSubjects.length > 0 && (
                  <>
                    <div className="text-xs font-bold text-gray uppercase mb-2">Schedule Details — {newExam.examSubjects.length} subjects selected</div>
                    <div style={{ border: '1px solid #E0F2FE', borderRadius: 8, overflow: 'hidden', background: '#fff' }}>
                      <table className="table" style={{ margin: 0, fontSize: 13 }}>
                        <thead><tr style={{ background: '#F8FAFC' }}>
                          <th style={{ paddingLeft: 16, width: 40 }}>#</th>
                          <th>Subject</th>
                          <th style={{ width: 130 }}>Exam Date</th>
                          <th style={{ width: 100 }}>Start</th>
                          <th style={{ width: 100 }}>End</th>
                          <th style={{ width: 80 }}>Max</th>
                          <th style={{ width: 80 }}>Pass</th>
                          <th style={{ width: 50 }}></th>
                        </tr></thead>
                        <tbody>
                          {newExam.examSubjects.map((es, i) => {
                            const subInfo = allSubjects.find((s: any) => s.id === es.subjectId);
                            return (
                              <tr key={i}>
                                <td style={{ paddingLeft: 16 }}>{i + 1}</td>
                                <td className="font-semibold">{subInfo?.name || '?'} <span className="text-xs text-gray">({subInfo?.className})</span></td>
                                <td><input type="date" className="input" style={{ fontSize: 12, padding: '4px 6px' }} value={es.examDate} onChange={e => updateExamSubject(i, 'examDate', e.target.value)} /></td>
                                <td><input type="time" className="input" style={{ fontSize: 12, padding: '4px 6px' }} value={es.startTime} onChange={e => updateExamSubject(i, 'startTime', e.target.value)} /></td>
                                <td><input type="time" className="input" style={{ fontSize: 12, padding: '4px 6px' }} value={es.endTime} onChange={e => updateExamSubject(i, 'endTime', e.target.value)} /></td>
                                <td><input type="number" className="input" style={{ fontSize: 12, padding: '4px 6px', width: 60 }} value={es.maxMarks} onChange={e => updateExamSubject(i, 'maxMarks', parseInt(e.target.value) || 100)} /></td>
                                <td><input type="number" className="input" style={{ fontSize: 12, padding: '4px 6px', width: 60 }} value={es.passingMarks} onChange={e => updateExamSubject(i, 'passingMarks', parseInt(e.target.value) || 33)} /></td>
                                <td><button className="btn btn-sm btn-ghost" onClick={() => removeExamSubject(i)}><span className="icon icon-sm text-danger">close</span></button></td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
                {newExam.examSubjects.length === 0 && <div className="text-center text-sm text-gray py-2">Select subjects from the classes above to build the exam schedule.</div>}
              </div>
              <div className="flex justify-end gap-3 pt-4 border-t">
                <button className="btn btn-secondary" onClick={() => setShowAddExam(false)}>Cancel</button>
                <button className="btn btn-primary" onClick={addExam}><span className="icon icon-sm">save</span>Create Examination</button>
              </div>
            </div>
          </div>
        )}

        {loading ? (
          <div className="card" style={{ padding: 48, textAlign: 'center' }}><span className="icon" style={{ fontSize: 32, color: '#5048E5', animation: 'spin 1s linear infinite' }}>progress_activity</span><p style={{ marginTop: 12, color: '#6B7280' }}>Loading {activeTab.toLowerCase()}...</p></div>
        ) : !error && (
          <>
            {/* ── CLASSES TAB ── */}
            {activeTab === 'Classes' && (
              <div className="grid grid-3 gap-4 mb-6">
                {classes.map(c => (
                  <div key={c.id} className="card">
                    <div className="card-body">
                      <div className="flex items-center justify-between">
                        <h3>{c.name}</h3>
                        <div className="flex items-center gap-2">
                          <span className="badge badge-primary">{c._count?.students || 0} students</span>
                          <button className="btn btn-sm btn-ghost" title="Delete" onClick={() => deleteClass(c.id)}><span className="icon icon-sm text-danger">delete</span></button>
                        </div>
                      </div>
                      <div className="flex gap-2 mt-2">{c.sections?.map((s: any) => <span key={s.id} className="badge badge-gray">Sec {s.name}</span>)}</div>
                      <div className="mt-4" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                        {c.subjects?.map((sub: any) => <span key={sub.id} style={{ fontSize: '0.75rem', padding: '2px 8px', background: 'var(--gray-50)', borderRadius: 4, color: 'var(--gray-600)' }}>{sub.name}</span>)}
                        {(!c.subjects || c.subjects.length === 0) && <span className="text-xs text-gray">No subjects assigned yet</span>}
                      </div>
                    </div>
                  </div>
                ))}
                {classes.length === 0 && <div className="card" style={{ gridColumn: 'span 3', padding: 24, textAlign: 'center', color: '#9CA3AF' }}>No classes found. Click "Add Class" to create one.</div>}
              </div>
            )}

            {/* ── SUBJECTS TAB ── */}
            {activeTab === 'Subjects' && (() => {
              const filterClassId = filterClassSubject;
              // Group subjects by class
              const grouped: Record<string, { className: string; classId: string; subjects: any[] }> = {};
              subjects.forEach((s: any) => {
                const cId = s.classId || 'unassigned';
                const cName = s.class?.name || 'Unassigned';
                if (!grouped[cId]) grouped[cId] = { className: cName, classId: cId, subjects: [] };
                grouped[cId].subjects.push(s);
              });
              const groups = Object.values(grouped).filter(g => filterClassId === 'All' || g.classId === filterClassId);
              const typeColors: Record<string, string> = { THEORY: '#3B82F6', PRACTICAL: '#10B981', ELECTIVE: '#F59E0B' };

              return (
                <div className="animate-fadeIn">
                  {/* Filter Bar */}
                  <div className="flex items-center justify-between mb-4" style={{ gap: 12, flexWrap: 'wrap' }}>
                    <div className="flex items-center gap-3">
                      <select className="select" style={{ width: 180 }} value={filterClassSubject} onChange={e => setFilterClassSubject(e.target.value)}>
                        <option value="All">All Classes</option>
                        {classes.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                      <span className="text-sm text-gray">{subjects.length} subjects across {Object.keys(grouped).length} classes</span>
                    </div>
                  </div>

                  {groups.length === 0 && (
                    <div className="card" style={{ padding: 32, textAlign: 'center', color: '#9CA3AF' }}>
                      {subjects.length === 0 ? 'No subjects found. Click "Add Subject" to create one.' : 'No subjects match the selected class filter.'}
                    </div>
                  )}

                  {groups.map(group => (
                    <div key={group.classId} className="card mb-4">
                      <div style={{ padding: '16px 24px', borderBottom: '1px solid #F3F4F6', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <div className="flex items-center gap-3">
                          <span className="icon" style={{ color: '#5048E5' }}>school</span>
                          <h3 className="font-bold m-0">{group.className}</h3>
                          <span className="badge badge-primary">{group.subjects.length} subjects</span>
                        </div>
                      </div>
                      <div className="table-wrapper">
                        <table className="table" style={{ margin: 0 }}>
                          <thead>
                            <tr>
                              <th style={{ paddingLeft: 24, width: 60 }}>#</th>
                              <th style={{ width: 100 }}>Code</th>
                              <th>Subject Name</th>
                              <th style={{ width: 100 }}>Type</th>
                              <th>HOD / Teacher</th>
                              <th style={{ width: 80, textAlign: 'center' }}>Actions</th>
                            </tr>
                          </thead>
                          <tbody>
                            {group.subjects.map((sub: any, idx: number) => (
                              <tr key={sub.id}>
                                <td style={{ paddingLeft: 24 }}>{idx + 1}</td>
                                <td><span className="font-semibold text-primary">{sub.code}</span></td>
                                <td className="font-semibold">{sub.name}</td>
                                <td>
                                  <span style={{ fontSize: '0.7rem', padding: '2px 10px', borderRadius: 12, fontWeight: 600, color: '#fff', background: typeColors[sub.type] || '#6B7280' }}>
                                    {sub.type}
                                  </span>
                                </td>
                                <td>
                                  {sub.teachers?.length > 0 ? (
                                    <div className="flex items-center gap-2 flex-wrap">
                                      {sub.teachers.map((t: any) => (
                                        <span key={t.id} className="flex items-center gap-1" style={{ fontSize: 13 }}>
                                          <span className="avatar" style={{ width: 22, height: 22, fontSize: 10 }}>{t.staff?.firstName?.[0]}{t.staff?.lastName?.[0]}</span>
                                          {t.staff?.firstName} {t.staff?.lastName}
                                        </span>
                                      ))}
                                    </div>
                                  ) : (
                                    <span className="text-xs text-gray" style={{ fontStyle: 'italic' }}>Not assigned</span>
                                  )}
                                </td>
                                <td style={{ textAlign: 'center' }}>
                                  <button className="btn btn-sm btn-ghost" title="Delete Subject" onClick={() => deleteSubject(sub.id)}>
                                    <span className="icon icon-sm text-danger">delete</span>
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ))}
                </div>
              );
            })()}

            {/* ── EXAMINATIONS TAB ── */}
            {activeTab === 'Examinations' && (
              <div className="grid grid-3 gap-4 mb-6 animate-fadeIn">
                {examinations.map(exam => {
                  const isActive = new Date(exam.endDate) > new Date();
                  return (
                    <div key={exam.id} className="card">
                      <div className="card-body">
                        <div className="flex items-center justify-between mb-3">
                          <h3 className="font-bold">{exam.name}</h3>
                          <div className="flex items-center gap-2">
                            <span className={`badge ${!isActive ? 'badge-gray' : 'badge-primary'}`}>{!isActive ? 'Completed' : 'Upcoming'}</span>
                            <button className="btn btn-sm btn-ghost" onClick={() => deleteExam(exam.id)}><span className="icon icon-sm text-danger">delete</span></button>
                          </div>
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }} className="text-sm">
                          <div className="flex items-center gap-2 text-gray"><span className="icon icon-sm">calendar_today</span>{new Date(exam.startDate).toLocaleDateString('en-IN')} — {new Date(exam.endDate).toLocaleDateString('en-IN')}</div>
                          <div className="flex items-center gap-2 text-gray"><span className="icon icon-sm">subject</span>{exam.subjects?.length || 0} Subjects</div>
                        </div>
                        {exam.subjects?.length > 0 && (
                          <div className="mt-3 pt-3 border-t" style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                            {exam.subjects.map((es: any) => (
                              <span key={es.id} style={{ fontSize: '0.7rem', padding: '2px 8px', background: '#EFF6FF', borderRadius: 4, color: '#1D4ED8' }}>{es.subject?.name}</span>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
                {examinations.length === 0 && <div className="card" style={{ gridColumn: 'span 3', padding: 24, textAlign: 'center', color: '#9CA3AF' }}>No examinations found. Click "Create Exam" to schedule one.</div>}
              </div>
            )}

            {/* ── RESULTS TAB ── */}
            {activeTab === 'Results' && (
              <div className="card mb-6 animate-fadeIn">
                <div className="card-body p-0" style={{ padding: 0 }}>
                  <div className="table-wrapper"><table className="table" style={{ margin: 0 }}><thead><tr>
                    <th style={{ paddingLeft: 24 }}>Student Name</th><th>Admission No</th><th>Subject</th><th>Marks / Grade</th>
                  </tr></thead><tbody>
                    {results.map(result => (
                      <tr key={result.id}>
                        <td className="font-semibold" style={{ paddingLeft: 24 }}>{result.student?.firstName} {result.student?.lastName}</td>
                        <td>{result.student?.admissionNo}</td>
                        <td>{result.examSubject?.subject?.name}</td>
                        <td><span className="badge badge-primary">{String(result.marksObtained)} {result.grade && `(${result.grade})`}</span></td>
                      </tr>
                    ))}
                    {results.length === 0 && <tr><td colSpan={4} style={{ textAlign: 'center', padding: 24, color: '#9CA3AF' }}>No results found</td></tr>}
                  </tbody></table></div>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
