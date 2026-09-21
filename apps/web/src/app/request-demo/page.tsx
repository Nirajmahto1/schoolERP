'use client';

import Link from 'next/link';
import { useState } from 'react';

// §13.2.5: "Website with pricing, security page, and a request-demo form."
// The POST endpoint persists a DemoLead in the control plane — the console's
// home screen surfaces new leads so follow-up is someone's job, not luck.
export default function RequestDemoPage() {
  const [form, setForm] = useState({ school: '', name: '', email: '', phone: '', city: '', students: '', notes: '' });
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set(k: keyof typeof form) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
      setForm((f) => ({ ...f, [k]: e.target.value }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/v1/public/demo-lead', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { detail?: string } | null;
        setError(body?.detail ?? 'Could not submit. Please email us instead.');
        return;
      }
      setDone(true);
    } finally {
      setBusy(false);
    }
  }

  const input = {
    width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid #334155',
    background: '#0f172a', color: '#e2e8f0', fontSize: 14,
  } as const;

  return (
    <main style={{ maxWidth: 640, margin: '0 auto', padding: '48px 24px', color: '#e2e8f0' }}>
      <nav style={{ marginBottom: 40, display: 'flex', gap: 16, alignItems: 'center' }}>
        <Link href="/" style={{ color: '#7dd3fc', textDecoration: 'none', fontWeight: 600 }}>EduCore ERP</Link>
        <Link href="/pricing" style={{ color: '#94a3b8', textDecoration: 'none' }}>Pricing</Link>
        <Link href="/security" style={{ color: '#94a3b8', textDecoration: 'none' }}>Security</Link>
      </nav>
      <h1 style={{ fontSize: 32, fontWeight: 700, marginBottom: 8 }}>See EduCore on your school’s data</h1>
      <p style={{ color: '#94a3b8', marginBottom: 32 }}>
        20 minutes, on a call or at your campus. We will show attendance, fee collection, report
        cards and the parent app — no slideware.
      </p>
      {done ? (
        <div style={{ border: '1px solid #10b981', borderRadius: 12, padding: 24, background: '#0f172a' }}>
          <p style={{ fontWeight: 600, color: '#34d399' }}>Thank you — request received.</p>
          <p style={{ color: '#94a3b8', fontSize: 14, marginTop: 8 }}>
            We will reach out within one business day to schedule. Bring your questions about data
            migration: that is the part we take seriously.
          </p>
        </div>
      ) : (
        <form onSubmit={submit} style={{ display: 'grid', gap: 14 }}>
          <label style={{ display: 'grid', gap: 4, fontSize: 14 }}>
            School name *
            <input required value={form.school} onChange={set('school')} style={input} />
          </label>
          <label style={{ display: 'grid', gap: 4, fontSize: 14 }}>
            Your name *
            <input required value={form.name} onChange={set('name')} style={input} />
          </label>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <label style={{ display: 'grid', gap: 4, fontSize: 14 }}>
              Email *
              <input required type="email" value={form.email} onChange={set('email')} style={input} />
            </label>
            <label style={{ display: 'grid', gap: 4, fontSize: 14 }}>
              Phone (WhatsApp preferred) *
              <input required value={form.phone} onChange={set('phone')} style={input} />
            </label>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <label style={{ display: 'grid', gap: 4, fontSize: 14 }}>
              City
              <input value={form.city} onChange={set('city')} style={input} />
            </label>
            <label style={{ display: 'grid', gap: 4, fontSize: 14 }}>
              Students
              <select value={form.students} onChange={set('students')} style={input}>
                <option value="">Select…</option>
                <option value="<300">Under 300</option>
                <option value="300-800">300 – 800</option>
                <option value="800-2000">800 – 2,000</option>
                <option value=">2000">Over 2,000</option>
                <option value="multi-branch">Multi-branch group</option>
              </select>
            </label>
          </div>
          <label style={{ display: 'grid', gap: 4, fontSize: 14 }}>
            What are you using today? What hurts?
            <textarea rows={3} value={form.notes} onChange={set('notes')} style={input} />
          </label>
          {error && <p style={{ color: '#f87171', fontSize: 13 }}>{error}</p>}
          <button
            type="submit"
            disabled={busy}
            style={{ background: '#0ea5e9', color: 'white', fontWeight: 600, padding: '12px 20px', borderRadius: 10, border: 'none', fontSize: 15, opacity: busy ? 0.6 : 1 }}
          >
            {busy ? 'Sending…' : 'Request demo'}
          </button>
        </form>
      )}
    </main>
  );
}
