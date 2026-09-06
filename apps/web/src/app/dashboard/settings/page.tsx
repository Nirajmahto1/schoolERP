'use client';
import Topbar from '@/components/Topbar';
import { useState, useEffect } from 'react';
import { useAuth } from '@/context/AuthContext';
import { useRouter } from 'next/navigation';

export default function SettingsPage() {
  const { user } = useAuth();
  const router = useRouter();
  const [activeTab, setActiveTab] = useState('general');
  const [schoolName, setSchoolName] = useState('Delhi Public School — Demo Branch');
  const [email, setEmail] = useState('admin@dps-demo.edu.in');
  const [phone, setPhone] = useState('011-26853200');
  const [address, setAddress] = useState('Mathura Road, New Delhi, Delhi 110003');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (user && !['ADMIN', 'SUPER_ADMIN'].includes(user.role)) {
      router.push('/dashboard');
    }
  }, [user, router]);

  if (!user || !['ADMIN', 'SUPER_ADMIN'].includes(user.role)) return null;

  const save = () => { setSaved(true); setTimeout(() => setSaved(false), 2000); };

  return (
    <>
      <Topbar title="Settings" subtitle="School configuration & preferences" />
      <div style={{ padding: '24px 32px' }}>
        <div className="flex gap-6" style={{ flexWrap: 'wrap' }}>
          <div style={{ width: 220 }}>
            {[{ l: 'General', i: 'settings', k: 'general' }, { l: 'Academic Config', i: 'school', k: 'academic' }, { l: 'Fee Structure', i: 'payments', k: 'fees' }, { l: 'Notifications', i: 'notifications', k: 'notif' }, { l: 'Users & Roles', i: 'manage_accounts', k: 'users' }, { l: 'Backup & Export', i: 'cloud_download', k: 'backup' }].map(tab => (
              <button key={tab.k} onClick={() => setActiveTab(tab.k)} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderRadius: 8, border: 'none', background: activeTab === tab.k ? 'var(--primary-50)' : 'transparent', color: activeTab === tab.k ? 'var(--primary)' : 'var(--gray-500)', width: '100%', textAlign: 'left', cursor: 'pointer', fontWeight: activeTab === tab.k ? 600 : 400, fontSize: '0.875rem', marginBottom: 4, fontFamily: 'inherit' }}>
                <span className="icon icon-sm">{tab.i}</span>{tab.l}
              </button>
            ))}
          </div>
          <div style={{ flex: 1 }}>
            {activeTab === 'general' && (
              <div className="card"><div className="card-body"><h3 className="mb-4">General Settings</h3>
                <div className="grid grid-2 gap-4">
                  <div className="input-group"><label className="input-label">School Name</label><input className="input" value={schoolName} onChange={e => { setSchoolName(e.target.value); setSaved(false); }} /></div>
                  <div className="input-group"><label className="input-label">Contact Email</label><input className="input" type="email" value={email} onChange={e => { setEmail(e.target.value); setSaved(false); }} /></div>
                  <div className="input-group"><label className="input-label">Phone</label><input className="input" value={phone} onChange={e => { setPhone(e.target.value); setSaved(false); }} /></div>
                  <div className="input-group"><label className="input-label">Board</label><select className="select"><option>CBSE</option><option>ICSE</option><option>State Board</option></select></div>
                  <div className="input-group" style={{ gridColumn: 'span 2' }}><label className="input-label">Address</label><textarea className="input" rows={2} value={address} onChange={e => { setAddress(e.target.value); setSaved(false); }} style={{ resize: 'vertical' }}></textarea></div>
                </div>
                <div className="flex gap-3 mt-4 items-center"><button className="btn btn-primary" onClick={save}><span className="icon icon-sm">save</span>Save Changes</button>{saved && <span className="badge badge-success"><span className="icon icon-sm">check</span> Saved!</span>}</div>
              </div></div>
            )}
            {activeTab === 'academic' && (
              <div className="card"><div className="card-body"><h3 className="mb-4">Academic Configuration</h3>
                <div className="grid grid-2 gap-4">
                  <div className="input-group"><label className="input-label">Academic Session</label><select className="select"><option>2025-2026</option><option>2024-2025</option></select></div>
                  <div className="input-group"><label className="input-label">Grading System</label><select className="select"><option>A+ to F (Percentage)</option><option>CGPA (10 scale)</option><option>Pass/Fail</option></select></div>
                  <div className="input-group"><label className="input-label">Classes Offered</label><input className="input" defaultValue="1 to 12" /></div>
                  <div className="input-group"><label className="input-label">Sections per Class</label><input className="input" defaultValue="A, B" /></div>
                </div>
                <button className="btn btn-primary mt-4" onClick={save}><span className="icon icon-sm">save</span>Save</button>
              </div></div>
            )}
            {activeTab === 'fees' && (
              <div className="card"><div className="card-body"><h3 className="mb-4">Fee Structure</h3>
                <table className="table"><thead><tr><th>Fee Type</th><th>Amount (₹)</th><th>Frequency</th><th>Actions</th></tr></thead><tbody>
                  {[{ t: 'Tuition Fee', a: 5000, f: 'Monthly' }, { t: 'Bus Fee', a: 2500, f: 'Monthly' }, { t: 'Development Fee', a: 15000, f: 'Annual' }, { t: 'Lab Fee', a: 3000, f: 'Half-Yearly' }].map(fee => (
                    <tr key={fee.t}><td className="font-semibold">{fee.t}</td><td><input className="input" type="number" defaultValue={fee.a} style={{ width: 120 }} /></td><td><select className="select" defaultValue={fee.f} style={{ width: 130 }}><option>Monthly</option><option>Quarterly</option><option>Half-Yearly</option><option>Annual</option></select></td><td><button className="btn btn-sm btn-ghost"><span className="icon icon-sm text-danger">delete</span></button></td></tr>
                  ))}
                </tbody></table>
                <button className="btn btn-primary mt-4" onClick={save}><span className="icon icon-sm">save</span>Save Fee Structure</button>
              </div></div>
            )}
            {activeTab === 'notif' && (
              <div className="card"><div className="card-body"><h3 className="mb-4">Notification Preferences</h3>
                {[{ l: 'Email Notifications', v: true }, { l: 'SMS Alerts for Fee Due', v: true }, { l: 'Attendance Alerts to Parents', v: true }, { l: 'Result Published Alert', v: false }, { l: 'PTM Reminders', v: true }].map(n => (
                  <div key={n.l} style={{ display: 'flex', justifyContent: 'space-between', padding: '12px 0', borderBottom: '1px solid var(--gray-100)', alignItems: 'center' }}>
                    <span className="font-semibold" style={{ fontSize: '0.875rem' }}>{n.l}</span>
                    <label style={{ position: 'relative', width: 44, height: 24, display: 'inline-block' }}><input type="checkbox" defaultChecked={n.v} style={{ opacity: 0, width: 0, height: 0 }} /><span style={{ position: 'absolute', cursor: 'pointer', inset: 0, background: n.v ? 'var(--primary)' : 'var(--gray-300)', borderRadius: 24, transition: '0.3s' }}><span style={{ position: 'absolute', width: 18, height: 18, background: 'white', borderRadius: '50%', top: 3, left: n.v ? 23 : 3, transition: '0.3s' }}></span></span></label>
                  </div>
                ))}
                <button className="btn btn-primary mt-4" onClick={save}><span className="icon icon-sm">save</span>Save</button>
              </div></div>
            )}
            {activeTab === 'users' && (
              <div className="card"><div className="card-body"><h3 className="mb-4">Users & Roles</h3>
                <table className="table"><thead><tr><th>Role</th><th>Users</th><th>Permissions</th><th>Status</th></tr></thead><tbody>
                  {[{ r: 'Super Admin', u: 1, p: 'Full Access' }, { r: 'Admin', u: 2, p: 'Full except multi-branch' }, { r: 'Principal', u: 1, p: 'Academic oversight' }, { r: 'Finance', u: 2, p: 'Financial management' }, { r: 'Teacher', u: 45, p: 'Classes, attendance, marks' }, { r: 'Student', u: 1482, p: 'View own data' }, { r: 'Parent', u: 1200, p: 'View child data' }].map(role => (
                    <tr key={role.r}><td className="font-semibold">{role.r}</td><td><span className="badge badge-primary">{role.u}</span></td><td className="text-sm text-gray">{role.p}</td><td><span className="badge badge-success">Active</span></td></tr>
                  ))}
                </tbody></table>
              </div></div>
            )}
            {activeTab === 'backup' && (
              <div className="card"><div className="card-body"><h3 className="mb-4">Backup & Export</h3>
                <div className="flex flex-col gap-4">
                  {[{ l: 'Export Student Data', i: 'group', desc: 'Download all student records as CSV' }, { l: 'Export Staff Data', i: 'badge', desc: 'Download all staff records as CSV' }, { l: 'Export Fee Records', i: 'payments', desc: 'Download fee transactions' }, { l: 'Full Database Backup', i: 'cloud_download', desc: 'Create full system backup' }].map(action => (
                    <div key={action.l} style={{ display: 'flex', justifyContent: 'space-between', padding: 16, background: 'var(--gray-50)', borderRadius: 8, alignItems: 'center' }}>
                      <div className="flex items-center gap-3"><span className="icon" style={{ color: 'var(--primary)' }}>{action.i}</span><div><span className="font-semibold" style={{ fontSize: '0.875rem' }}>{action.l}</span><div className="text-xs text-gray">{action.desc}</div></div></div>
                      <button className="btn btn-sm btn-secondary"><span className="icon icon-sm">download</span>Export</button>
                    </div>
                  ))}
                </div>
              </div></div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
