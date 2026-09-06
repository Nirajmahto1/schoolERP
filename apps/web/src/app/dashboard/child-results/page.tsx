import Topbar from '@/components/Topbar';

export default function ChildResultsPage() {
  return (
    <>
      <Topbar title="Child's Results" subtitle="Aarav Singh — Class 10-A" />
      <div style={{ padding: '24px 32px' }}>
        <div className="card"><div className="card-body"><h3 className="mb-4">First Term Exam 2025</h3>
          <div className="table-wrapper"><table className="table"><thead><tr><th>Subject</th><th>Teacher</th><th>Marks</th><th>Max</th><th>%</th><th>Grade</th></tr></thead><tbody>
            {[{s:'Mathematics',t:'Priya Sharma',m:92,max:100},{s:'Science',t:'Rajesh Kumar',m:88,max:100},{s:'English',t:'Anita Verma',m:85,max:100},{s:'Hindi',t:'Suresh Patel',m:78,max:100},{s:'Social Science',t:'Meena Gupta',m:90,max:100}].map((r,i)=>{
              const p=Math.round(r.m/r.max*100); const g=p>=90?'A+':p>=80?'A':p>=70?'B+':'B';
              return <tr key={i}><td className="font-semibold">{r.s}</td><td className="text-sm text-gray">{r.t}</td><td className="font-bold">{r.m}</td><td>{r.max}</td><td>{p}%</td><td><span className={`badge ${p>=80?'badge-success':'badge-info'}`}>{g}</span></td></tr>;
            })}
          </tbody></table></div>
          <div className="flex justify-between items-center mt-4 p-4" style={{background:'var(--gray-50)',borderRadius:8}}>
            <span className="font-bold">Total: 433/500 (86.6%)</span><span className="badge badge-success" style={{fontSize:'0.875rem',padding:'6px 14px'}}>Rank #3 / 32</span>
          </div>
        </div></div>
      </div>
    </>
  );
}
