import Link from 'next/link';

export const metadata = {
  title: 'Changelog — EduCore ERP',
  description: 'What shipped, what changed, and incident notes.',
};

// §13.4.3: "Status page, changelog, in-app release notes." This page is the
// human-readable release feed; entries below are the deployment-facing
// summary of the repo's tagged releases. Add a new entry per release — most
// recent first. Keep incident notes honest: what happened, what we changed.
const ENTRIES = [
  {
    date: 'September 2026',
    tag: 'Release 12',
    title: 'Security hardening & compliance',
    items: [
      'AES-256-GCM encryption at rest for guardian phone numbers (children’s contact data).',
      'Support grants: our staff access your data only via time-boxed, one-time-code, fully attributed sessions.',
      'Automated cross-tenant isolation tests now gate every release; two authorisation gaps found and closed.',
      'Responsible-disclosure policy and security.txt published.',
    ],
  },
  {
    date: 'September 2026',
    tag: 'Release 11',
    title: 'Operations & reliability',
    items: [
      'Prometheus metrics and structured request logs across every service.',
      'Public status page (this site’s /status) fed by live health probes.',
      'Alert rules with runbooks for payments, notifications, backups and more.',
      'Load-tested the three real spikes: morning attendance, fee-deadline day, result day.',
    ],
  },
  {
    date: 'September 2026',
    tag: 'Release 10',
    title: 'India compliance & board formats',
    items: [
      'DPDP Act 2023: verifiable parental consent, data export, and erasure request workflows.',
      'CBSE-style report cards and the five certificate documents schools issue most.',
      'Tax invoices with the Rule 46 anatomy, both GST splits.',
    ],
  },
  {
    date: 'September 2026',
    tag: 'Release 9',
    title: 'Parent & teacher mobile apps',
    items: [
      'Flutter apps for parents and teachers: fees, results, attendance, class chat, leave requests.',
      'Offline-first attendance for teachers in low-connectivity corridors.',
      'Push notifications with deep links into the app.',
    ],
  },
];

export default function ChangelogPage() {
  return (
    <main style={{ maxWidth: 720, margin: '0 auto', padding: '48px 24px', color: '#e2e8f0' }}>
      <nav style={{ marginBottom: 40, display: 'flex', gap: 16, alignItems: 'center' }}>
        <Link href="/" style={{ color: '#7dd3fc', textDecoration: 'none', fontWeight: 600 }}>EduCore ERP</Link>
        <Link href="/pricing" style={{ color: '#94a3b8', textDecoration: 'none' }}>Pricing</Link>
        <Link href="/security" style={{ color: '#94a3b8', textDecoration: 'none' }}>Security</Link>
        <Link href="/status" style={{ color: '#94a3b8', textDecoration: 'none' }}>Status</Link>
      </nav>
      <h1 style={{ fontSize: 32, fontWeight: 700, marginBottom: 8 }}>Changelog</h1>
      <p style={{ color: '#94a3b8', marginBottom: 32 }}>
        What shipped, what changed, and honest incident notes. Schools deserve to see the product
        improving.
      </p>
      <div style={{ display: 'grid', gap: 24 }}>
        {ENTRIES.map((e) => (
          <article key={e.tag} style={{ border: '1px solid #334155', borderRadius: 12, padding: '20px 24px', background: '#0f172a' }}>
            <div style={{ display: 'flex', gap: 12, alignItems: 'baseline', marginBottom: 8 }}>
              <span style={{ background: '#1e293b', fontSize: 12, padding: '2px 10px', borderRadius: 999, color: '#7dd3fc' }}>{e.tag}</span>
              <h2 style={{ fontSize: 17, fontWeight: 600 }}>{e.title}</h2>
              <span style={{ color: '#64748b', fontSize: 13, marginLeft: 'auto' }}>{e.date}</span>
            </div>
            <ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 6 }}>
              {e.items.map((i) => (
                <li key={i.slice(0, 20)} style={{ color: '#94a3b8', fontSize: 14, lineHeight: 1.55 }}>{i}</li>
              ))}
            </ul>
          </article>
        ))}
      </div>
    </main>
  );
}
