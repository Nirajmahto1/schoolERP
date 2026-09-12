"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Action = "convert-paid" | "renew";

interface BillingActionsProps {
  tenantId: string;
  status: string;
  currentPlanCode: string | null;
  suggestedSeats: number | null;
}

/**
 * Convert-to-paid / renew, right on the tenant page (BUILD_PLAN 4.2.2).
 * Both issue a Rule 46 tax invoice server-side; the success message carries
 * the invoice number and total so ops can verify without opening the CLI.
 */
export default function BillingActions({ tenantId, status, currentPlanCode, suggestedSeats }: BillingActionsProps) {
  const router = useRouter();
  const [busy, setBusy] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function run(action: Action, opts: { planCode?: string; seats?: number }) {
    setBusy(action);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(`/api/tenants/${tenantId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...opts }),
      });
      const body = (await res.json().catch(() => null)) as
        | { detail?: string; invoiceNo?: string; total?: number; amountInWords?: string }
        | null;
      if (!res.ok) {
        setError(body?.detail ?? "Action failed.");
      } else {
        setMessage(
          `Invoice ${body?.invoiceNo ?? "?"} issued · total ₹${body?.total?.toLocaleString("en-IN") ?? "?"} (${body?.amountInWords ?? ""}).`,
        );
      }
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  const disabled = busy !== null;

  return (
    <div className="flex flex-col items-start gap-2 border-t border-slate-800 pt-3">
      <div className="flex flex-wrap gap-2">
        {status === "TRIAL" && (
          <button
            onClick={() => {
              const planCode = window.prompt("Plan code to convert to:", currentPlanCode ?? "GROWTH");
              if (!planCode) return;
              const seats = Number(window.prompt("Seats (billable students):", String(suggestedSeats ?? "")));
              if (!Number.isFinite(seats) || seats <= 0) return;
              void run("convert-paid", { planCode: planCode.trim(), seats });
            }}
            disabled={disabled}
            className="rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 px-3 py-2 text-sm font-medium"
          >
            {busy === "convert-paid" ? "…" : "Convert to paid"}
          </button>
        )}

        {status === "ACTIVE" && (
          <button
            onClick={() => {
              const seats = Number(window.prompt("Seats for the renewal invoice:", String(suggestedSeats ?? "")));
              if (!Number.isFinite(seats) || seats <= 0) return;
              void run("renew", { seats });
            }}
            disabled={disabled}
            className="rounded-lg border border-sky-700 text-sky-300 hover:bg-sky-950 disabled:opacity-50 px-3 py-2 text-sm"
          >
            {busy === "renew" ? "…" : "Renew & invoice"}
          </button>
        )}
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}
      {message && <p className="text-xs text-emerald-400">{message}</p>}
    </div>
  );
}
