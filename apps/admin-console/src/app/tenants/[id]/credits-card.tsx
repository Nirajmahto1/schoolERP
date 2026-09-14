"use client";

// ──────────────────────────────────────────────
// Messaging credits card (BUILD_PLAN 5.7)
//
// Balance at a glance, low-balance flag, and the top-up action that issues
// a Rule 46 invoice server-side. Ops completes the sale here — money must
// be verified in the bank before marking the resulting invoice paid.
// ──────────────────────────────────────────────

import { useState } from "react";

interface Props {
  tenantId: string;
  initialBalance: number;
  initialPurchased: number;
  lowBalanceAt: string | null;
}

export default function CreditsCard({ tenantId, initialBalance, initialPurchased, lowBalanceAt }: Props) {
  const [balance, setBalance] = useState(initialBalance);
  const [purchased, setPurchased] = useState(initialPurchased);
  const [lowSince, setLowSince] = useState(lowBalanceAt);
  const [units, setUnits] = useState("1000");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const low = balance <= 100 || !!lowSince;

  async function topUp() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/tenants/${tenantId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "credits-top-up", units: Number(units) }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setMsg(json.detail ?? json.title ?? `HTTP ${res.status}`);
        return;
      }
      setBalance(json.balance);
      setPurchased(json.purchasedTotal);
      setLowSince(null);
      setMsg(`Invoice ${json.invoiceNo} issued — ${json.units} units, ₹${json.total} incl. GST. Mark paid after verifying the bank credit.`);
    } catch (err) {
      setMsg((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-lg border border-slate-800 bg-slate-900/50 p-4">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">
        Messaging credits
      </h2>
      <dl className="mb-4 grid grid-cols-3 gap-3 text-sm">
        <div>
          <dt className="text-slate-500">balance</dt>
          <dd className={low ? "font-semibold text-amber-400" : "text-slate-100"}>
            {balance.toLocaleString("en-IN")} units
          </dd>
        </div>
        <div>
          <dt className="text-slate-500">purchased (lifetime)</dt>
          <dd className="text-slate-300">{purchased.toLocaleString("en-IN")}</dd>
        </div>
        <div>
          <dt className="text-slate-500">low-balance flag</dt>
          <dd className="text-slate-300">
            {lowSince ? (
              <span className="text-amber-400">since {new Date(lowSince).toLocaleString("en-IN")}</span>
            ) : (
              "—"
            )}
          </dd>
        </div>
      </dl>

      <div className="flex items-center gap-2">
        <input
          type="number"
          min={1}
          step={100}
          value={units}
          onChange={(e) => setUnits(e.target.value)}
          className="w-28 rounded border border-slate-700 bg-slate-800 px-2 py-1 text-sm text-slate-200"
          aria-label="Top-up units"
        />
        <button
          onClick={topUp}
          disabled={busy || Number(units) <= 0 || !Number.isInteger(Number(units))}
          className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-40"
        >
          {busy ? "Invoicing…" : "Top up & invoice"}
        </button>
        <span className="text-xs text-slate-500">₹0.35/unit · Rule 46 invoice issued on purchase</span>
      </div>
      {msg && <p className="mt-2 text-xs text-amber-300">{msg}</p>}
      {low && !msg && (
        <p className="mt-2 text-xs text-amber-300">
          Low balance: sends fail closed when the envelope empties. Top up to keep alerts flowing.
        </p>
      )}
    </section>
  );
}
