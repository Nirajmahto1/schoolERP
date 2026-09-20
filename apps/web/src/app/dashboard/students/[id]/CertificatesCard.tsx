'use client';
// ──────────────────────────────────────────────
// Certificates card (BUILD_PLAN 10.3 #4) — "small feature, constant demand".
//
// The PDF is a SNAPSHOT: everything it prints was captured at issue time, so
// re-downloading years later stays byte-identical even after the record is
// edited or erased. The list + download ride the same auth-gated fetch as
// photos; the issue form exposes only the optional board-wording extras.
// ──────────────────────────────────────────────
import { useCallback, useEffect, useState } from 'react';
import { certificateApi, fetchAuthBlob, type CertType } from '@/lib/api';
import { useT } from '@/lib/i18n';

const CERT_TYPES: Array<{ value: CertType; label: string; icon: string; blurb: string }> = [
  { value: 'BONAFIDE', label: 'Bonafide Certificate', icon: 'verified', blurb: 'Proof of study at the school' },
  { value: 'CHARACTER', label: 'Character Certificate', icon: 'psychology', blurb: 'Conduct record on leaving' },
  { value: 'FEE_CERTIFICATE', label: 'Fee Certificate', icon: 'receipt_long', blurb: 'Money paid vs outstanding, snapshotted now' },
  { value: 'ID_CARD', label: 'Identity Card', icon: 'badge', blurb: 'Student ID with photo placeholder' },
  { value: 'ADMIT_CARD', label: 'Admit Card', icon: 'assignment', blurb: 'Latest exam schedule with seat timings' },
];

