"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

interface ProvisionResult {
  tenantId: string;
  slug: string;
  database: string;
  schemaVersion: number;
  adminUserId: string | null;
  setupUrl: string | null;
  roleName: string | null;
  indexedUsers: number;
  alreadyProvisioned: boolean;
}

export default function ProvisionForm() {
  const router = useRouter();
  const [slug, setSlug] = useState("");
  const [legalName, setLegalName] = useState("");
  const [planCode, setPlanCode] = useState("");
  const [trialDays, setTrialDays] = useState("30");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ProvisionResult | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/provision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug,
          legalName,
          planCode: planCode || undefined,
          trialDays: trialDays ? Number(trialDays) : undefined,
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError((body as { detail?: string } | null)?.detail ?? "Provisioning failed.");
      } else {
        setResult(body as ProvisionResult);
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <form
        onSubmit={submit}
        className="space-y-4 rounded-xl border border-slate-800 bg-slate-900 p-6"
      >
        <label className="block text-sm">
          <span className="text-slate-400">Subdomain slug</span>
          <input
            required
            pattern="[a-z0-9]+(-[a-z0-9]+)*"
            placeholder="dps-noida"
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase())}
            className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono outline-none focus:border-slate-500"
          />
          <span className="text-xs text-slate-500">{slug || "school"}.yourapp.in</span>
        </label>

        <label className="block text-sm">
          <span className="text-slate-400">Legal name</span>
          <input
            required
            placeholder="Delhi Public School, Noida"
            value={legalName}
            onChange={(e) => setLegalName(e.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 outline-none focus:border-slate-500"
          />
        </label>

        <div className="grid grid-cols-2 gap-4">
          <label className="block text-sm">
            <span className="text-slate-400">Plan code (optional)</span>
            <input
              placeholder="standard"
              value={planCode}
              onChange={(e) => setPlanCode(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 outline-none focus:border-slate-500"
            />
          </label>
          <label className="block text-sm">
            <span className="text-slate-400">Trial days</span>
            <input
              type="number"
              min={0}
              max={180}
              value={trialDays}
              onChange={(e) => setTrialDays(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 outline-none focus:border-slate-500"
            />
          </label>
        </div>

        {error && (
          <p className="rounded-lg bg-red-950 border border-red-800 text-red-300 text-sm px-3 py-2">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-sky-600 hover:bg-sky-500 disabled:opacity-50 px-4 py-2 text-sm font-medium"
        >
          {busy ? "Provisioning…" : "Provision school"}
        </button>
      </form>

      {result && (
        <section className="space-y-3 rounded-xl border border-emerald-900 bg-emerald-950/40 p-6 text-sm">
          <h2 className="font-medium text-emerald-300">
            {result.alreadyProvisioned ? "Already provisioned" : "School provisioned"}
          </h2>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-xs text-slate-300">
            <dt className="text-slate-500">tenant</dt>
            <dd>{result.tenantId}</dd>
            <dt className="text-slate-500">database</dt>
            <dd>{result.database}</dd>
            <dt className="text-slate-500">role</dt>
            <dd>{result.roleName ?? "—"}</dd>
            <dt className="text-slate-500">schema</dt>
            <dd>v{result.schemaVersion}</dd>
            <dt className="text-slate-500">directory</dt>
            <dd>{result.indexedUsers} users indexed</dd>
          </dl>
          {result.setupUrl && (
            <p className="rounded-lg bg-slate-950 border border-slate-800 p-3">
              <span className="block text-xs text-slate-500 mb-1">
                One-time first-admin setup link — share securely, it replaces the password:
              </span>
              <code className="break-all text-emerald-300">{result.setupUrl}</code>
            </p>
          )}
        </section>
      )}
    </div>
  );
}
