'use client';
// ──────────────────────────────────────────────
// DPDP compliance screen (BUILD_PLAN 10.1)
//
// The Act gives parents (data principals of minors) three rights this page
// makes real instead of PDF-shaped promises:
//   • Consent — one record per (child, purpose), granted/withdrawn with a
//     capture method and evidence, every transition audit-logged upstream.
//   • Access — one click downloads everything the system holds on a child
//     as JSON (the §10.1(3) access right).
//   • Erasure — file a request; leadership completes or rejects it, and the
//     resolution note records exactly what statutory retention kept.
//
// Parents see their own children only (server-enforced); staff search the
// branch. The grievance officer + SLA is surfaced because a lawyer will ask
// for it in the first meeting.
// ──────────────────────────────────────────────

import Topbar from '@/components/Topbar';
import { useCallback, useEffect, useRef, useState } from 'react';
import { authApi, complianceApi, parentApi, studentApi } from '@/lib/api';
import { useT } from '@/lib/i18n';
import styles from './compliance.module.css';

const PURPOSE_LABELS: Record<string, string> = {
  fee_processing: 'Fee processing',
  photos_publication: 'Photos & publication',
  transport_gps: 'Transport GPS tracking',
  medical_care: 'Medical care',
  portal_access: 'Portal access',
};

const METHOD_LABELS: Record<string, string> = {
  PORTAL: 'In-portal',
  PHYSICAL_FORM: 'Physical form',
  ONBOARDING: 'Onboarding',
};

type StudentLite = { id: string; name: string; admissionNo: string };
type ConsentRow = {
  id: string;
  purpose: string;
  status: string;
  method: string;
  grantedAt: string | null;
  withdrawnAt: string | null;
};
type ErasureRow = {
  id: string;
  student: { admissionNo: string; firstName: string; lastName: string };
  reason: string | null;
  status: string;
  createdAt: string;
  processedAt: string | null;
  resolutionNote: string | null;
};

function dateOf(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });
}

