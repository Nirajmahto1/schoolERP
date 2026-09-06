'use client';
import Topbar from '@/components/Topbar';
import { useState, useEffect, useCallback } from 'react';
import { academicApi } from '@/lib/api';

export default function ExamsPage() {
  const [activeTab, setActiveTab] = useState('Examinations');

  const [examinations, setExaminations] = useState<any[]>([]);
  const [results, setResults] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchExamsData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (activeTab === 'Examinations') {
        const res = await academicApi.getExaminations();
        setExaminations(res.data);
      } else if (activeTab === 'Results' || activeTab === 'Report Cards') {
        const examsRes = await academicApi.getExaminations();
        if (examsRes.data.length > 0) {
          const latestExamId = examsRes.data[0].id;
          const res = await academicApi.getResults(latestExamId);
          setResults(res.data);
        } else {
          setResults([]);
        }
      }
    } catch (err: any) {
      setError(err?.detail || err?.message || 'Failed to load examination data.');
    } finally {
      setLoading(false);
    }
  }, [activeTab]);

  useEffect(() => {
    fetchExamsData();
  }, [fetchExamsData]);

  return (
    <>
      <Topbar title="Exams & Results" subtitle="Examination management and result analysis" />
      <div style={{ padding: '24px 32px' }}>
        <div className="flex items-center justify-between mb-4" style={{ flexWrap: 'wrap', gap: 12 }}>
          <div className="tabs">
            {['Examinations', 'Results', 'Report Cards'].map(tab => (
              <button 
                key={tab} 
                className={`tab ${activeTab === tab ? 'active' : ''}`}
                onClick={() => setActiveTab(tab)}
              >
                {tab}
              </button>
            ))}
          </div>
          <div className="flex gap-3">
            {activeTab === 'Examinations' && <button className="btn btn-primary"><span className="icon icon-sm">add</span>Create Exam</button>}
            {activeTab === 'Results' && <button className="btn btn-primary"><span className="icon icon-sm">download</span>Export Results</button>}
            {activeTab === 'Report Cards' && <button className="btn btn-primary"><span className="icon icon-sm">auto_awesome</span>Generate All PDF</button>}
          </div>
        </div>

        {error && (
          <div className="card mb-4" style={{ padding: 24, background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 12 }}>
            <div className="flex items-center gap-3">
              <span className="icon" style={{ color: '#EF4444' }}>error</span>
              <div><div style={{ fontWeight: 600, color: '#991B1B' }}>Connection Error</div><div style={{ fontSize: 14, color: '#B91C1C' }}>{error}</div></div>
              <button className="btn btn-sm btn-secondary" style={{ marginLeft: 'auto' }} onClick={fetchExamsData}><span className="icon icon-sm">refresh</span>Retry</button>
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
                  const isActive = new Date(e.endDate) > new Date();
                  return (
                  <div key={e.id} className="card">
                    <div className="card-body">
                      <div className="flex items-center justify-between"><h3>{e.name}</h3><span className={`badge ${!isActive ? 'badge-gray' : 'badge-warning'}`}>{isActive ? 'Upcoming' : 'Completed'}</span></div>
                      <div className="flex flex-col gap-2 mt-4">
                        <span className="text-sm text-gray"><span className="icon icon-sm">calendar_today</span> {new Date(e.startDate).toLocaleDateString()} — {new Date(e.endDate).toLocaleDateString()}</span>
                        <span className="text-sm text-gray"><span className="icon icon-sm">subject</span> {e.subjects?.length || 0} Subjects</span>
                      </div>
                      <div className="flex gap-2 mt-4"><button className="btn btn-sm btn-secondary">View Schedule</button><button className="btn btn-sm btn-primary">Enter Marks</button></div>
                    </div>
                  </div>
                )})}
                {examinations.length === 0 && <div className="card" style={{ gridColumn: 'span 3', padding: 24, textAlign: 'center', color: '#9CA3AF' }}>No examinations found</div>}
              </div>
            )}

            {activeTab === 'Results' && (
              <div className="card animate-fadeIn mb-6">
                <div className="card-body p-0" style={{ padding: 0 }}>
                  <div className="flex items-center justify-between p-4 border-b" style={{ borderBottom: '1px solid var(--gray-100)' }}>
                    <h3 className="m-0 text-lg font-bold">Recent Results — {examinations[0]?.name || 'Latest Exam'}</h3>
                  </div>
                  <div className="table-wrapper">
                    <table className="table" style={{ margin: 0 }}>
                      <thead>
                        <tr>
                          <th style={{ paddingLeft: '24px' }}>Rank / ID</th>
                          <th>Student Name</th>
                          <th>Admission No</th>
                          <th>Subject</th>
                          <th>Marks / Grade</th>
                        </tr>
                      </thead>
                      <tbody>
                        {results.map((r, i) => (
                          <tr key={r.id}>
                            <td style={{ paddingLeft: '24px' }}><span className="badge badge-primary" style={{ minWidth: 28, justifyContent: 'center' }}>#{i+1}</span></td>
                            <td>
                              <div className="flex items-center gap-2">
                                <div className="avatar avatar-sm">{r.student?.firstName?.[0]}{r.student?.lastName?.[0]}</div>
                                <span className="font-semibold">{r.student?.firstName} {r.student?.lastName}</span>
                              </div>
                            </td>
                            <td>{r.student?.admissionNo}</td>
                            <td>{r.examSubject?.subject?.name}</td>
                            <td><span className="font-semibold">{String(r.marksObtained)}</span> {r.grade && <span className="badge badge-success" style={{ marginLeft: 8 }}>{r.grade}</span>}</td>
                          </tr>
                        ))}
                        {results.length === 0 && <tr><td colSpan={5} style={{ textAlign: 'center', padding: 24, color: '#9CA3AF' }}>No results available</td></tr>}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'Report Cards' && (
              <div className="card animate-fadeIn mb-6">
                <div className="card-body p-0" style={{ padding: 0 }}>
                  <div className="flex items-center justify-between p-4 border-b" style={{ borderBottom: '1px solid var(--gray-100)' }}>
                    <h3 className="m-0 text-lg font-bold">Report Cards — {examinations[0]?.name || 'Latest Exam'}</h3>
                  </div>
                  <div className="table-wrapper">
                    <table className="table" style={{ margin: 0 }}>
                      <thead>
                        <tr>
                          <th style={{ paddingLeft: '24px' }}>Student</th>
                          <th>Status</th>
                          <th>Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {results.map(r => (
                          <tr key={`rc-${r.id}`}>
                            <td className="font-semibold" style={{ paddingLeft: '24px' }}>{r.student?.firstName} {r.student?.lastName}</td>
                            <td><span className="badge badge-success">Generated</span></td>
                            <td>
                              <button className="btn btn-sm btn-ghost"><span className="icon text-primary icon-sm">download</span> PDF</button>
                            </td>
                          </tr>
                        ))}
                        {results.length === 0 && <tr><td colSpan={3} style={{ textAlign: 'center', padding: 24, color: '#9CA3AF' }}>No data to generate report cards</td></tr>}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
