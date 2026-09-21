import Link from 'next/link';

export const metadata = {
  title: 'System Status — EduCore ERP',
  description: 'Live availability of EduCore services.',
};

export const dynamic = 'force-dynamic';

// §13.4.3: "Status page, changelog, in-app release notes." Reads the
// gateway's own /status aggregation — one source of truth, no scraper.
// Server-rendered, unauthenticated: parents and staff should be able to
// check "is it down?" without logging in.
const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api/v1';
const STATUS_URL = API_BASE.replace(/\/api\/v1\/?$/, '') + '/status';

interface ServiceStatus {
  service: string;
  status: string;
  latency_ms: number;
}

async function fetchStatus(): Promise<{ status: string; services: ServiceStatus[] } | null> {
  try {
    const res = await fetch(STATUS_URL, { cache: 'no-store', signal: AbortSignal.timeout(4000) });
    if (!res.ok && res.status !== 503) return null;
    return (await res.json()) as { status: string; services: ServiceStatus[] };
  } catch {
    return null;
  }
}

const DOT: Record<string, { color: string; label: string }> = {
  up: { color: '#10b981', label: 'Operational' },
  degraded: { color: '#f59e0b', label: 'Degraded' },
  down: { color: '#ef4444', label: 'Down' },
};

export default async function StatusPage() {
  const data = await fetchStatus();
  const overall = !data ? 'unknown' : data.status;
  const banner = {
    operational: { bg: '#064e3b', text: 'All systems operational', color: '#34d399' },
    'partial-outage': { bg: '#78350f', text: 'Partial outage — some services degraded', color: '#fbbf24' },
    'major-outage': { bg: '#7f1d1d', text: 'Major outage — we are on it', color: '#f87171' },
    unknown: { bg: '#1e293b', text: 'Status unavailable right now', color: '#94a3b8' },
  }[overall] ?? { bg: '#1e293b', text: 'Status unavailable', color: '#94a3b8' };

  return (
    <main style={{ maxWidth: 720, margin: '0 auto', padding: '48px 24px', color: '#e2e8f0' }}>
      <nav style={{ marginBottom: 40, display: 'flex', gap: 16, alignItems: 'center' }}>
        <Link href="/" style={{ color: '#7dd3fc', textDecoration: 'none', fontWeight: 600 }}>EduCore ERP</Link>
        <Link href="/pricing" style={{ color: '#94a3b8', textDecoration: 'none' }}>Pricing</Link>
        <Link href="/security" style={{ color: '#94a3b8', textDecoration: 'none' }}>Security</Link>
      </nav>
      <h1 style={{ fontSize: 32, fontWeight: 700, marginBottom: 24 }}>System status</h1>
      <div style={{ background: banner.bg, color: banner.color, borderRadius: 12, padding: '16px 20px', fontWeight: 600, marginBottom: 24 }}>
        {banner.text}
      </div>
      {!data ? (
        <p style={{ color: '#94a3b8' }}>
          The status feed could not be reached. If the platform is unreachable too, we are likely
          already aware — check the changelog for incident notes.
        </p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: 8 }}>
          {data.services.map((s) => {
            const dot = DOT[s.status] ?? DOT.down;
            return (
              <li
                key={s.service}
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', border: '1px solid #334155', borderRadius: 10, padding: '12px 16px', background: '#0f172a' }}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ width: 10, height: 10, borderRadius: 999, background: dot.color, display: 'inline-block' }} />
                  <span style={{ fontSize: 14 }}>{s.service}</span>
                </span>
                <span style={{ fontSize: 13, color: '#94a3b8' }}>
                  {dot.label} · {s.latency_ms} ms
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <p style={{ color: '#64748b', fontSize: 13, marginTop: 32 }}>
        Refreshed on every page load. Historical uptime and incident post-mortems live in the changelog.
      </p>
    </main>
  );
}
