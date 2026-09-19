'use client';
// ──────────────────────────────────────────────
// Office attendance desk (kiosk)
//
// The escape hatch for the GPS self-mark flow: a staff member with no phone,
// a dead battery, or one left at home is marked by the office here. Every
// action hits POST /attendance/staff/amend, which stamps the SERVER clock
// and records the acting account in markedBy — so an office check-in is
// audit-equal to a GPS one, minus the coordinates. Role-gated server-side;
// this page just renders what the day sheet returns, nothing inferred.
// ──────────────────────────────────────────────

import Topbar from '@/components/Topbar';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { attendanceApi, fetchAuthBlob } from '@/lib/api';
import styles from './attendance-desk.module.css';

type DaySheetRow = {
  staffId: string;
  userId: string | null;
  name: string;
  employeeId: string | null;
  designation: string | null;
  department: string | null;
  photo: string | null;
  hasUser: boolean;
  record: {
    status: string;
    remarks: string | null;
    checkInAt: string | null;
    checkOutAt: string | null;
    lateMinutes: number | null;
    markedBy: string;
  } | null;
};

const STATUS_LABEL: Record<string, string> = {
  PRESENT: 'Present',
  LATE: 'Late',
  ABSENT: 'Absent',
  ON_LEAVE: 'On leave',
  HALF_DAY: 'Half day',
  MEDICAL: 'Medical',
  EXCUSED: 'Excused',
};

function timeOf(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
}

/**
 * Profile photos live behind the assertion gate (personal data), so a plain
 * <img src> 401s. Fetch the bytes with the Authorization header and render
 * the object URL; on any failure show the initial-letter fallback.
 */
function AuthPhoto({ src, alt, className }: { src: string; alt: string; className: string }) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let dead = false;
    let created: string | null = null;
    fetchAuthBlob(src).then((u) => {
      if (dead) {
        if (u) URL.revokeObjectURL(u);
        return;
      }
      created = u;
      if (u) setObjectUrl(u);
      else setFailed(true);
    });
    return () => {
      dead = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [src]);

  if (failed || !objectUrl) {
    return (
      <div className={`${className} ${styles.avatarBlank}`}>
        <span className="icon">person</span>
      </div>
    );
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img className={className} src={objectUrl} alt={alt} />;
}

