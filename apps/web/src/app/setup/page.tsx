'use client';
// ──────────────────────────────────────────────
// First-run setup wizard
//
// Shown only while the deployment has no school. Names the school, creates
// the first branch and the owner account, then hands off to login. On an
// already-provisioned deployment this page redirects to the dashboard —
// the server-side empty-database guard is the real lock; this page is the
// friendly face of it.
// ──────────────────────────────────────────────

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { setupApi } from '@/lib/api';
import styles from './setup.module.css';

const ACCEPTED_TYPES = ['image/jpeg', 'image/png'];
const MAX_LOGO_MB = 2;

interface FormState {
  schoolName: string;
  schoolCode: string;
  address: string;
  city: string;
  state: string;
  pincode: string;
  phone: string;
  email: string;
  branchName: string;
  branchCode: string;
  adminEmail: string;
  adminPassword: string;
  confirm: string;
}

const initial: FormState = {
  schoolName: '',
  schoolCode: '',
  address: '',
  city: '',
  state: '',
  pincode: '',
  phone: '',
  email: '',
  branchName: 'Main Campus',
  branchCode: 'MAIN',
  adminEmail: '',
  adminPassword: '',
  confirm: '',
};

export default function SetupPage() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [form, setForm] = useState<FormState>(initial);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [logo, setLogo] = useState<File | null>(null);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let mounted = true;
    setupApi
      .status()
      .then((s) => {
        if (!mounted) return;
        if (s.provisioned) router.replace('/login');
        else setChecking(false);
      })
      .catch(() => {
        // Status unreachable (services down) — still render the wizard; the
        // POST will surface a real error if the backend is genuinely broken.
        if (mounted) setChecking(false);
      });
    return () => {
      mounted = false;
    };
  }, [router]);

  const set = (key: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  function pickLogo(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    setError(null);
    if (!file) {
      setLogo(null);
      setLogoPreview(null);
      return;
    }
    if (!ACCEPTED_TYPES.includes(file.type)) {
      setError('Logo must be a JPG or PNG image.');
      e.target.value = '';
      return;
    }
    if (file.size > MAX_LOGO_MB * 1024 * 1024) {
      setError(`Logo must be ${MAX_LOGO_MB} MB or smaller.`);
      e.target.value = '';
      return;
    }
    setLogo(file);
    // Object URL for the live preview; revoked on replace/unmount by GC of
    // the document — fine for a wizard lifetime.
    setLogoPreview(URL.createObjectURL(file));
  }

  function clearLogo() {
    setLogo(null);
    setLogoPreview(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setFieldErrors({});
    if (form.adminPassword !== form.confirm) {
      setError('Passwords do not match.');
      return;
    }
    setSubmitting(true);
    try {
      const result = await setupApi.complete({
        schoolName: form.schoolName,
        schoolCode: form.schoolCode,
        address: form.address,
        city: form.city,
        state: form.state,
        pincode: form.pincode,
        phone: form.phone,
        email: form.email,
        branchName: form.branchName,
        branchCode: form.branchCode,
        adminEmail: form.adminEmail,
        adminPassword: form.adminPassword,
        logo,
      });
      void result.logoUrl;
      setDone(true);
    } catch (err: any) {
      setError(err.detail || 'Setup failed. Check the service logs.');
      if (err.errors) setFieldErrors(err.errors);
    } finally {
      setSubmitting(false);
    }
  }

  if (checking) {
    return (
      <main className={styles.page}>
        <div className={styles.card}>
          <p className={styles.hint}>Checking deployment status…</p>
        </div>
      </main>
    );
  }

  if (done) {
    return (
      <main className={styles.page}>
        <div className={styles.card}>
          <span className="icon" style={{ fontSize: 48, color: '#16a34a' }}>check_circle</span>
          <h1>You're all set</h1>
          <p className={styles.hint}>
            {form.schoolName} is ready. Sign in with the owner account you just created.
          </p>
          <button className={styles.primaryBtn} onClick={() => router.push('/login')}>
            Go to sign in
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <div className={styles.card}>
        <span className="icon" style={{ fontSize: 40, color: '#2563eb' }}>school</span>
        <h1>Welcome to your school ERP</h1>
        <p className={styles.hint}>
          First-time setup. You'll name your school, create the first branch and your
          owner account. You can add more branches, staff and students from the
          dashboard afterwards.
        </p>

        {error && <div className={styles.error}>{error}</div>}

        <form onSubmit={submit} noValidate>
          <fieldset>
            <legend>School</legend>
            <label>
              School name *
              <input value={form.schoolName} onChange={set('schoolName')} required placeholder="e.g. Sunrise Public School" />
              {fieldErrors.schoolName && <em>{fieldErrors.schoolName[0]}</em>}
            </label>
            <div className={styles.logoRow}>
              {logoPreview ? (
                <div className={styles.logoPreviewBox}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={logoPreview} alt="School logo preview" className={styles.logoPreviewImg} />
                </div>
              ) : (
                <div className={styles.logoPreviewBox}>
                  <span className="icon" style={{ fontSize: 32, color: '#94a3b8' }}>image</span>
                </div>
              )}
              <div className={styles.logoControls}>
                <label className={styles.fileLabel}>
                  Logo (JPG or PNG, up to 2 MB)
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/jpeg,image/png"
                    onChange={pickLogo}
                    className={styles.fileInput}
                  />
                </label>
                {logo && (
                  <button type="button" className={styles.removeBtn} onClick={clearLogo}>
                    Remove
                  </button>
                )}
              </div>
            </div>
            <div className={styles.row}>
              <label>
                School code *
                <input value={form.schoolCode} onChange={set('schoolCode')} required maxLength={10} placeholder="e.g. SPS" />
                {fieldErrors.schoolCode && <em>{fieldErrors.schoolCode[0]}</em>}
              </label>
              <label>
                Phone
                <input value={form.phone} onChange={set('phone')} placeholder="School office phone" />
                {fieldErrors.phone && <em>{fieldErrors.phone[0]}</em>}
              </label>
            </div>
            <label>
              Address
              <input value={form.address} onChange={set('address')} placeholder="Street address" />
            </label>
            <div className={styles.row}>
              <label>
                City
                <input value={form.city} onChange={set('city')} />
              </label>
              <label>
                State
                <input value={form.state} onChange={set('state')} />
              </label>
              <label>
                PIN code
                <input value={form.pincode} onChange={set('pincode')} maxLength={6} inputMode="numeric" />
                {fieldErrors.pincode && <em>{fieldErrors.pincode[0]}</em>}
              </label>
            </div>
          </fieldset>

          <fieldset>
            <legend>First branch</legend>
            <div className={styles.row}>
              <label>
                Branch name
                <input value={form.branchName} onChange={set('branchName')} />
              </label>
              <label>
                Branch code
                <input value={form.branchCode} onChange={set('branchCode')} maxLength={8} />
                {fieldErrors.branchCode && <em>{fieldErrors.branchCode[0]}</em>}
              </label>
            </div>
          </fieldset>

          <fieldset>
            <legend>Owner account</legend>
            <label>
              Admin email *
              <input type="email" value={form.adminEmail} onChange={set('adminEmail')} required placeholder="you@yourschool.in" />
              {fieldErrors.adminEmail && <em>{fieldErrors.adminEmail[0]}</em>}
            </label>
            <div className={styles.row}>
              <label>
                Password *
                <input type="password" value={form.adminPassword} onChange={set('adminPassword')} required />
                {fieldErrors.adminPassword && <em>{fieldErrors.adminPassword[0]}</em>}
              </label>
              <label>
                Confirm password *
                <input type="password" value={form.confirm} onChange={set('confirm')} required />
              </label>
            </div>
            <p className={styles.hint}>
              At least 10 characters with upper case, lower case and a digit. This
              account owns the deployment — you can invite staff and branch admins
              later from the dashboard.
            </p>
          </fieldset>

          <button className={styles.primaryBtn} disabled={submitting}>
            {submitting ? 'Setting up…' : 'Complete setup'}
          </button>
        </form>
      </div>
    </main>
  );
}
