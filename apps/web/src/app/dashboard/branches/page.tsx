'use client';
// ──────────────────────────────────────────────
// Branches — multi-branch management screen
//
// The owner's view of the school's structure: every branch with its class,
// student and staff counts; adding a branch provisions its academic year and
// class ladder automatically so it can take enrolments immediately.
// ──────────────────────────────────────────────

import Topbar from '@/components/Topbar';
import { useCallback, useEffect, useState } from 'react';
import { branchApi } from '@/lib/api';
import styles from './branches.module.css';

interface BranchRow {
  id: string;
  name: string;
  code: string;
  address: string;
  phone: string;
  email: string;
  isActive: boolean;
  students: number;
  staff: number;
  classes: number;
}

export default function BranchesPage() {
  const [branches, setBranches] = useState<BranchRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ name: '', code: '', address: '', phone: '', email: '' });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setBranches(await branchApi.list());
    } catch (err: any) {
      setError(err.detail || 'Could not load branches.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  async function addBranch(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      await branchApi.add(form);
      setShowAdd(false);
      setForm({ name: '', code: '', address: '', phone: '', email: '' });
      await load();
    } catch (err: any) {
      setError(err.detail || 'Could not add the branch.');
      if (err.errors) setFieldErrors(err.errors);
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(b: BranchRow) {
    setBusy(true);
    try {
      await branchApi.update(b.id, { isActive: !b.isActive });
      await load();
    } catch (err: any) {
      setError(err.detail || 'Update failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Topbar title="Branches" subtitle="Your school's campuses and their load" />
      <div className={styles.page}>
        {error && <div className={styles.error}>{error}</div>}

        <div className={styles.header}>
          <p className={styles.hint}>
            Adding a branch sets up its academic year and the full class ladder
            (Nursery → XII) automatically — ready for students, staff and a timetable.
          </p>
          <button className={styles.primaryBtn} onClick={() => setShowAdd((s) => !s)}>
            {showAdd ? 'Cancel' : '+ Add branch'}
          </button>
        </div>

        {showAdd && (
          <form className={styles.card} onSubmit={addBranch}>
            <div className={styles.row}>
              <label>
                Branch name *
                <input value={form.name} onChange={set('name')} required placeholder="e.g. North Campus" />
                {fieldErrors.name && <em>{fieldErrors.name[0]}</em>}
              </label>
              <label>
                Branch code *
                <input value={form.code} onChange={set('code')} required maxLength={8} placeholder="e.g. NORTH" />
                {fieldErrors.code && <em>{fieldErrors.code[0]}</em>}
              </label>
            </div>
            <div className={styles.row}>
              <label>
                Address
                <input value={form.address} onChange={set('address')} />
              </label>
              <label>
                Phone
                <input value={form.phone} onChange={set('phone')} />
              </label>
            </div>
            <label>
              Email
              <input type="email" value={form.email} onChange={set('email')} />
              {fieldErrors.email && <em>{fieldErrors.email[0]}</em>}
            </label>
            <button className={styles.primaryBtn} disabled={busy}>
              {busy ? 'Adding…' : 'Add branch'}
            </button>
          </form>
        )}

        {loading ? (
          <p className={styles.hint}>Loading…</p>
        ) : (
          <div className={styles.grid}>
            {branches.map((b) => (
              <div key={b.id} className={`${styles.card} ${!b.isActive ? styles.inactive : ''}`}>
                <div className={styles.cardHead}>
                  <div>
                    <h3>{b.name}</h3>
                    <span className={styles.code}>{b.code}</span>
                  </div>
                  <button
                    className={b.isActive ? styles.ghostBtn : styles.ghostBtnActive}
                    onClick={() => toggleActive(b)}
                    disabled={busy}
                  >
                    {b.isActive ? 'Deactivate' : 'Activate'}
                  </button>
                </div>
                <div className={styles.stats}>
                  <div><strong>{b.students}</strong><span>students</span></div>
                  <div><strong>{b.staff}</strong><span>staff</span></div>
                  <div><strong>{b.classes}</strong><span>classes</span></div>
                </div>
                <p className={styles.meta}>{b.address || '—'}</p>
                <p className={styles.meta}>{b.phone || '—'} · {b.email || '—'}</p>
              </div>
            ))}
            {!branches.length && <p className={styles.hint}>No branches yet — add the first one.</p>}
          </div>
        )}
      </div>
    </>
  );
}
