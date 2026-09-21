import Link from 'next/link';

export const metadata = {
  title: 'Security — EduCore ERP',
  description: 'How EduCore protects school data: tenant isolation, encryption, DPDP compliance, and responsible disclosure.',
};

// §13.2.5: the security page schools' procurement teams ask for. Every claim
// here traces to code or a doc in the repo — see docs/security/ for the
// threat model and ASVS self-assessment, SECURITY.md for disclosure.
const SECTIONS = [
  {
    title: 'Your school’s data is isolated in its own database',
    body: [
      'Every school gets its own Postgres database — not a shared table with a "school_id" column. The platform’s control plane holds only a registry: your connection details are stored encrypted, never exposed through APIs.',
      'Isolation is enforced by automated cross-tenant tests that run on every code change, plus an internal ASVS Level 2 assessment.',
    ],
  },
  {
    title: 'Access by our staff is exceptional, time-boxed, and audited',
    body: [
      'We hold no standing access to your data. When support requires it, access is granted for a fixed window with a written reason, shown once as a one-time code, and every action is attributed in your school’s own audit trail. You can ask for a copy at any time, and revocation takes effect in minutes.',
    ],
  },
  {
    title: 'Sensitive fields are encrypted at rest',
    body: [
      'Guardian phone numbers — children’s contact data — are encrypted with AES-256-GCM at the application layer, above whatever the database already provides. Passwords are hashed with bcrypt. Internal service calls use short-lived RSA-256 signed assertions.',
    ],
  },
  {
    title: 'Built for India’s DPDP Act 2023',
    body: [
      'Verifiable parental consent per child and purpose, with a withdrawal path. Data-principal access and erasure rights implemented as product features. A rehearsed personal-data breach notification runbook with a T+24-hour fiduciary-notice clock.',
    ],
  },
  {
    title: 'Continuous security testing',
    body: [
      'Every commit runs secret scanning, dependency audits (npm + Go), vulnerability scanning of the Go services, and generates software bills of materials (SBOM). Cross-tenant isolation tests gate every merge.',
    ],
  },
  {
    title: 'Found something? Tell us.',
    body: [
      'Responsible disclosure with a 48-hour acknowledgement and safe harbour for good-faith research: see SECURITY.md in our public repository or the /.well-known/security.txt file on this domain.',
    ],
  },
];

export default function SecurityPage() {
  return (
    <main style={{ maxWidth: 800, margin: '0 auto', padding: '48px 24px', color: '#e2e8f0' }}>
      <nav style={{ marginBottom: 40, display: 'flex', gap: 16, alignItems: 'center' }}>
        <Link href="/" style={{ color: '#7dd3fc', textDecoration: 'none', fontWeight: 600 }}>EduCore ERP</Link>
        <Link href="/pricing" style={{ color: '#94a3b8', textDecoration: 'none' }}>Pricing</Link>
        <Link href="/status" style={{ color: '#94a3b8', textDecoration: 'none' }}>Status</Link>
      </nav>
      <h1 style={{ fontSize: 36, fontWeight: 700, marginBottom: 8 }}>Security</h1>
      <p style={{ color: '#94a3b8', marginBottom: 40 }}>
        Children’s data raises the stakes. Here is exactly how we protect it — written for
        principals and procurement teams, backed by documents our auditors can see.
      </p>
      <div style={{ display: 'grid', gap: 20 }}>
        {SECTIONS.map((s) => (
          <section key={s.title} style={{ border: '1px solid #334155', borderRadius: 12, padding: '20px 24px', background: '#0f172a' }}>
            <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>{s.title}</h2>
            {s.body.map((p) => (
              <p key={p.slice(0, 24)} style={{ color: '#94a3b8', fontSize: 14, lineHeight: 1.6, margin: '6px 0' }}>{p}</p>
            ))}
          </section>
        ))}
      </div>
    </main>
  );
}