export default function CompliancePage() {
  const t = useT();
  const [roles, setRoles] = useState<string[]>([]);
  const [isStaff, setIsStaff] = useState(false);
  const [canProcess, setCanProcess] = useState(false);
  const [officer, setOfficer] = useState<{ officer: string; contact: string | null; slaDays: number } | null>(null);

  // Student selection: parents get their children served; staff search.
  const [children, setChildren] = useState<StudentLite[]>([]);
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<StudentLite[]>([]);
  const [selected, setSelected] = useState<StudentLite | null>(null);

  const [consents, setConsents] = useState<ConsentRow[]>([]);
  const [purposes, setPurposes] = useState<string[]>(Object.keys(PURPOSE_LABELS));
  const [granting, setGranting] = useState<string | null>(null);
  const [grantMethod, setGrantMethod] = useState<'PORTAL' | 'PHYSICAL_FORM' | 'ONBOARDING'>('PORTAL');
  const [grantEvidence, setGrantEvidence] = useState('');

  const [erasureReason, setErasureReason] = useState('');
  const [inbox, setInbox] = useState<ErasureRow[]>([]);
  const [inboxFilter, setInboxFilter] = useState<'ALL' | 'PENDING' | 'COMPLETED' | 'REJECTED'>('ALL');
  const [noteDraft, setNoteDraft] = useState<Record<string, string>>({});

  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');
  const [error, setError] = useState('');
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flash = (msg: string) => { setToast(msg); setTimeout(() => setToast(''), 3500); };

  // ── Load identity + officer + (parents) children on mount ──
  useEffect(() => {
    (async () => {
      try {
        const me = await authApi.me();
        const rs: string[] = me.roles ?? [];
        setRoles(rs);
        const staff = rs.some((r) => ['SUPER_ADMIN', 'BRANCH_ADMIN', 'PRINCIPAL', 'TEACHER', 'HOD', 'ACADEMIC_HEAD', 'ACCOUNTANT', 'FINANCE'].includes(r));
        setIsStaff(staff);
        setCanProcess(rs.some((r) => ['SUPER_ADMIN', 'BRANCH_ADMIN', 'PRINCIPAL'].includes(r)));
      } catch { setError(t('compliance.errorIdentity')); }

      try { setOfficer(await complianceApi.grievanceOfficer()); } catch { /* card stays empty */ }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!roles.length) return;
    (async () => {
      if (roles.includes('PARENT')) {
        try {
          const summary = await parentApi.getMeChildrenSummary();
          const kids: StudentLite[] = (summary?.students ?? []).map((s: any) => ({
            id: s.id,
            name: [s.firstName, s.lastName].filter(Boolean).join(' '),
            admissionNo: s.admissionNo ?? '',
          }));
          setChildren(kids);
          if (kids.length === 1) setSelected(kids[0]);
        } catch { setError(t('compliance.errorChildren')); }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roles]);

  // ── Staff search (debounced) ──
  useEffect(() => {
    if (!isStaff) return;
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(async () => {
      try {
        const res = await studentApi.list({ search: search || undefined, limit: 8 });
        setResults(
          (res?.data ?? []).map((s: any) => ({
            id: s.id,
            name: [s.firstName, s.lastName].filter(Boolean).join(' '),
            admissionNo: s.admissionNo ?? '',
          })),
        );
      } catch { setResults([]); }
    }, 300);
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
  }, [search, isStaff]);

  // ── Consents for the selected child ──
  const loadConsents = useCallback(async (studentId: string) => {
    setConsents([]);
    setError('');
    try {
      const res = await complianceApi.listConsents(studentId);
      setConsents(res?.data ?? []);
      if (res?.data?.[0]?.purposes?.length) setPurposes(res.data[0].purposes);
    } catch (e: any) {
      setError(e?.message || t('compliance.errorConsents'));
    }
  }, [t]);

  useEffect(() => { if (selected) loadConsents(selected.id); }, [selected, loadConsents]);

  // ── Erasure inbox (leadership only) ──
  const loadInbox = useCallback(async () => {
    if (!canProcess) return;
    try {
      const res = await complianceApi.listErasure(inboxFilter === 'ALL' ? undefined : inboxFilter);
      setInbox(res?.data ?? []);
    } catch { setInbox([]); }
  }, [canProcess, inboxFilter]);
  useEffect(() => { loadInbox(); }, [loadInbox]);

  // ── Actions ──
  const grant = async (purpose: string) => {
    if (!selected) return;
    setBusy(true); setError('');
    try {
      await complianceApi.grantConsent(selected.id, {
        purpose,
        method: grantMethod,
        evidence: grantEvidence.trim() || undefined,
      });
      setGranting(null); setGrantEvidence('');
      flash(t('compliance.grantedToast'));
      await loadConsents(selected.id);
    } catch (e: any) { setError(e?.message || t('compliance.errorGrant')); }
    setBusy(false);
  };

  const withdraw = async (purpose: string) => {
    if (!selected) return;
    setBusy(true); setError('');
    try {
      await complianceApi.withdrawConsent(selected.id, purpose);
      flash(t('compliance.withdrawnToast'));
      await loadConsents(selected.id);
    } catch (e: any) { setError(e?.message || t('compliance.errorWithdraw')); }
    setBusy(false);
  };

  const downloadExport = async () => {
    if (!selected) return;
    setBusy(true); setError('');
    try {
      const url = await complianceApi.exportData(selected.id);
      if (!url) throw new Error(t('compliance.errorExport'));
      const a = document.createElement('a');
      a.href = url;
      a.download = `data-export-${selected.admissionNo || selected.id}.json`;
      a.click();
      URL.revokeObjectURL(url);
      flash(t('compliance.exportToast'));
    } catch (e: any) { setError(e?.message || t('compliance.errorExport')); }
    setBusy(false);
  };

  const fileErasure = async () => {
    if (!selected) return;
    setBusy(true); setError('');
    try {
      await complianceApi.fileErasure(selected.id, erasureReason.trim() || undefined);
      setErasureReason('');
      flash(t('compliance.erasureFiledToast'));
      await loadInbox();
    } catch (e: any) { setError(e?.message || t('compliance.errorErasureFile')); }
    setBusy(false);
  };

  const processErasure = async (id: string, action: 'COMPLETE' | 'REJECT') => {
    setBusy(true); setError('');
    try {
      await complianceApi.processErasure(id, action, noteDraft[id]?.trim() || undefined);
      setNoteDraft((d) => ({ ...d, [id]: '' }));
      flash(action === 'COMPLETE' ? t('compliance.erasureCompletedToast') : t('compliance.erasureRejectedToast'));
      await loadInbox();
    } catch (e: any) { setError(e?.message || t('compliance.errorErasureProcess')); }
    setBusy(false);
  };

  // Merge server rows with the known purposes so a child with no records
  // still shows the full consent menu.
  const rows: Array<ConsentRow & { known: boolean }> = purposes.map((p) => {
    const found = consents.find((c) => c.purpose === p);
    return found ? { ...found, known: true } : { id: `missing-${p}`, purpose: p, status: 'NOT_REQUESTED', method: '', grantedAt: null, withdrawnAt: null, known: false };
  }).concat(consents.filter((c) => !purposes.includes(c.purpose)).map((c) => ({ ...c, known: false })));

  const inboxRows = inboxFilter === 'ALL' ? inbox : inbox.filter((r) => r.status === inboxFilter);

  return (
    <>
      <Topbar title={t('compliance.title')} subtitle={t('compliance.subtitle')} />
      <div className={styles.page}>

        {toast && <div className={styles.toast}>{toast}</div>}
        {error && <div className={styles.error}>{error}</div>}

        {officer && (
          <section className={styles.card}>
            <h2 className={styles.cardTitle}>{t('compliance.grievanceTitle')}</h2>
            <div className={styles.officerRow}>
              <span className={styles.officerName}>{officer.officer}</span>
              {officer.contact && <span className={styles.officerContact}>{officer.contact}</span>}
              <span className={styles.slaBadge}>{t('compliance.slaDays', { days: String(officer.slaDays) })}</span>
            </div>
            <p className={styles.muted}>{t('compliance.grievanceNote')}</p>
          </section>
        )}

        {/* ── Child selector ── */}
        <section className={styles.card}>
          <h2 className={styles.cardTitle}>{t('compliance.childTitle')}</h2>
          {isStaff ? (
            <>
              <input
                className={styles.input}
                placeholder={t('compliance.searchPlaceholder')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              {!!results.length && (
                <ul className={styles.resultList}>
                  {results.map((s) => (
                    <li key={s.id}>
                      <button
                        className={`${styles.resultBtn} ${selected?.id === s.id ? styles.selected : ''}`}
                        onClick={() => setSelected(s)}
                      >
                        <strong>{s.name}</strong>
                        <span className={styles.admission}>{s.admissionNo}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <div className={styles.childChips}>
              {children.map((s) => (
                <button
                  key={s.id}
                  className={`${styles.resultBtn} ${selected?.id === s.id ? styles.selected : ''}`}
                  onClick={() => setSelected(s)}
                >
                  <strong>{s.name}</strong>
                  <span className={styles.admission}>{s.admissionNo}</span>
                </button>
              ))}
              {!children.length && <p className={styles.muted}>{t('compliance.noChildren')}</p>}
            </div>
          )}
        </section>

        {selected && (
          <>
            {/* ── Consents ── */}
            <section className={styles.card}>
              <h2 className={styles.cardTitle}>{t('compliance.consentsTitle', { name: selected.name })}</h2>
              <div className={styles.consentList}>
                {rows.map((r) => (
                  <div key={r.id} className={styles.consentRow}>
                    <div className={styles.consentInfo}>
                      <strong>{PURPOSE_LABELS[r.purpose] ?? r.purpose}</strong>
                      <span className={styles.muted}>
                        {r.status === 'GRANTED' && `${t('compliance.grantedOn')} ${dateOf(r.grantedAt)} · ${METHOD_LABELS[r.method] ?? r.method}`}
                        {r.status === 'WITHDRAWN' && `${t('compliance.withdrawnOn')} ${dateOf(r.withdrawnAt)}`}
                        {r.status === 'NOT_REQUESTED' && t('compliance.notRequested')}
                      </span>
                    </div>
                    <div className={styles.consentActions}>
                      <span className={`${styles.pill} ${r.status === 'GRANTED' ? styles.granted : r.status === 'WITHDRAWN' ? styles.withdrawn : styles.none}`}>
                        {r.status === 'GRANTED' ? t('compliance.statusGranted') : r.status === 'WITHDRAWN' ? t('compliance.statusWithdrawn') : t('compliance.statusNone')}
                      </span>
                      {r.status === 'GRANTED' ? (
                        <button className={`${styles.btn} ${styles.btnWarn}`} disabled={busy} onClick={() => withdraw(r.purpose)}>
                          {t('compliance.withdraw')}
                        </button>
                      ) : (
                        <button className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy} onClick={() => { setGranting(granting === r.purpose ? null : r.purpose); setGrantMethod('PORTAL'); setGrantEvidence(''); }}>
                          {t('compliance.grant')}
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              {granting && (
                <div className={styles.grantForm}>
                  <label className={styles.label}>{t('compliance.methodLabel')}</label>
                  <select className={styles.input} value={grantMethod} onChange={(e) => setGrantMethod(e.target.value as typeof grantMethod)}>
                    <option value="PORTAL">{t('compliance.methodPortal')}</option>
                    <option value="PHYSICAL_FORM">{t('compliance.methodPhysical')}</option>
                    <option value="ONBOARDING">{t('compliance.methodOnboarding')}</option>
                  </select>
                  {grantMethod === 'PHYSICAL_FORM' && (
                    <>
                      <label className={styles.label}>{t('compliance.evidenceLabel')}</label>
                      <input className={styles.input} placeholder={t('compliance.evidencePlaceholder')} value={grantEvidence} onChange={(e) => setGrantEvidence(e.target.value)} />
                    </>
                  )}
                  <div className={styles.formActions}>
                    <button className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy} onClick={() => grant(granting)}>{t('compliance.confirmGrant')}</button>
                    <button className={styles.btn} onClick={() => setGranting(null)}>{t('compliance.cancel')}</button>
                  </div>
                </div>
              )}
              <p className={styles.muted}>{t('compliance.consentAuditNote')}</p>
            </section>

            {/* ── Data export ── */}
            <section className={styles.card}>
              <h2 className={styles.cardTitle}>{t('compliance.exportTitle')}</h2>
              <p className={styles.muted}>{t('compliance.exportNote')}</p>
              <button className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy} onClick={downloadExport}>
                {t('compliance.exportButton')}
              </button>
            </section>

            {/* ── Erasure — file ── */}
            <section className={styles.card}>
              <h2 className={styles.cardTitle}>{t('compliance.erasureTitle', { name: selected.name })}</h2>
              <p className={styles.muted}>{t('compliance.erasureNote')}</p>
              <textarea
                className={styles.textarea}
                placeholder={t('compliance.erasurePlaceholder')}
                value={erasureReason}
                onChange={(e) => setErasureReason(e.target.value)}
                rows={2}
              />
              <button className={`${styles.btn} ${styles.btnDanger}`} disabled={busy} onClick={fileErasure}>
                {t('compliance.erasureFile')}
              </button>
            </section>
          </>
        )}

        {/* ── Erasure inbox (leadership only) ── */}
        {canProcess && (
          <section className={styles.card}>
            <div className={styles.inboxHeader}>
              <h2 className={styles.cardTitle}>{t('compliance.inboxTitle')}</h2>
              <div className={styles.filters}>
                {(['ALL', 'PENDING', 'COMPLETED', 'REJECTED'] as const).map((f) => (
                  <button key={f} className={`${styles.filterBtn} ${inboxFilter === f ? styles.filterActive : ''}`} onClick={() => setInboxFilter(f)}>
                    {t(`compliance.filter_${f}`)}
                  </button>
                ))}
              </div>
            </div>
            {!inboxRows.length && <p className={styles.muted}>{t('compliance.inboxEmpty')}</p>}
            <div className={styles.inboxList}>
              {inboxRows.map((r) => (
                <div key={r.id} className={styles.inboxRow}>
                  <div className={styles.inboxMain}>
                    <strong>{r.student.firstName} {r.student.lastName}</strong>
                    <span className={styles.admission}>{r.student.admissionNo}</span>
                    <span className={`${styles.pill} ${r.status === 'PENDING' ? styles.pending : r.status === 'COMPLETED' ? styles.granted : styles.withdrawn}`}>
                      {t(`compliance.status_${r.status}`)}
                    </span>
                  </div>
                  {r.reason && <p className={styles.reason}>{r.reason}</p>}
                  <p className={styles.muted}>
                    {t('compliance.filedOn')} {dateOf(r.createdAt)}
                    {r.processedAt && ` · ${t('compliance.processedOn')} ${dateOf(r.processedAt)}`}
                  </p>
                  {r.resolutionNote && <p className={styles.resolution}>{r.resolutionNote}</p>}
                  {r.status === 'PENDING' && (
                    <div className={styles.processBox}>
                      <input
                        className={styles.input}
                        placeholder={t('compliance.processNotePlaceholder')}
                        value={noteDraft[r.id] ?? ''}
                        onChange={(e) => setNoteDraft((d) => ({ ...d, [r.id]: e.target.value }))}
                      />
                      <div className={styles.formActions}>
                        <button className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy} onClick={() => processErasure(r.id, 'COMPLETE')}>{t('compliance.complete')}</button>
                        <button className={`${styles.btn} ${styles.btnWarn}`} disabled={busy} onClick={() => processErasure(r.id, 'REJECT')}>{t('compliance.reject')}</button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </>
  );
}
