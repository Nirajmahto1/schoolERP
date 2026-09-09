"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function GrantForm({ tenantId }: { tenantId: string }) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [hours, setHours] = useState("24");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/tenants/${tenantId}/support-grant`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason, hours: Number(hours) }),
      });
      const body = (await res.json().catch(() => null)) as { detail?: string } | null;
      if (!res.ok) {
        setError(body?.detail ?? "Could not create grant.");
      } else {
        setReason("");
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
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
  );
}