export default function AttendanceDeskPage() {
  const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
  const [rows, setRows] = useState<DaySheetRow[]>([]);
  const [marked, setMarked] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'unmarked' | 'marked'>('all');

  const load = useCallback(async (d: string) => {
    setLoading(true);
    setError(null);
    try {
      const sheet = await attendanceApi.getStaffDaySheet(d);
      setRows(sheet.staff);
      setMarked(sheet.marked);
      setTotal(sheet.total);
    } catch (e: any) {
      setError(e?.detail || e?.message || 'Could not load the day sheet.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(date); }, [date, load]);

  const amend = useCallback(async (staffId: string, action: string) => {
    setBusyId(staffId);
    setError(null);
    try {
      const out = await attendanceApi.amendStaffAttendance({ staffId, date, action: action as any });
      setToast(out.message);
      await load(date);
    } catch (e: any) {
      setError(e?.detail || e?.message || 'Amendment failed.');
    } finally {
      setBusyId(null);
      setTimeout(() => setToast(null), 4000);
    }
  }, [date, load]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter === 'unmarked' && r.record) return false;
      if (filter === 'marked' && !r.record) return false;
      if (!q) return true;
      return [r.name, r.employeeId, r.designation, r.department]
        .some((v) => (v ?? '').toLowerCase().includes(q));
    });
  }, [rows, search, filter]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of rows) if (r.record) c[r.record.status] = (c[r.record.status] ?? 0) + 1;
    return c;
  }, [rows]);

  return (
    <>
      <Topbar title="Attendance Desk" subtitle="Office check-ins, check-outs and corrections — server-clocked, audit-logged" />
      <div className={styles.page}>
        {error && <div className={styles.error}>{error}</div>}

        <div className={styles.toolbar}>
          <div className="input-group" style={{ margin: 0 }}>
            <label className="input-label" style={{ marginBottom: 2, fontSize: 11 }}>Date</label>
            <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ width: 165 }} />
          </div>

          <div className="input-group" style={{ margin: 0, flex: 1, minWidth: 200 }}>
            <label className="input-label" style={{ marginBottom: 2, fontSize: 11 }}>Search staff</label>
            <input
              className="input"
              placeholder="Name, employee ID, department…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <div className={styles.filters}>
            {(['all', 'unmarked', 'marked'] as const).map((f) => (
              <button
                key={f}
                className={`${styles.filterChip} ${filter === f ? styles.filterActive : ''}`}
                onClick={() => setFilter(f)}
              >
                {f === 'all' ? `All (${total})` : f === 'unmarked' ? `Unmarked (${total - marked})` : `Marked (${marked})`}
              </button>
            ))}
          </div>
        </div>

        <div className={styles.summary}>
          <span><b>{marked}</b> of <b>{total}</b> marked</span>
          <span className={styles.pillPresent}>Present {counts.PRESENT ?? 0}</span>
          <span className={styles.pillLate}>Late {counts.LATE ?? 0}</span>
          <span className={styles.pillAbsent}>Absent {counts.ABSENT ?? 0}</span>
          <span className={styles.pillLeave}>Leave {counts.ON_LEAVE ?? 0}</span>
          <span className={styles.pillHalf}>Half day {counts.HALF_DAY ?? 0}</span>
        </div>

        {loading ? (
          <div className={styles.empty}>Loading day sheet…</div>
        ) : visible.length === 0 ? (
          <div className={styles.empty}>No staff match this filter.</div>
        ) : (
          <div className={styles.list}>
            {visible.map((s) => {
              const rec = s.record;
              const busy = busyId === s.staffId;
              const sealed = Boolean(rec?.checkInAt && rec?.checkOutAt);
              return (
                <div key={s.staffId} className={styles.row}>
                  <div className={styles.who}>
                    {s.photo ? (
                      <AuthPhoto src={s.photo} alt={s.name} className={styles.avatar} />
                    ) : (
                      <div className={`${styles.avatar} ${styles.avatarBlank}`}>
                        <span className="icon">person</span>
                      </div>
                    )}
                    <div>
                      <div className={styles.name}>
                        {s.name}
                        {!s.hasUser && <span className={styles.noLogin} title="No login account — office marks only">no login</span>}
                      </div>
                      <div className={styles.meta}>
                        {[s.employeeId, s.designation, s.department].filter(Boolean).join(' · ') || '—'}
                      </div>
                    </div>
                  </div>

                  <div className={styles.state}>
                    {rec ? (
                      <>
                        <span className={`${styles.badge} ${styles[`b_${rec.status}`] ?? ''}`}>
                          {STATUS_LABEL[rec.status] ?? rec.status}
                          {rec.lateMinutes != null && rec.status === 'LATE' ? ` +${rec.lateMinutes}m` : ''}
                        </span>
                        <span className={styles.times}>
                          in {timeOf(rec.checkInAt)} · out {timeOf(rec.checkOutAt)}
                        </span>
                      </>
                    ) : (
                      <span className={`${styles.badge} ${styles.b_none}`}>Not marked</span>
                    )}
                  </div>

                  <div className={styles.actions}>
                    {!rec && (
                      <>
                        <button className={`${styles.btn} ${styles.btnIn}`} disabled={busy} onClick={() => amend(s.staffId, 'CHECK_IN')}>
                          <span className="icon">login</span> Check in
                        </button>
                        <button className={`${styles.btn} ${styles.btnAbsent}`} disabled={busy} onClick={() => amend(s.staffId, 'SET_ABSENT')}>
                          Absent
                        </button>
                        <button className={`${styles.btn} ${styles.btnLeave}`} disabled={busy} onClick={() => amend(s.staffId, 'SET_ON_LEAVE')}>
                          On leave
                        </button>
                      </>
                    )}

                    {rec && !rec.checkOutAt && rec.checkInAt && (
                      <button className={`${styles.btn} ${styles.btnOut}`} disabled={busy} onClick={() => amend(s.staffId, 'CHECK_OUT')}>
                        <span className="icon">logout</span> Check out
                      </button>
                    )}

                    {rec && (
                      <>
                        {!sealed && (
                          <button className={`${styles.btn} ${styles.btnPresent}`} disabled={busy} onClick={() => amend(s.staffId, 'SET_PRESENT')}>
                            Present
                          </button>
                        )}
                        <button className={`${styles.btn} ${styles.btnAbsent}`} disabled={busy} onClick={() => amend(s.staffId, 'SET_ABSENT')}>
                          Absent
                        </button>
                        <button className={`${styles.btn} ${styles.btnLeave}`} disabled={busy} onClick={() => amend(s.staffId, 'SET_ON_LEAVE')}>
                          Leave
                        </button>
                        <button className={`${styles.btn} ${styles.btnHalf}`} disabled={busy} onClick={() => amend(s.staffId, 'SET_HALF_DAY')}>
                          Half
                        </button>
                        <button className={`${styles.btn} ${styles.btnClear}`} disabled={busy} onClick={() => amend(s.staffId, 'CLEAR')}>
                          <span className="icon">restart_alt</span> Clear
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {toast && (
          <div className="animate-slideUp" style={{ position: 'fixed', bottom: 32, right: 32, zIndex: 100, background: '#1A1C2E', color: 'white', padding: '16px 24px', borderRadius: 12, boxShadow: '0 20px 25px -5px rgba(0,0,0,0.1)', display: 'flex', alignItems: 'center', gap: 12, border: '1px solid rgba(255,255,255,0.1)' }}>
            <div style={{ background: '#10B981', borderRadius: '50%', padding: 4, display: 'flex' }}>
              <span className="icon" style={{ fontSize: 18 }}>check</span>
            </div>
            {toast}
          </div>
        )}
      </div>
    </>
  );
}
