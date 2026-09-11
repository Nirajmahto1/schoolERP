'use client';
import Topbar from '@/components/Topbar';
import { useState, useEffect, useCallback } from 'react';
import { examApi, studentApi, academicApi } from '@/lib/api';

export default function ExamsPage() {
  const [activeTab, setActiveTab] = useState('Examinations');

  const [examinations, setExaminations] = useState<any[]>([]);
  const [selectedExamId, setSelectedExamId] = useState('');
  const [reportCards, setReportCards] = useState<any[]>([]);
  const [resultsLoading, setResultsLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchExams = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await examApi.list();
      setExaminations(res.data);
    } catch (err: any) {
      setError(err?.detail || err?.message || 'Failed to load examination data.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchExams(); }, [fetchExams]);

  // Results / Report Cards read per-student report cards — only available
  // once the exam is PUBLISHED (the service 404s anything less, deliberately).
  const loadResults = useCallback(async (examId: string) => {
    if (!examId) { setReportCards([]); return; }
    setResultsLoading(true);
    try {
      const studentsRes = await studentApi.list({ limit: 20 });
      const cards = await Promise.all(
        (studentsRes.data || []).map(async (s: any) => {
          try {
            const rc = await examApi.getReportCard(examId, s.id);
            return rc.data;
          } catch {
            return null; // not published / student has no result
          }
        }),
      );
      setReportCards(cards.filter(Boolean));
    } catch {
      setReportCards([]);
    }
    setResultsLoading(false);
  }, []);

  useEffect(() => {
    if (activeTab === 'Results' || activeTab === 'Report Cards') {
      loadResults(selectedExamId || examinations[0]?.id || '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, selectedExamId, loadResults]);

  const selectedExam = examinations.find(e => e.id === (selectedExamId || examinations[0]?.id));

  const advance = async (exam: any) => {
    const next = exam.status === 'ENTRY' ? 'SUBMITTED' : exam.status === 'SUBMITTED' ? 'VERIFIED' : 'PUBLISHED';
    if (!confirm(`Move "${exam.name}" from ${exam.status} to ${next}? Publishing makes marks parent-visible.`)) return;
    try {
      await examApi.setStatus(exam.id, next);
      await fetchExams();
    } catch (err: any) { alert(err.detail || 'Transition failed'); }
  };

  return (
    <>
      <Topbar title="Exams & Results" subtitle="Examination management and result analysis" />
      <div style={{ padding: '24px 32px' }}>
        <div className="flex items-center justify-between mb-4" style={{ flexWrap: 'wrap', gap: 12 }}>
          <div className="tabs">
            {['Examinations', 'Results', 'Report Cards'].map(tab => (
              <button key={tab} className={`tab ${activeTab === tab ? 'active' : ''}`} onClick={() => setActiveTab(tab)}>
                {tab}
              </button>
            ))}
          </div>
        </div>

        {error && (
          <div className="card mb-4" style={{ padding: 24, background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 12 }}>
            <div className="flex items-center gap-3">
              <span className="icon" style={{ color: '#EF4444' }}>error</span>
              <div><div style={{ fontWeight: 600, color: '#991B1B' }}>Connection Error</div><div style={{ fontSize: 14, color: '#B91C1C' }}>{error}</div></div>
              <button className="btn btn-sm btn-secondary" style={{ marginLeft: 'auto' }} onClick={fetchExams}><span className="icon icon-sm">refresh</span>Retry</button>
            </div>
          </div>
        )}

        {loading ? (
          <div className="card" style={{ padding: 48, textAlign: 'center' }}><span className="icon" style={{ fontSize: 32, color: '#5048E5', animation: 'spin 1s linear infinite' }}>progress_activity</span><p style={{ marginTop: 12, color: '#6B7280' }}>Loading data...</p></div>
        ) : !error && (
          <>
            {activeTab === 'Examinations' && (
              <div className="grid grid-3 gap-4 mb-6 animate-fadeIn">
                {examinations.map((e) => {
                  const statusBadge = e.status === 'PUBLISHED' ? 'badge-success' : e.status === 'VERIFIED' ? 'badge-primary' : e.status === 'SUBMITTED' ? 'badge-warning' : 'badge-gray';
                  const workflow = ['ENTRY', 'SUBMITTED', 'VERIFIED', 'PUBLISHED'];
                  const next = e.status === 'PUBLISHED' ? null : workflow[workflow.indexOf(e.status) + 1];
                  return (
                    <div key={e.id} className="card">
                      <div className="card-body">
                        <div className="flex items-center justify-between"><h3>{e.name}</h3><span className={`badge ${statusBadge}`}>{e.status}</span></div>
                        <div className="flex flex-col gap-2 mt-4">
                          <span className="text-sm text-gray"><span className="icon icon-sm">calendar_today</span> {new Date(e.startDate).toLocaleDateString()} — {new Date(e.endDate).toLocaleDateString()}</span>
                          <span className="text-sm text-gray"><span className="icon icon-sm">subject</span> {e.subjects?.length || 0} Subjects</span>
                        </div>
                        <div className="flex gap-2 mt-4">
                          <button className="btn btn-sm btn-secondary">View Schedule</button>
                          {next && <button className="btn btn-sm btn-primary" onClick={() => advance(e)}>Advance to {next}</button>}
                        </div>
                      </div>
                    </div>
                  );
                })}
                {examinations.length === 0 && <div className="card" style={{ gridColumn: 'span 3', padding: 24, textAlign: 'center', color: '#9CA3AF' }}>No examinations found</div>}
              </div>
            )}

            {(activeTab === 'Results' || activeTab === 'Report Cards') && (
              <div className="card animate-fadeIn mb-6">
                <div className="flex items-center justify-between p-4 border-b" style={{ borderBottom: '1px solid var(--gray-100)', flexWrap: 'wrap', gap: 12 }}>
                  <h3 className="m-0 text-lg font-bold">{activeTab === 'Results' ? 'Results — ' : 'Report Cards — '}{selectedExam?.name || 'Latest Exam'}</h3>
                  <select className="select" style={{ width: 240 }} value={selectedExamId || examinations[0]?.id || ''} onChange={e => setSelectedExamId(e.target.value)}>
                    {examinations.map(e => <option key={e.id} value={e.id}>{e.name} ({e.status})</option>)}
                  </select>
                </div>
                <div className="table-wrapper">
                  {resultsLoading ? (
                    <div style={{ padding: 32, textAlign: 'center', color: '#6B7280' }}><span className="icon" style={{ animation: 'spin 1s linear infinite' }}>progress_activity</span> Loading report cards...</div>
                  ) : (
                    <table className="table" style={{ margin: 0 }}>
                      <thead>
                        <tr>
                          <th style={{ paddingLeft: '24px' }}>Student</th>
                          <th>Admission No</th>
                          <th>Class</th>
                          <th>Subjects Passed</th>
                          <th>Total</th>
                          <th>Overall Grade</th>
                        </tr>
                      </thead>
                      <tbody>
                        {reportCards.map(rc => {
                          const passed = rc.subjects.filter((s: any) => !s.isAbsent && !s.isExempt && (s.percent ?? 0) >= (s.passing ?? 0)).length;
                          return (
                            <tr key={rc.student.id}>
                              <td style={{ paddingLeft: '24px' }}>
                                <div className="flex items-center gap-2">
                                  <div className="avatar avatar-sm">{rc.student.name.split(' ').map((n: string) => n[0]).join('').slice(0, 2)}</div>
                                  <span className="font-semibold">{rc.student.name}</span>
                                </div>
                              </td>
                              <td className="text-sm">{rc.student.admissionNo}</td>
                              <td className="text-sm">{rc.student.class}-{rc.student.section}</td>
                              <td className="text-sm">{passed}/{rc.subjects.length}</td>
                              <td className="font-semibold">{rc.total.marks}/{rc.total.maxMarks} <span className="text-gray text-sm">({rc.total.percent}%)</span></td>
                              <td><span className={`badge ${rc.total.grade?.startsWith('A') ? 'badge-success' : rc.total.grade?.startsWith('B') ? 'badge-info' : 'badge-warning'}`}>{rc.total.grade || '—'}</span></td>
                            </tr>
                          );
                        })}
                        {reportCards.length === 0 && (
                          <tr><td colSpan={6} style={{ textAlign: 'center', padding: 24, color: '#9CA3AF' }}>
                            {selectedExam && selectedExam.status !== 'PUBLISHED'
                              ? `Report cards are available only after publishing — "${selectedExam.name}" is ${selectedExam.status}.`
                              : 'No published results available'}
                          </td></tr>
                        )}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
