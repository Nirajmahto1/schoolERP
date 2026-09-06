import Topbar from '@/components/Topbar';

export default function ChildAttendancePage() {
  const days = Array.from({ length: 28 }, (_, i) => ({ day: i + 1, status: i === 5 || i === 12 ? 'absent' : i === 20 ? 'late' : i === 6 || i === 13 || i === 20 || i === 27 ? 'holiday' : 'present' }));
  return (
    <>
      <Topbar title="Child's Attendance" subtitle="Aarav Singh — Class 10-A" />
      <div style={{ padding: '24px 32px' }}>
        <div className="grid grid-4 gap-4 mb-6">
          {[{l:'Present Days',v:'22',c:'#10B981'},{l:'Absent Days',v:'2',c:'#EF4444'},{l:'Late',v:'1',c:'#F59E0B'},{l:'Attendance %',v:'94%',c:'#5048E5'}].map(s=>(
            <div key={s.l} className="stat-card" style={{borderLeftColor:s.c}}><div className="stat-icon" style={{background:s.c+'15',color:s.c}}><span className="icon">event_available</span></div><div><div className="stat-value">{s.v}</div><div className="stat-label">{s.l}</div></div></div>
          ))}
        </div>
        <div className="card"><div className="card-body">
          <h3 className="mb-4">March 2026 Attendance</h3>
          <div style={{display:'grid',gridTemplateColumns:'repeat(7,1fr)',gap:6,maxWidth:400}}>
            {['S','M','T','W','T','F','S'].map(d=><div key={d} style={{textAlign:'center',fontSize:'0.75rem',fontWeight:700,color:'var(--gray-400)',padding:4}}>{d}</div>)}
            {days.map(d=>(<div key={d.day} style={{width:'100%',aspectRatio:'1',borderRadius:8,display:'flex',alignItems:'center',justifyContent:'center',fontSize:'0.8125rem',fontWeight:600,
              background:d.status==='present'?'#D1FAE5':d.status==='absent'?'#FEE2E2':d.status==='late'?'#FEF3C7':'#F1F5F9',color:d.status==='present'?'#065F46':d.status==='absent'?'#991B1B':d.status==='late'?'#92400E':'#94A3B8'}}>{d.day}</div>))}
          </div>
          <div className="flex gap-4 mt-4">{[{l:'Present',c:'#D1FAE5'},{l:'Absent',c:'#FEE2E2'},{l:'Late',c:'#FEF3C7'},{l:'Holiday',c:'#F1F5F9'}].map(x=>(<div key={x.l} className="flex items-center gap-2"><div style={{width:12,height:12,borderRadius:3,background:x.c}}></div><span className="text-xs text-gray">{x.l}</span></div>))}</div>
        </div></div>
      </div>
    </>
  );
}
