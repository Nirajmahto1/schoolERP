"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

interface InvoicePaidButtonProps {
  tenantId: string;
  invoiceId: string;
  invoiceNo: string;
}

/**
 * Mark an issued tax invoice as paid (bank transfer / cheque verified
 * offline — the gateway marks PAID itself for online payments). Audited
 * server-side with the console actor's identity.
 */
export default function InvoicePaidButton({ tenantId, invoiceId, invoiceNo }: InvoicePaidButtonProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function markPaid() {
    if (!window.confirm(`Mark ${invoiceNo} as PAID? Record this only after the money is verified in the bank.`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/tenants/${tenantId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "invoice-paid", invoiceId }),
      });
      const body = (await res.json().catch(() => null)) as { detail?: string } | null;
      if (!res.ok) setError(body?.detail ?? "Failed to mark paid.");
      else router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-col items-end">
      <button
        onClick={() => void markPaid()}
        disabled={busy}
        className="text-xs text-emerald-400 hover:text-emerald-300 disabled:opacity-50"
      >
        {busy ? "…" : "Mark paid"}
      </button>
      {error && <span className="text-xs text-red-400">{error}</span>}
    </span>
  );
}
