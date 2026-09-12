"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Metric = "students" | "staff" | "storage_bytes" | "messaging_credits";

interface UsageSample {
  metric: string;
  value: number;
  capturedAt: string;
}

interface UsageCardProps {
  tenantId: string;
  latest: Record<string, number>;
  history: UsageSample[];
  /** Plan caps, for the at-a-capacity warnings. Null = unlimited/no plan. */
  caps: { students: number | null };
}

const METRIC_LABEL: Record<Metric, string> = {
  students: "Students",
  staff: "Staff",
  storage_bytes: "Storage",
  messaging_credits: "Messaging credits",
};

function formatMetric(metric: string, value: number): string {
  if (metric === "storage_bytes") {
    if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`;
    if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
    if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${value} B`;
  }
  return value.toLocaleString("en-IN");
}

/**
 * Usage metering (BUILD_PLAN 4.2.4): latest sample per metric with plan-cap
 * warnings, a per-metric history table, a manual sample form (the nightly
 * job is the normal path), and the seats-vs-measured reconciliation flag.
 */
export default function UsageCard({ tenantId, latest, history, caps }: UsageCardProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [metric, setMetric] = useState<Metric>("students");
  const [value, setValue] = useState<string>("");

  async function recordSample() {
    const v = Number(value);
    if (!Number.isFinite(v) || v < 0) {
      setError("Enter a non-negative number.");
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(`/api/tenants/${tenantId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "record-usage", metric, value: v }),
      });
      const body = (await res.json().catch(() => null)) as { detail?: string } | null;
      if (!res.ok) setError(body?.detail ?? "Failed to record sample.");
      else {
        setMessage(`Recorded ${METRIC_LABEL[metric]} = ${v}.`);
        setValue("");
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  async function runRecon() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(`/api/tenants/${tenantId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "usage-recon" }),
      });
      const body = (await res.json().catch(() => null)) as
        | { detail?: string; seats?: number; measuredStudents?: number; overage?: number }
        | null;
      if (!res.ok) setError(body?.detail ?? "Reconciliation failed.");
      else {
        setMessage(
          body?.overage
            ? `Overage: ${body.measuredStudents} measured vs ${body.seats} seats — ${body.overage} students over. Next renewal bills measured, or the school upgrades.`
            : `Reconciled: ${body?.measuredStudents ?? 0} measured vs ${body?.seats ?? 0} seats — within plan.`,
        );
      }
    } finally {
      setBusy(false);
    }
  }

  // History grouped per metric (newest first), for the compact table.
  const byMetric = (["students", "staff", "storage_bytes", "messaging_credits"] as Metric[])
    .map((m) => ({ metric: m, samples: history.filter((h) => h.metric === m).slice(0, 4) }))
    .filter((g) => g.samples.length > 0 || latest[g.metric] !== undefined);

  const studentsCap = caps.students;
  const studentsNow = latest["students"];
  const capPct = studentsCap && studentsNow !== undefined ? Math.round((studentsNow / studentsCap) * 100) : null;

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900 p-4 space-y-4">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="font-medium">Usage &amp; metering</h2>
        <span className="text-xs text-slate-500">4.2.4 · samples, not estimates</span>
      </div>

      {/* Latest values vs caps */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {(["students", "staff", "storage_bytes", "messaging_credits"] as Metric[]).map((m) => {
          const v = latest[m];
          const atCap =
            m === "students" && studentsCap && v !== undefined
              ? { pct: Math.round((v / studentsCap) * 100), cap: studentsCap }
              : null;
          return (
            <div key={m} className="rounded-lg border border-slate-800 bg-slate-950 p-3">
              <div className="text-xs text-slate-500">{METRIC_LABEL[m]}</div>
              <div className={`text-lg font-mono ${atCap && atCap.pct >= 100 ? "text-red-400" : atCap && atCap.pct >= 90 ? "text-amber-400" : "text-slate-200"}`}>
                {v === undefined ? "—" : formatMetric(m, v)}
              </div>
              {atCap && (
                <div className={`text-xs mt-0.5 ${atCap.pct >= 100 ? "text-red-400" : atCap.pct >= 90 ? "text-amber-400" : "text-slate-500"}`}>
                  {atCap.pct}% of {atCap.cap.toLocaleString("en-IN")} cap
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* History */}
      {byMetric.length > 0 && (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-slate-500 border-b border-slate-800">
              <th className="py-1.5 pr-3">Metric</th>
              <th className="py-1.5 pr-3">Recent samples (newest first)</th>
            </tr>
          </thead>
          <tbody>
            {byMetric.map((g) => (
              <tr key={g.metric} className="border-b border-slate-800/50">
                <td className="py-1.5 pr-3 text-slate-400">{METRIC_LABEL[g.metric]}</td>
                <td className="py-1.5 font-mono text-xs text-slate-400">
                  {g.samples
                    .map((s) => `${formatMetric(g.metric, s.value)} · ${new Date(s.capturedAt).toLocaleString()}`)
                    .join("  →  ") || "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Manual sample + recon */}
      <div className="flex flex-wrap items-center gap-2 border-t border-slate-800 pt-3">
        <select
          value={metric}
          onChange={(e) => setMetric(e.target.value as Metric)}
          className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-2 text-sm"
        >
          {(["students", "staff", "storage_bytes", "messaging_credits"] as Metric[]).map((m) => (
            <option key={m} value={m}>
              {METRIC_LABEL[m]}
            </option>
          ))}
        </select>
        <input
          type="number"
          min={0}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="value"
          className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-2 text-sm w-28"
        />
        <button
          onClick={() => void recordSample()}
          disabled={busy || value === ""}
          className="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-50"
        >
          {busy ? "…" : "Record sample"}
        </button>
        <button
          onClick={() => void runRecon()}
          disabled={busy}
          className="rounded-lg border border-sky-700 text-sky-300 hover:bg-sky-950 disabled:opacity-50 px-3 py-2 text-sm"
        >
          {busy ? "…" : "Reconcile seats"}
        </button>
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}
      {message && <p className="text-xs text-emerald-400">{message}</p>}
    </section>
  );
}
