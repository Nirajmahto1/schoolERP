'use client';
// ──────────────────────────────────────────────
// Branches — multi-branch management screen
//
// The owner's view of the school's structure: every branch with its class,
// student and staff counts; adding a branch provisions its academic year and
// class ladder automatically so it can take enrolments immediately.
//
// Branch admins: creating a branch used to strand it — no account could work
// inside it. Each card now lists its admins and offers two ways to attach
// one: pick an existing account (owner, another branch's admin, any staff
// user) or create a fresh branch-admin inline. Attached admins get a branch
// option in the topbar switcher; new accounts land in their branch on first
// login.
// ──────────────────────────────────────────────

import Topbar from '@/components/Topbar';
import { useCallback, useEffect, useState } from 'react';
import { branchApi, staffApi, type BranchAdmin } from '@/lib/api';
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

  // Admin management state — one modal at a time, per branch.
  const [adminsOf, setAdminsOf] = useState<BranchRow | null>(null);
  const [admins, setAdmins] = useState<BranchAdmin[]>([]);
  const [adminsLoading, setAdminsLoading] = useState(false);
  const [mode, setMode] = useState<'existing' | 'new'>('existing');
  const [pickUserId, setPickUserId] = useState('');
  const [candidates, setCandidates] = useState<Array<{ id: string; label: string }>>([]);
  const [newAdmin, setNewAdmin] = useState({ email: '', password: '', firstName: '', lastName: '', phone: '' });
  const [modalError, setModalError] = useState<string | null>(null);
  const [modalBusy, setModalBusy] = useState(false);

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

  // ── Admin modal ──

  const openAdmins = async (b: BranchRow) => {
    setAdminsOf(b);
    setAdminsLoading(true);
    setModalError(null);
    setPickUserId('');
    setMode('existing');
    setNewAdmin({ email: '', password: '', firstName: '', lastName: '', phone: '' });
    try {
      const [list, staffList] = await Promise.all([branchApi.admins(b.id), staffApi.list().catch(() => ({ data: [] }))]);
      setAdmins(list);
      // Candidates: every staff user is a potential attach target; the owner
      // and existing admins of THIS branch are filtered out server-side of
      // duplicates anyway (upsert re-activates).
      setCandidates(
        (staffList.data || [])
          .filter((s: any) => s.userId)
          .map((s: any) => ({ id: s.userId, label: `${s.firstName} ${s.lastName}`.trim() + (s.designation ? ` — ${s.designation}` : '') })),
      );
    } catch (err: any) {
      setModalError(err.detail || 'Could not load admins.');
    } finally {
      setAdminsLoading(false);
    }
  };

  const closeAdmins = () => {
    setAdminsOf(null);
    setAdmins([]);
    setCandidates([]);
  };

  async function attachExisting(e: React.FormEvent) {
    e.preventDefault();
    if (!adminsOf || !pickUserId) return;
    setModalBusy(true);
    setModalError(null);
    try {
      await branchApi.assignAdmin(adminsOf.id, { userId: pickUserId });
      await openAdmins(adminsOf);
      await load();
    } catch (err: any) {
      setModalError(err.detail || 'Could not attach the admin.');
    } finally {
      setModalBusy(false);
    }
  }

  async function createNewAdmin(e: React.FormEvent) {
    e.preventDefault();
    if (!adminsOf) return;
    setModalBusy(true);
    setModalError(null);
    try {
      await branchApi.assignAdmin(adminsOf.id, newAdmin);
      setNewAdmin({ email: '', password: '', firstName: '', lastName: '', phone: '' });
      await openAdmins(adminsOf);
      await load();
    } catch (err: any) {
      setModalError(err.detail || 'Could not create the branch admin.');
    } finally {
      setModalBusy(false);
    }
  }

  async function removeAdmin(userId: string) {
    if (!adminsOf) return;
    setModalBusy(true);
    try {
      await branchApi.removeAdmin(adminsOf.id, userId);
      await openAdmins(adminsOf);
      await load();
    } catch (err: any) {
      setModalError(err.detail || 'Could not remove the admin.');
    } finally {
      setModalBusy(false);
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
            Attach an admin to each branch so someone can run it day to day.
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
                <button className={styles.adminBtn} onClick={() => openAdmins(b)}>
                  <span className="icon icon-sm">manage_accounts</span>
                  Admins & access
                </button>
              </div>
            ))}
            {!branches.length && <p className={styles.hint}>No branches yet — add the first one.</p>}
          </div>
        )}

        {adminsOf && (
          <div className={styles.overlay} onClick={closeAdmins}>
            <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
              <div className={styles.modalHead}>
                <h2>Admins — {adminsOf.name}</h2>
                <button className={styles.closeBtn} onClick={closeAdmins} aria-label="Close">✕</button>
              </div>
              <p className={styles.hint}>
                These accounts can switch into <strong>{adminsOf.name}</strong> from the
                topbar branch selector and manage its staff, students, fees and timetable.
              </p>

              {modalError && <div className={styles.error}>{modalError}</div>}

              {adminsLoading ? (
                <p className={styles.hint}>Loading…</p>
              ) : (
                <div className={styles.adminList}>
                  {admins.length === 0 && <p className={styles.meta}>No admins attached yet.</p>}
                  {admins.map((a) => (
                    <div key={a.assignmentId} className={styles.adminRow}>
                      <div className={styles.adminWho}>
                        <strong>{a.name || a.email}</strong>
                        <span>{a.email} · {a.roleCode.replace('_', ' ')}{!a.isActive && ' · inactive'}</span>
                      </div>
                      {a.roleCode !== 'SUPER_ADMIN' && (
                        <button className={styles.removeBtn} onClick={() => removeAdmin(a.userId)} disabled={modalBusy}>
                          Remove
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}

              <div className={styles.modeTabs}>
                <button className={mode === 'existing' ? styles.tabActive : styles.tab} onClick={() => setMode('existing')}>
                  Attach existing account
                </button>
                <button className={mode === 'new' ? styles.tabActive : styles.tab} onClick={() => setMode('new')}>
                  Create new admin
                </button>
              </div>

              {mode === 'existing' ? (
                <form onSubmit={attachExisting}>
                  <label className={styles.modalLabel}>
                    Staff account
                    <select value={pickUserId} onChange={(e) => setPickUserId(e.target.value)} required>
                      <option value="">Choose a staff member…</option>
                      {candidates.map((c) => (
                        <option key={c.id} value={c.id}>{c.label}</option>
                      ))}
                    </select>
                  </label>
                  <button className={styles.primaryBtn} disabled={modalBusy || !pickUserId}>
                    {modalBusy ? 'Attaching…' : 'Attach as branch admin'}
                  </button>
                </form>
              ) : (
                <form onSubmit={createNewAdmin}>
                  <div className={styles.row}>
                    <label className={styles.modalLabel}>
                      First name
                      <input value={newAdmin.firstName} onChange={(e) => setNewAdmin((f) => ({ ...f, firstName: e.target.value }))} placeholder="Priya" />
                    </label>
                    <label className={styles.modalLabel}>
                      Last name
                      <input value={newAdmin.lastName} onChange={(e) => setNewAdmin((f) => ({ ...f, lastName: e.target.value }))} placeholder="Sharma" />
                    </label>
                  </div>
                  <div className={styles.row}>
                    <label className={styles.modalLabel}>
                      Email *
                      <input type="email" value={newAdmin.email} onChange={(e) => setNewAdmin((f) => ({ ...f, email: e.target.value }))} required placeholder="priya@yourschool.in" />
                    </label>
                    <label className={styles.modalLabel}>
                      Password * (10+ chars)
                      <input type="password" value={newAdmin.password} onChange={(e) => setNewAdmin((f) => ({ ...f, password: e.target.value }))} required minLength={10} placeholder="Set a strong password" />
                    </label>
                  </div>
                  <label className={styles.modalLabel}>
                    Phone
                    <input value={newAdmin.phone} onChange={(e) => setNewAdmin((f) => ({ ...f, phone: e.target.value }))} placeholder="98765 43210" />
                  </label>
                  <button className={styles.primaryBtn} disabled={modalBusy}>
                    {modalBusy ? 'Creating…' : 'Create branch admin'}
                  </button>
                </form>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
