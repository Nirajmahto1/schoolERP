import Link from 'next/link';

export const metadata = {
  title: 'Pricing — EduCore ERP',
  description: 'Simple per-student pricing for Indian schools. No per-feature upsells.',
};

// §13.1: "Per student per year is the dominant model… ₹150–₹600/student/year
// depending on modules, with volume tiers; premium for mobile app
// white-labelling." Messaging passed through as credits; onboarding is a
// one-time fee. These numbers are the public shape — edit per deployment.
const TIERS = [
  {
    name: 'Essential',
    price: '₹150',
    unit: 'per student / year',
    blurb: 'Attendance, fees, report cards, parent app. The modules every school needs on day one.',
    features: ['Unlimited branches within one school', 'Attendance + fee collection + receipts', 'CBSE-style report cards', 'Parent & teacher mobile apps', 'WhatsApp/SMS notifications (credits)', 'Email support, next-business-day'],
    cta: 'Request a demo',
    highlight: false,
  },
  {
    name: 'Standard',
    price: '₹300',
    unit: 'per student / year',
    blurb: 'Everything in Essential plus timetable, HR/payroll and analytics — the full academic office.',
    features: ['Everything in Essential', 'Timetable builder with constraint solver', 'Staff & HR with leave management', 'Dashboards & at-risk analytics', 'Library, transport, communication', 'Priority WhatsApp support line'],
    cta: 'Request a demo',
    highlight: true,
  },
  {
    name: 'Premium',
    price: '₹500',
    unit: 'per student / year',
    blurb: 'Multi-branch consolidated analytics, white-labelled apps, and a named onboarding engineer.',
    features: ['Everything in Standard', 'Multi-branch consolidated analytics', 'White-labelled mobile apps', 'Biometric device integration', 'Data migration done with you', 'Named onboarding engineer + SLA'],
    cta: 'Request a demo',
    highlight: false,
  },
];

export default function PricingPage() {
  return (
    <main style={{ maxWidth: 1080, margin: '0 auto', padding: '48px 24px', color: '#e2e8f0' }}>
      <nav style={{ marginBottom: 40, display: 'flex', gap: 16, alignItems: 'center' }}>
        <Link href="/" style={{ color: '#7dd3fc', textDecoration: 'none', fontWeight: 600 }}>EduCore ERP</Link>
        <Link href="/security" style={{ color: '#94a3b8', textDecoration: 'none' }}>Security</Link>
        <Link href="/status" style={{ color: '#94a3b8', textDecoration: 'none' }}>Status</Link>
      </nav>
      <h1 style={{ fontSize: 36, fontWeight: 700, marginBottom: 8 }}>Pricing that fits how Indian schools buy</h1>
      <p style={{ color: '#94a3b8', maxWidth: 720, marginBottom: 40 }}>
        Per student, per year. Volume tiers for large schools. Messaging (WhatsApp/SMS) is passed
        through as credits — you only pay for what your parents actually receive. One-time
        onboarding, data-migration and training fee is quoted per school and covers real work:
        we import your data and train your staff.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 20 }}>
        {TIERS.map((t) => (
          <div
            key={t.name}
            style={{
              border: t.highlight ? '2px solid #0ea5e9' : '1px solid #334155',
              borderRadius: 14,
              padding: 24,
              background: '#0f172a',
              position: 'relative',
            }}
          >
            {t.highlight && (
              <span style={{ position: 'absolute', top: -12, left: 24, background: '#0ea5e9', color: 'white', fontSize: 12, padding: '2px 10px', borderRadius: 999 }}>
                Most schools pick this
              </span>
            )}
            <h2 style={{ fontSize: 20, fontWeight: 600 }}>{t.name}</h2>
            <p style={{ fontSize: 34, fontWeight: 700, margin: '12px 0 2px' }}>{t.price}</p>
            <p style={{ color: '#64748b', fontSize: 13, marginBottom: 12 }}>{t.unit}</p>
            <p style={{ color: '#94a3b8', fontSize: 14, marginBottom: 16 }}>{t.blurb}</p>
            <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 24px', display: 'grid', gap: 8 }}>
              {t.features.map((f) => (
                <li key={f} style={{ fontSize: 14, color: '#cbd5e1' }}>✓ {f}</li>
              ))}
            </ul>
            <Link
              href="/request-demo"
              style={{
                display: 'block', textAlign: 'center', textDecoration: 'none',
                background: t.highlight ? '#0ea5e9' : '#1e293b', color: 'white',
                padding: '10px 16px', borderRadius: 10, fontWeight: 600, fontSize: 14,
              }}
            >
              {t.cta}
            </Link>
          </div>
        ))}
      </div>
      <p style={{ color: '#64748b', fontSize: 13, marginTop: 40 }}>
        Payment-gateway charges on online fee collection are borne by the parent as a disclosed
        convenience fee by default; schools may absorb them — decided in your contract.
        Annual contracts billed up front, aligned to the April academic year.
      </p>
    </main>
  );
}
