'use client';
import Topbar from '@/components/Topbar';
import { useAuth } from '@/context/AuthContext';
import { useState, useEffect } from 'react';
import { studentApi, teacherApi } from '@/lib/api';

export default function ProfilePage() {
  const { user } = useAuth();
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [profileData, setProfileData] = useState<any>(null);
  const [savingProfile, setSavingProfile] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  const [showPasswordForm, setShowPasswordForm] = useState(false);
  const [profileMsg, setProfileMsg] = useState({ type: '', text: '' });
  const [pwdMsg, setPwdMsg] = useState({ type: '', text: '' });

// Profile Form state
  // ... password form state handled in identical blocks natively ...
  const [formData, setFormData] = useState({ name: user?.name || '', phone: '' });
  const [pwdData, setPwdData] = useState({ current: '', new: '', confirm: '' });

  useEffect(() => {
    const fetchProfile = async () => {
      try {
        const isStaff = !['STUDENT', 'PARENT'].includes(user?.role || '');
        const data = isStaff ? await teacherApi.getProfile() : await studentApi.getProfile();
        setProfileData(data);
        setFormData({ name: `${data.firstName || ''} ${data.lastName || ''}`.trim(), phone: data.phone || '' });
      } catch (err) { console.error('Failed to fetch profile', err); } finally { setLoading(false); }
    };
    if (user) fetchProfile();
  }, [user]);

  if (!user || loading) return <div className="flex items-center justify-center p-12"><span className="icon animate-spin text-4xl text-primary">sync</span></div>;

  const handleProfileSave = async () => {
    setSavingProfile(true);
    setProfileMsg({ type: '', text: '' });
    try {
      const parts = formData.name.trim().split(' ');
      const firstName = parts[0];
      const lastName = parts.slice(1).join(' ') || '';

      const isStaff = !['STUDENT', 'PARENT'].includes(user?.role || '');
      const updated = isStaff 
        ? await teacherApi.updateProfile({ firstName, lastName, phone: formData.phone }) 
        : await studentApi.updateProfile({ firstName, lastName, phone: formData.phone });

      setProfileData(updated);
      setProfileMsg({ type: 'success', text: 'Profile updated successfully!' });
      setEditing(false);
    } catch (err: any) { setProfileMsg({ type: 'error', text: err.detail || 'Failed to update profile' }); } finally { setSavingProfile(false); }
  };

  const handleChangePassword = async () => {
    if (pwdData.new !== pwdData.confirm) return setPwdMsg({ type: 'error', text: 'New passwords do not match' });
    setChangingPassword(true);
    setPwdMsg({ type: '', text: '' });
    try {
      const isStaff = !['STUDENT', 'PARENT'].includes(user?.role || '');
      if (isStaff) {
        await teacherApi.changePassword({ currentPassword: pwdData.current, newPassword: pwdData.new });
      } else {
        await studentApi.changePassword({ currentPassword: pwdData.current, newPassword: pwdData.new });
      }
      setPwdMsg({ type: 'success', text: 'Password successfully updated' });
      setPwdData({ current: '', new: '', confirm: '' });
      setTimeout(() => setShowPasswordForm(false), 2000);
    } catch (err: any) { setPwdMsg({ type: 'error', text: err.detail || 'Password change failed' }); } finally { setChangingPassword(false); }
  };

  return (
    <>
      <Topbar title="My Profile" subtitle="Manage your personal information and security" />
      <div style={{ padding: '24px 32px' }}>
        <div className="flex gap-6 items-start" style={{ flexWrap: 'wrap' }}>
          <div className="card" style={{ width: 320 }}>
            <div className="card-body" style={{ textAlign: 'center' }}>
              <div className="avatar" style={{ width: 120, height: 120, fontSize: 40, margin: '0 auto 20px' }}>
                {profileData ? `${profileData.firstName[0]}${profileData.lastName[0]}`.toUpperCase() : user.name.split(' ').map((n: string) => n[0]).join('')}
              </div>
              <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 4 }}>
                {profileData ? `${profileData.firstName} ${profileData.lastName}` : user.name}
              </h2>
              <div className="badge badge-primary">{user.role}</div>
              <p className="text-sm text-gray mt-4">{user.email}</p>
              
              {profileData?.class && (
                 <p className="text-sm font-medium mt-2">Class {profileData.class.name} - {profileData.section?.name}</p>
              )}
              
              <button 
                className="btn btn-secondary w-full mt-8" 
                onClick={() => {
                  setEditing(!editing);
                  if (editing && profileData) {
                    setFormData({ name: `${profileData.firstName} ${profileData.lastName}`, phone: profileData.phone || '' });
                  }
                }}
                disabled={savingProfile}
              >
                <span className="icon icon-sm">{editing ? 'close' : 'edit'}</span>
                {editing ? 'Cancel' : 'Edit Profile'}
              </button>
            </div>
          </div>

          <div className="card flex-1" style={{ minWidth: 400 }}>
            <div className="card-body">
              <h3 className="mb-6">Account Information</h3>
              {profileMsg.text && (
                <div className={`badge mb-4 w-full p-2 ${profileMsg.type === 'error' ? 'badge-danger' : 'badge-success'}`}>
                  {profileMsg.text}
                </div>
              )}
              <div className="grid grid-2 gap-6">
                <div className="input-group">
                  <label className="input-label">Full Name</label>
                  <input 
                    className="input" 
                    value={formData.name} 
                    onChange={e => setFormData({ ...formData, name: e.target.value })}
                    disabled={!editing || savingProfile} 
                  />
                </div>
                <div className="input-group">
                  <label className="input-label">Email Address</label>
                  <input className="input" defaultValue={user.email} disabled={true} />
                </div>
                <div className="input-group">
                  <label className="input-label">Phone Number</label>
                  <input 
                    className="input" 
                    value={formData.phone} 
                    onChange={e => setFormData({ ...formData, phone: e.target.value })}
                    disabled={!editing || savingProfile} 
                    placeholder="+91 98765..."
                  />
                </div>
                <div className="input-group">
                  <label className="input-label">Username</label>
                  <input className="input" defaultValue={user.email.split('@')[0]} disabled={true} />
                </div>
              </div>

              {editing && (
                <div className="flex justify-end mt-8">
                  <button className="btn btn-primary" onClick={handleProfileSave} disabled={savingProfile}>
                    {savingProfile && <span className="icon animate-spin mr-2">sync</span>}
                    {savingProfile ? 'Saving...' : 'Save Changes'}
                  </button>
                </div>
              )}

              <div style={{ marginTop: 40, paddingTop: 32, borderTop: '1px solid var(--gray-100)' }}>
                <h3 className="mb-6">Security</h3>
                
                {!showPasswordForm ? (
                  <div className="flex justify-between items-center p-4" style={{ background: 'var(--gray-50)', borderRadius: 12 }}>
                    <div>
                      <div className="font-semibold">Password</div>
                      <div className="text-sm text-gray">Protect your account with a secure password</div>
                    </div>
                    <button className="btn btn-sm btn-secondary" onClick={() => setShowPasswordForm(true)}>Change Password</button>
                  </div>
                ) : (
                  <div className="p-4" style={{ background: 'var(--gray-50)', borderRadius: 12 }}>
                    <div className="flex justify-between items-center mb-4">
                      <div className="font-semibold">Change Password</div>
                      <button className="btn btn-sm btn-ghost" onClick={() => setShowPasswordForm(false)} disabled={changingPassword}>Cancel</button>
                    </div>
                    {pwdMsg.text && (
                      <div className={`badge mb-4 w-full p-2 ${pwdMsg.type === 'error' ? 'badge-danger' : 'badge-success'}`}>
                        {pwdMsg.text}
                      </div>
                    )}
                    <div className="grid gap-4">
                      <div className="input-group">
                        <label className="input-label">Current Password</label>
                        <input type="password" placeholder="••••••••" className="input" value={pwdData.current} onChange={e => setPwdData({...pwdData, current: e.target.value})} disabled={changingPassword} />
                      </div>
                      <div className="input-group">
                        <label className="input-label">New Password</label>
                        <input type="password" placeholder="••••••••" className="input" value={pwdData.new} onChange={e => setPwdData({...pwdData, new: e.target.value})} disabled={changingPassword} />
                      </div>
                      <div className="input-group">
                        <label className="input-label">Confirm New Password</label>
                        <input type="password" placeholder="••••••••" className="input" value={pwdData.confirm} onChange={e => setPwdData({...pwdData, confirm: e.target.value})} disabled={changingPassword} />
                      </div>
                      <button className="btn btn-primary mt-2" onClick={handleChangePassword} disabled={changingPassword || !pwdData.current || pwdData.new.length < 6}>
                        {changingPassword && <span className="icon animate-spin mr-2">sync</span>}
                        {changingPassword ? 'Updating Security...' : 'Update Password'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
