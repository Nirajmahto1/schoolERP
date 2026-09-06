'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import styles from './page.module.css';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loggingIn, setLoggingIn] = useState(false);
  const [error, setError] = useState('');
  const { login } = useAuth();
  const router = useRouter();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoggingIn(true);
    setError('');
    try {
      await login(email, password);
      router.push('/dashboard');
    } catch (err: any) {
      setError(err?.message || 'Login failed. Please check your credentials and ensure the server is running.');
    }
    setLoggingIn(false);
  };

  return (
    <div className={styles.container}>
      {/* Left Panel */}
      <div className={styles.leftPanel}>
        <div className={styles.brandContent}>
          <div className={styles.brandLogo}>
            <span className="icon" style={{ fontSize: 32, color: 'white' }}>school</span>
          </div>
          <h1 className={styles.brandTitle}>EduCore ERP</h1>
          <p className={styles.brandDesc}>
            The complete ecosystem for modern education. Manage students, staff, and curriculum seamlessly in one place.
          </p>
          <div className={styles.features}>
            <div className={styles.feature}><span className="icon" style={{ color: '#a5b4fc' }}>analytics</span><span>Real-time Analytics</span></div>
            <div className={styles.feature}><span className="icon" style={{ color: '#a5b4fc' }}>security</span><span>Secure Data</span></div>
            <div className={styles.feature}><span className="icon" style={{ color: '#a5b4fc' }}>devices</span><span>Multi-device Access</span></div>
          </div>
        </div>
        <div className={styles.decorCircle1}></div>
        <div className={styles.decorCircle2}></div>
      </div>

      {/* Right Panel */}
      <div className={styles.rightPanel}>
        <div className={styles.formWrapper}>
          <div className={styles.mobileLogo}>
            <div className={styles.brandLogo}><span className="icon" style={{ fontSize: 24, color: 'white' }}>school</span></div>
            <span className={styles.mobileLogoText}>EduCore</span>
          </div>

          <h2 className={styles.formTitle}>Welcome Back</h2>
          <p className={styles.formDesc}>Enter your credentials to access your dashboard</p>

          <form className={styles.form} onSubmit={handleLogin}>
            {error && <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', color: '#dc2626', padding: '8px 12px', borderRadius: 8, fontSize: 13, marginBottom: 4 }}>{error}</div>}
            <div className="input-group">
              <label className="input-label">Email Address</label>
              <div className="input-icon-wrapper"><span className="icon">email</span><input className="input" type="email" placeholder="admin@school.edu.in" value={email} onChange={e => setEmail(e.target.value)} required /></div>
            </div>
            <div className="input-group">
              <label className="input-label">Password</label>
              <div className="input-icon-wrapper"><span className="icon">lock</span><input className="input" type="password" placeholder="Enter your password" value={password} onChange={e => setPassword(e.target.value)} required /></div>
            </div>
            <div className={styles.rememberRow}>
              <label className={styles.checkbox}><input type="checkbox" defaultChecked /><span>Remember me</span></label>
              <a href="#" className={styles.forgotLink}>Forgot password?</a>
            </div>
            <button type="submit" className="btn btn-primary w-full" style={{ padding: '12px', justifyContent: 'center' }} disabled={loggingIn}>
              <span className="icon icon-sm">{loggingIn ? 'hourglass_empty' : 'login'}</span>{loggingIn ? 'Signing In...' : 'Sign In'}
            </button>
          </form>
          <p className={styles.contactText}>New to the school? <a href="#" className={styles.contactLink}>Contact Admission</a></p>
        </div>
      </div>
    </div>
  );
}
