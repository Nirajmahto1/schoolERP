"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function GrantForm({ tenantId }: { tenantId: string }) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [hours, setHours] = useState("24");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The one-time code is shown exactly once, in this state — it exists
  // nowhere else (not the DB, not a log) after this response.
  const [code, setCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setCode(null);
    try {
      const res = await fetch(`/api/tenants/${tenantId}/support-grant`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason, hours: Number(hours) }),
      });
      const body = (await res.json().catch(() => null)) as { detail?: string; code?: string } | null;
      if (!res.ok) {
        setError(body?.detail ?? "Could not create grant.");
      } else {
        setReason("");
        setCode(body?.code ?? null);
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  async function copyCode() {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard permission denied — the code is still selectable on screen.
    }
  }

  return (
    <div className="space-y-3">
      {code && (
        <div className="rounded-lg border border-amber-700/60 bg-amber-950/40 p-3 text-sm">
          <p className="font-medium text-amber-300 mb-1">
            One-time activation code — shown once, copy it now:
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 break-all rounded bg-slate-950 px-2 py-1.5 font-mono text-xs text-emerald-300 select-all">
              {code}
            </code>
            <button
              type="button"
              onClick={copyCode}
              className="rounded bg-slate-700 hover:bg-slate-600 px-2 py-1.5 text-xs"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="mt-2 text-xs text-slate-400">
            Redeem with <code className="text-slate-300">POST /api/v1/auth/support/activate {"{ code }"}</code> through
            the gateway. The code is stored only as a SHA-256 hash — losing it means creating a new grant.
          </p>
        </div>
      )}
      <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
        <label className="block text-sm flex-1 min-w-56">
          <span className="text-slate-400">Reason (surfaced to the school)</span>
          <input
            required
            placeholder="Investigating fee reconciliation discrepancy"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-slate-500"
          />
        </label>
        <label className="block text-sm">
          <span className="text-slate-400">Expires in</span>
          <select
            value={hours}
            onChange={(e) => setHours(e.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-slate-500"
          >
            <option value="1">1 hour</option>
            <option value="6">6 hours</option>
            <option value="24">24 hours</option>
            <option value="72">72 hours</option>
          </select>
        </label>
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-sky-600 hover:bg-sky-500 disabled:opacity-50 px-4 py-2 text-sm font-medium"
        >
          {busy ? "Granting…" : "Grant access"}
        </button>
        {error && <p className="text-xs text-red-400 w-full">{error}</p>}
      </form>
    </div>
  );
}
