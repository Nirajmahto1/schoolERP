'use client';
import Topbar from '@/components/Topbar';
import { useState, useEffect } from 'react';
import { studentApi } from '@/lib/api';

export default function MyResultsPage() {
  const [loading, setLoading] = useState(true);
  const [resultsData, setResultsData] = useState<any[]>([]);

  useEffect(() => {
    const fetchResults = async () => {
      try {
        const data = await studentApi.getMyResults();
        setResultsData(data);
      } catch (err) {
        console.error('Failed to load results', err);
      } finally {
        setLoading(false);
      }
    };
    fetchResults();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center p-12">
        <span className="icon animate-spin text-4xl text-primary">sync</span>
      </div>
    );
  }

  return (
    <>
      <Topbar title="My Results" subtitle="View your examination results and report cards" />
      <div style={{ padding: '24px 32px' }}>
        <div className="flex items-center justify-between mb-6">
          <div className="tabs"><button className="tab active">All Results</button><button className="tab">Report Card</button></div>
          <select className="select" style={{ width: 200 }}><option>Academic Year 2025-2026</option><option>Academic Year 2024-2025</option></select>
        </div>

        {resultsData.length === 0 ? (
          <div className="card text-center p-12 text-gray">
            <span className="icon text-6xl mb-4" style={{ opacity: 0.2 }}>workspace_premium</span>
            <h3>No Exam Results</h3>
            <p>Your examination records have not been published yet.</p>
          </div>
        ) : (
          resultsData.map((exam, ei) => {
            const total = exam.subjects.reduce((a: number, b: any) => a + b.m, 0);
            const maxTotal = exam.subjects.reduce((a: number, b: any) => a + b.max, 0);
            const pct = maxTotal > 0 ? Math.round((total / maxTotal) * 100) : 0;
            return (
              <div key={ei} className="card mb-6">
                <div className="card-body">
                  <div className="flex items-center justify-between mb-4">
                    <div><h3>{exam.exam}</h3><p className="text-sm text-gray">{exam.date}</p></div>
                    <div className="flex items-center gap-4">
                      <div style={{ textAlign: 'right' }}><div className="stat-value" style={{ fontSize: '1.25rem' }}>{total}/{maxTotal}</div><div className="text-sm text-gray">{pct}%</div></div>
                      <span className={`badge ${pct >= 85 ? 'badge-success' : pct >= 70 ? 'badge-info' : pct >= 40 ? 'badge-warning' : 'badge-danger'}`} style={{ fontSize: '0.875rem', padding: '6px 14px' }}>
                        {pct >= 85 ? 'Excellent' : pct >= 70 ? 'Good' : pct >= 40 ? 'Average' : 'Fail'}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="table-wrapper">
                  <table className="table">
                    <thead><tr><th>Subject</th><th>Marks Obtained</th><th>Max Marks</th><th>%</th><th>Grade</th><th>Result</th></tr></thead>
                    <tbody>
                      {exam.subjects.map((s: any, i: number) => {
                        const sp = s.max > 0 ? Math.round((s.m / s.max) * 100) : 0;
                        const grade = sp >= 90 ? 'A+' : sp >= 80 ? 'A' : sp >= 70 ? 'B+' : sp >= 60 ? 'B' : sp >= 40 ? 'C' : 'F';
                        return (
                          <tr key={i}>
                            <td className="font-semibold">{s.s}</td>
                            <td className="font-bold">{s.m}</td><td>{s.max}</td>
                            <td>{sp}%</td>
                            <td><span className={`badge ${sp >= 80 ? 'badge-success' : sp >= 60 ? 'badge-info' : sp >= 40 ? 'badge-warning' : 'badge-danger'}`}>{grade}</span></td>
                            <td><span className={`badge ${sp >= 40 ? 'badge-success' : 'badge-danger'}`}>{sp >= 40 ? 'Pass' : 'Fail'}</span></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })
        )}
      </div>
    </>
  );
}
