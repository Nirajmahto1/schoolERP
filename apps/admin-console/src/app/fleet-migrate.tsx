"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

interface MigrateResult {
  targetVersion: number;
  attempted: number;
  succeeded: number;
  failed: number;
  skipped: number;
  failures: Array<{ tenantId: string; slug: string; error: string }>;
}

export default function FleetMigrateButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<MigrateResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/migrate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = (await res.json().catch(() => null)) as MigrateResult & { detail?: string } | null;
      if (!res.ok) {
        setError(body?.detail ?? "Migration failed.");
      } else {
        setResult(body as MigrateResult);
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <button
        onClick={run}
        disabled={busy}
        className="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-50"
      >
        {busy ? "Migrating fleet…" : "Migrate fleet"}
      </button>
      {result && (
        <p className="text-xs text-slate-400 max-w-sm text-right">
          target v{result.targetVersion} · {result.succeeded} succeeded · {result.failed} failed ·{" "}
          {result.skipped} skipped
          {result.failures.length > 0 && (
            <span className="block text-red-400">{result.failures[0].slug}: {result.failures[0].error}</span>
          )}
        </p>
      )}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}