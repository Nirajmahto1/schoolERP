'use client';
// ──────────────────────────────────────────────
// Bulk student import modal (Phase 8.5 — "a flagship feature, not a utility").
//
// The contract is the one §8.5 specifies, in order:
//   upload → column mapping (implicit: the backend's alias table, shown to
//   the user) → dry-run preview with per-row errors inline → commit.
//
// One endpoint, two modes, so the error report shown in preview is
// byte-identical to what commit will enforce — no "it passed preview but
// failed import" surprises. Only rows that validated get written on commit;
// existing admission numbers update instead of duplicating.
// ──────────────────────────────────────────────
import { useRef, useState } from 'react';
import { studentApi, type ImportReport } from '@/lib/api';

const REQUIRED_COLS = [
  'admissionNo', 'firstName', 'lastName', 'dateOfBirth', 'gender',
  'class', 'section', 'guardianName', 'guardianPhone',
];
const OPTIONAL_COLS = ['rollNo', 'bloodGroup', 'address', 'phone', 'previousSchool', 'guardianEmail'];
const GENDER_NOTE = 'gender: MALE / FEMALE / OTHER';

export default function ImportStudentsModal({
  open, onClose, onImported,
}: { open: boolean; onClose: () => void; onImported: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<'pick' | 'preview' | 'done'>('pick');
  const [report, setReport] = useState<ImportReport | null>(null);
  const [commitReport, setCommitReport] = useState<ImportReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (!open) return null;

  const reset = () => {
    setFile(null); setReport(null); setCommitReport(null);
    setPhase('pick'); setErr(null); setBusy(false);
    if (fileRef.current) fileRef.current.value = '';
  };
  const close = () => { reset(); onClose(); };

  const runPreview = async () => {
    if (!file) return;
    setBusy(true); setErr(null);
    try {
      const r = await studentApi.importStudents(file, 'dry-run');
      setReport(r);
      setPhase('preview');
    } catch (e: any) {
      setErr(e?.detail || e?.message || 'Could not read the file.');
    }
    setBusy(false);
  };

  const runCommit = async () => {
    if (!file) return;
    setBusy(true); setErr(null);
    try {
      const r = await studentApi.importStudents(file, 'commit');
      setCommitReport(r);
      setPhase('done');
      onImported();
    } catch (e: any) {
      setErr(e?.detail || e?.message || 'Commit failed.');
    }
    setBusy(false);
  };

  const summary = report?.summary;
  const badRows = report?.rows.filter((r) => !r.ok) ?? [];

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 60, display: 'grid', placeItems: 'center', background: 'rgba(2,6,23,0.55)', padding: 16 }} onClick={close}>
      <div onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Import students from Excel"
        style={{ background: '#fff', borderRadius: 16, width: 'min(760px, 100%)', maxHeight: '88vh', overflow: 'auto', padding: 24, boxShadow: '0 24px 64px rgba(2,6,23,0.35)' }}>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Import students from Excel</h3>
          <button onClick={close} aria-label="Close" style={{ border: 0, background: 'transparent', cursor: 'pointer', fontSize: 20, lineHeight: 1 }}>✕</button>
        </div>
        <p style={{ margin: '0 0 16px', color: '#64748B', fontSize: 13 }}>
          Upload the admission sheet, preview validation, then commit. Existing admission numbers are updated, not duplicated.
        </p>

        {phase === 'pick' && (
          <>
            <div style={{ border: '2px dashed #CBD5E1', borderRadius: 12, padding: 28, textAlign: 'center', background: '#F8FAFC' }}>
              <div style={{ fontSize: 30 }}>📄</div>
              <div style={{ fontWeight: 600, marginTop: 6 }}>Choose an .xlsx file</div>
              <div style={{ color: '#64748B', fontSize: 13, marginTop: 4 }}>First worksheet, header row. Column names are matched flexibly (e.g. “DOB”, “Admission No”, “Parent Name”).</div>
              <input
                ref={fileRef} type="file" accept=".xlsx,.xls" style={{ display: 'none' }}
                onChange={(e) => { setFile(e.target.files?.[0] ?? null); setErr(null); }}
              />
              <button className="btn btn-primary" style={{ marginTop: 14 }} onClick={() => fileRef.current?.click()}>
                <span className="icon icon-sm">upload_file</span> Select file
              </button>
              {file && <div style={{ marginTop: 10, fontSize: 13, color: '#0F172A' }}>{file.name} — {(file.size / 1024).toFixed(0)} KB</div>}
            </div>

            <details style={{ marginTop: 14, fontSize: 13, color: '#475569' }}>
              <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Required columns</summary>
              <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {REQUIRED_COLS.map((c) => <span key={c} style={{ background: '#EFF6FF', color: '#1D4ED8', borderRadius: 999, padding: '2px 10px', fontSize: 12 }}>{c}</span>)}
                <span style={{ fontSize: 12, alignSelf: 'center' }}>{GENDER_NOTE}</span>
              </div>
            </details>
            <details style={{ marginTop: 6, fontSize: 13, color: '#475569' }}>
              <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Optional columns</summary>
              <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {OPTIONAL_COLS.map((c) => <span key={c} style={{ background: '#F1F5F9', color: '#475569', borderRadius: 999, padding: '2px 10px', fontSize: 12 }}>{c}</span>)}
              </div>
            </details>

            {err && <div style={{ marginTop: 12, background: '#FEF2F2', border: '1px solid #FECACA', color: '#991B1B', borderRadius: 10, padding: '10px 14px', fontSize: 13 }}>{err}</div>}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
              <button className="btn btn-secondary" onClick={close}>Cancel</button>
              <button className="btn btn-primary" disabled={!file || busy} onClick={runPreview}>
                <span className="icon icon-sm">{busy ? 'hourglass_empty' : 'plagiarism'}</span>
                {busy ? 'Validating…' : 'Validate & preview'}
              </button>
            </div>
          </>
        )}

        {phase === 'preview' && report && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 14 }}>
              {[['Total rows', summary!.total, '#0F172A'], ['Ready', summary!.valid, '#059669'], ['With errors', summary!.invalid, '#DC2626']].map(([l, v, c]) => (
                <div key={String(l)} style={{ border: '1px solid #E2E8F0', borderRadius: 12, padding: '12px 14px' }}>
                  <div style={{ fontSize: 12, color: '#64748B' }}>{l}</div>
                  <div style={{ fontSize: 22, fontWeight: 700, color: String(c) }}>{v as number}</div>
                </div>
              ))}
            </div>

            {badRows.length > 0 && (
              <div style={{ border: '1px solid #FECACA', background: '#FFF7F7', borderRadius: 12, maxHeight: 260, overflow: 'auto' }}>
                <div style={{ position: 'sticky', top: 0, background: '#FFF7F7', padding: '10px 14px', fontWeight: 600, fontSize: 13, color: '#991B1B', borderBottom: '1px solid #FECACA' }}>
                  Fix these rows in the file, re-upload to re-validate
                </div>
                {badRows.map((r) => (
                  <div key={r.row} style={{ padding: '10px 14px', borderBottom: '1px solid #FEE2E2', fontSize: 13 }}>
                    <div style={{ fontWeight: 600 }}>Row {r.row}{r.admissionNo ? ` — ${r.admissionNo}` : ''}</div>
                    {r.errors.map((e, i) => (
                      <div key={i} style={{ color: '#B91C1C' }}>{e.field ? `${e.field}: ` : ''}{e.message}</div>
                    ))}
                  </div>
                ))}
              </div>
            )}

            {err && <div style={{ marginTop: 12, background: '#FEF2F2', border: '1px solid #FECACA', color: '#991B1B', borderRadius: 10, padding: '10px 14px', fontSize: 13 }}>{err}</div>}

            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 18 }}>
              <button className="btn btn-secondary" onClick={reset}>← Choose another file</button>
              <button className="btn btn-success" disabled={summary!.valid === 0 || busy} onClick={runCommit}>
                <span className="icon icon-sm">{busy ? 'hourglass_empty' : 'check_circle'}</span>
                {busy ? 'Importing…' : `Import ${summary!.valid} student${summary!.valid === 1 ? '' : 's'}`}
              </button>
            </div>
          </>
        )}

        {phase === 'done' && commitReport && (
          <div style={{ textAlign: 'center', padding: '18px 4px' }}>
            <div style={{ fontSize: 40 }}>{commitReport.failed?.length ? '⚠️' : '✅'}</div>
            <div style={{ fontSize: 17, fontWeight: 700, marginTop: 6 }}>
              {commitReport.committed?.length ?? 0} imported, {commitReport.failed?.length ?? 0} failed
            </div>
            {!!commitReport.failed?.length && (
              <div style={{ marginTop: 14, textAlign: 'left', background: '#FFF7F7', border: '1px solid #FECACA', borderRadius: 12, maxHeight: 220, overflow: 'auto', fontSize: 13 }}>
                {commitReport.failed.map((f) => (
                  <div key={f.row} style={{ padding: '8px 14px', borderBottom: '1px solid #FEE2E2', color: '#B91C1C' }}>
                    Row {f.row}{f.admissionNo ? ` — ${f.admissionNo}` : ''}: {f.message}
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginTop: 18 }}>
              <button className="btn btn-secondary" onClick={reset}>Import another file</button>
              <button className="btn btn-primary" onClick={close}>Done</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
