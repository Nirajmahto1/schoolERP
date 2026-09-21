"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Revokes a support grant mid-window. The school can demand this — it must
 * be one click, not a support ticket back to us. Revocation takes effect on
 * the next refresh (live access tokens die within their 15-minute TTL).
 */
export default function RevokeButton({ tenantId, grantId }: { tenantId: string; grantId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function revoke() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/tenants/${tenantId}/support-grant?grantId=${encodeURIComponent(grantId)}`, {
        method: "DELETE",
      });
      const body = (await res.json().catch(() => null)) as { detail?: string } | null;
      if (!res.ok) {
        setError(body?.detail ?? "Could not revoke.");
      } else {
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        onClick={revoke}
        disabled={busy}
        className="rounded bg-red-900/60 hover:bg-red-800 disabled:opacity-50 px-2 py-0.5 text-xs text-red-200"
      >
        {busy ? "Revoking…" : "Revoke"}
      </button>
      {error && <span className="text-xs text-red-400">{error}</span>}
    </span>
  );
}