export default function CertificatesCard({ studentId, studentName }: { studentId: string; studentName: string }) {
  const t = useT();
  const [certs, setCerts] = useState<Array<{ id: string; title: string; certNo: string; issueDate: string; purpose: string | null; type: string }>>([]);
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<CertType>('BONAFIDE');
  const [purpose, setPurpose] = useState('');
  const [extras, setExtras] = useState<{ category: string; firstAdmission: string; lastExam: string; conduct: string; remarks: string }>({ category: '', firstAdmission: '', lastExam: '', conduct: '', remarks: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await certificateApi.list(studentId);
      setCerts(r.data);
    } catch { setErr(t('certificates.errorLoad')); }
  }, [studentId]);

  useEffect(() => { load(); }, [load]);

  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(null), 2600); };

  const issue = async () => {
    setBusy(true); setErr(null);
    try {
      const body: Record<string, string> = { type };
      if (purpose.trim()) body.purpose = purpose.trim();
      if (type === 'BONAFIDE' || type === 'CHARACTER') {
        for (const k of ['category', 'firstAdmission', 'lastExam', 'conduct', 'remarks'] as const) {
          if (extras[k].trim()) body[k] = extras[k].trim();
        }
      }
      const created = await certificateApi.issue(studentId, body as never);
      setOpen(false); setPurpose(''); setExtras({ category: '', firstAdmission: '', lastExam: '', conduct: '', remarks: '' });
      await load();
      const blobUrl = await certificateApi.downloadPdf(studentId, created.id);
      if (blobUrl) {
        const a = document.createElement('a');
        a.href = blobUrl; a.download = `${type}-${created.certNo.replace(/[/\\]/g, '-')}.pdf`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(blobUrl), 4000);
      }
      flash(t('certificates.issuedToast').replace('{certNo}', created.certNo));
    } catch (e: any) {
      setErr(e?.detail || e?.message || t('certificates.errorIssue'));
    }
    setBusy(false);
  };

  const download = async (c: { id: string; type: string; certNo: string }) => {
    setBusy(true); setErr(null);
    try {
      const blobUrl = await fetchAuthBlob(`/students/${studentId}/certificates/${c.id}/pdf`);
      if (!blobUrl) throw new Error('Download failed.');
      const a = document.createElement('a');
      a.href = blobUrl; a.download = `${c.type}-${c.certNo.replace(/[/\\]/g, '-')}.pdf`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 4000);
    } catch (e: any) {
      setErr(e?.detail || e?.message || t('certificates.errorDownload'));
    }
    setBusy(false);
  };

  return (
    <div className="card" style={{ minWidth: 300 }}>
      <div className="card-body">
        <div className="flex items-center justify-between mb-4">
          <h3 className="m-0" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="icon" style={{ color: '#5048E5' }}>workspace_premium</span>{t('certificates.title')}
          </h3>
          <button className="btn btn-sm btn-primary" onClick={() => setOpen(!open)} disabled={busy}>
            <span className="icon icon-sm">{open ? 'close' : 'add'}</span>{open ? t('certificates.cancel') : t('certificates.issue')}
          </button>
        </div>

        {toast && <div style={{ marginBottom: 10, background: '#ECFDF5', border: '1px solid #A7F3D0', color: '#065F46', borderRadius: 10, padding: '8px 12px', fontSize: 13 }}>{toast}</div>}
        {err && <div style={{ marginBottom: 10, background: '#FEF2F2', border: '1px solid #FECACA', color: '#991B1B', borderRadius: 10, padding: '8px 12px', fontSize: 13 }}>{err}</div>}

        {open && (
          <div style={{ border: '1px solid #E2E8F0', borderRadius: 12, padding: 14, marginBottom: 12 }}>
            <div style={{ display: 'grid', gap: 8 }}>
              {CERT_TYPES.map((t) => (
                <label key={t.value} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer', padding: 8, borderRadius: 10, background: type === t.value ? '#EEF2FF' : 'transparent', border: `1px solid ${type === t.value ? '#C7D2FE' : 'transparent'}` }}>
                  <input type="radio" name="certType" checked={type === t.value} onChange={() => setType(t.value)} style={{ marginTop: 3 }} />
                  <span>
                    <span style={{ fontWeight: 600, fontSize: 14, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span className="icon icon-sm" style={{ color: '#5048E5' }}>{t.icon}</span>{t.label}
                    </span>
                    <span style={{ display: 'block', fontSize: 12, color: '#64748B' }}>{t.blurb}</span>
                  </span>
                </label>
              ))}
            </div>
            <div className="input-group" style={{ marginTop: 10 }}>
              <label className="input-label">{t('certificates.purpose')}</label>
              <input className="input" placeholder={t('certificates.purposePlaceholder')} value={purpose} onChange={(e) => setPurpose(e.target.value)} maxLength={300} />
            </div>
            {(type === 'BONAFIDE' || type === 'CHARACTER') && (
              <div className="grid grid-2 gap-3" style={{ marginTop: 8 }}>
                <div className="input-group"><label className="input-label">{t('certificates.category')}</label><input className="input" value={extras.category} onChange={(e) => setExtras({ ...extras, category: e.target.value })} /></div>
                <div className="input-group"><label className="input-label">{t('certificates.firstAdmission')}</label><input className="input" value={extras.firstAdmission} onChange={(e) => setExtras({ ...extras, firstAdmission: e.target.value })} /></div>
                <div className="input-group"><label className="input-label">{t('certificates.lastExam')}</label><input className="input" value={extras.lastExam} onChange={(e) => setExtras({ ...extras, lastExam: e.target.value })} /></div>
                <div className="input-group"><label className="input-label">{t('certificates.conduct')}</label><input className="input" value={extras.conduct} onChange={(e) => setExtras({ ...extras, conduct: e.target.value })} /></div>
                <div className="input-group" style={{ gridColumn: 'span 2' }}><label className="input-label">{t('certificates.remarks')}</label><input className="input" value={extras.remarks} onChange={(e) => setExtras({ ...extras, remarks: e.target.value })} /></div>
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
              <button className="btn btn-primary" onClick={issue} disabled={busy}>
                <span className="icon icon-sm">{busy ? 'hourglass_empty' : 'workspace_premium'}</span>
                {busy ? t('certificates.issuing') : `${t('certificates.issueFor')} ${studentName.split(' ')[0]}`}
              </button>
            </div>
          </div>
        )}

        {certs.length === 0 && !open && (
          <p style={{ margin: 0, fontSize: 13, color: '#64748B' }}>
            {t('certificates.empty')}
          </p>
        )}

        {certs.length > 0 && (
          <div style={{ display: 'grid', gap: 8 }}>
            {certs.map((c) => (
              <div key={c.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, border: '1px solid #E2E8F0', borderRadius: 10, padding: '10px 12px' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{c.title}</div>
                  <div style={{ fontSize: 12, color: '#64748B' }}>
                    {c.certNo} • {new Date(c.issueDate).toLocaleDateString('en-IN')}{c.purpose ? ` • ${c.purpose}` : ''}
                  </div>
                </div>
                <button className="btn btn-sm btn-secondary" onClick={() => download(c)} disabled={busy} title="Download PDF">
                  <span className="icon icon-sm">download</span>{t('certificates.download')}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
