'use client';
// ──────────────────────────────────────────────
// Government Exports page (BUILD_PLAN 10.2)
//
// The three exports a school coordinator files every year, generated from
// live tenant data: UDISE+ annual return, RTE 25% quota report, and the
// CBSE LOC (needs an exam for subject columns). Also the APAAR/RTE
// identifier editor for a student.
// ──────────────────────────────────────────────
import Topbar from '@/components/Topbar';
import { useEffect, useState } from 'react';
import { yearApi, examApi, governmentApi } from '@/lib/api';
import { useT } from '@/lib/i18n';

function downloadBlobUrl(blobUrl: string, filename: string) {
  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 4000);
}

export default function GovernmentPage() {
  const t = useT();
  const [years, setYears] = useState<Array<{ id: string; name: string; isCurrent: boolean }>>([]);
  const [yearId, setYearId] = useState('');
  const [exams, setExams] = useState<Array<{ id: string; name: string }>>([]);
  const [examId, setExamId] = useState('');
  const [apaarStudent, setApaarStudent] = useState('');
  const [apaarValue, setApaarValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(null), 2800); };

  useEffect(() => {
    (async () => {
      try {
        const y = await yearApi.list();
        const rows: Array<{ id: string; name: string; isCurrent: boolean }> = y.data ?? [];
        setYears(rows);
        setYearId(rows.find((r) => r.isCurrent)?.id ?? rows[0]?.id ?? '');
        const ex = await examApi.list();
        const examRows: Array<{ id: string; name: string }> = ex.data ?? [];
        setExams(examRows);
        setExamId(examRows[0]?.id ?? '');
      } catch {
        setErr('Could not load academic years or exams.');
      }
    })();
  }, []);

  const run = async (fn: () => Promise<string | null>, filename: string, label: string) => {
    setBusy(true); setErr(null);
    try {
      const blobUrl = await fn();
      if (!blobUrl) throw new Error('Download failed.');
      downloadBlobUrl(blobUrl, filename);
      flash(`${label} downloaded.`);
    } catch (e: any) {
      setErr(e?.detail || e?.message || 'Export failed.');
    }
    setBusy(false);
  };

  const saveApaar = async () => {
    if (!apaarStudent.trim()) { setErr('Enter a student ID from the students page URL.'); return; }
    setBusy(true); setErr(null);
    try {
      await governmentApi.setGovtIds(apaarStudent.trim(), { apaarId: apaarValue.trim() || null });
      flash('APAAR ID saved.');
    } catch (e: any) {
      setErr(e?.detail || e?.message || 'Could not save the APAAR ID.');
    }
    setBusy(false);
  };

  return (
    <>
      <Topbar title={t('govt.title')} subtitle={t('govt.subtitle')} />
      <div className="page" style={{ padding: '24px 32px', maxWidth: 860 }}>
        {toast && <div style={{ background: '#ECFDF5', border: '1px solid #A7F3D0', color: '#065F46', borderRadius: 10, padding: '10px 14px', fontSize: 13 }}>{toast}</div>}
        {err && <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', color: '#991B1B', borderRadius: 10, padding: '10px 14px', fontSize: 13 }}>{err}</div>}

        <div className="card">
          <div className="card-body">
            <div className="flex items-center gap-2 mb-2">
              <span className="icon" style={{ color: '#5048E5' }}>account_balance</span>
              <h3 className="m-0">{t('govt.udiseTitle')}</h3>
            </div>
            <p style={{ margin: '0 0 14px', fontSize: 13, color: '#64748B' }}>{t('govt.udiseBlurb')}</p>
            <div className="flex gap-3 items-center flex-wrap">
              <select className="select" style={{ maxWidth: 260 }} value={yearId} onChange={(e) => setYearId(e.target.value)}>
                {years.map((y) => <option key={y.id} value={y.id}>{y.name}{y.isCurrent ? ` (${t('govt.current')})` : ''}</option>)}
              </select>
              <button className="btn btn-primary" disabled={busy}
                onClick={() => run(() => governmentApi.udiseExport(yearId || undefined), `udise-${new Date().toISOString().slice(0, 10)}.csv`, t('govt.udiseTitle'))}>
                <span className="icon icon-sm">{busy ? 'hourglass_empty' : 'download'}</span>{t('govt.downloadCsv')}
              </button>
              <button className="btn btn-secondary" disabled={busy}
                onClick={() => run(() => governmentApi.rteReport(yearId || undefined), `rte-report-${new Date().toISOString().slice(0, 10)}.csv`, t('govt.rteTitle'))}>
                <span className="icon icon-sm">download</span>{t('govt.rteTitle')}
              </button>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-body">
            <div className="flex items-center gap-2 mb-2">
              <span className="icon" style={{ color: '#5048E5' }}>fact_check</span>
              <h3 className="m-0">{t('govt.locTitle')}</h3>
            </div>
            <p style={{ margin: '0 0 14px', fontSize: 13, color: '#64748B' }}>{t('govt.locBlurb')}</p>
            {exams.length === 0 && <p style={{ fontSize: 13, color: '#94A3B8' }}>{t('govt.noExams')}</p>}
            <div className="flex gap-3 items-center flex-wrap">
              <select className="select" style={{ maxWidth: 300 }} value={examId} onChange={(e) => setExamId(e.target.value)}>
                {exams.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
              <button className="btn btn-primary" disabled={busy || !examId}
                onClick={() => run(() => governmentApi.locExport(examId), `loc-${examId.slice(0, 8)}.csv`, t('govt.locTitle'))}>
                <span className="icon icon-sm">download</span>{t('govt.downloadCsv')}
              </button>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-body">
            <div className="flex items-center gap-2 mb-2">
              <span className="icon" style={{ color: '#5048E5' }}>badge</span>
              <h3 className="m-0">{t('govt.apaarTitle')}</h3>
            </div>
            <p style={{ margin: '0 0 14px', fontSize: 13, color: '#64748B' }}>{t('govt.apaarBlurb')}</p>
            <div className="flex gap-3 items-center flex-wrap">
              <input className="input" style={{ maxWidth: 320 }} placeholder={t('govt.apaarStudentPlaceholder')} value={apaarStudent} onChange={(e) => setApaarStudent(e.target.value)} />
              <input className="input" style={{ maxWidth: 180 }} placeholder="123456789012" maxLength={12} value={apaarValue} onChange={(e) => setApaarValue(e.target.value.replace(/\D/g, ''))} />
              <button className="btn btn-secondary" disabled={busy} onClick={saveApaar}>
                <span className="icon icon-sm">save</span>{t('govt.save')}
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
