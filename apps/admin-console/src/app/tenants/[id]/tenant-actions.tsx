"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Action = "suspend" | "resume" | "schedule-delete" | "hard-delete" | "recount-seats";

interface TenantActionsProps {
  tenantId: string;
  status: string;
  hasDatastore: boolean;
}

export default function TenantActions({ tenantId, status, hasDatastore }: TenantActionsProps) {
  const router = useRouter();
  const [busy, setBusy] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function run(action: Action, opts: { reason?: string; retentionDays?: number } = {}) {
    setBusy(action);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(`/api/tenants/${tenantId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...opts }),
      });
      const body = (await res.json().catch(() => null)) as {
        detail?: string;
        seats?: number;
        deleteAfter?: string;
      } | null;
      if (!res.ok) {
        setError(body?.detail ?? "Action failed.");
      } else if (action === "recount-seats") {
        setMessage(`Seats recounted: ${body?.seats ?? "?"} active students.`);
      } else if (action === "schedule-delete") {
        setMessage(`Deletion scheduled for ${body?.deleteAfter ?? "the retention date"}.`);
      } else if (action === "hard-delete") {
        setMessage("Tenant hard-deleted (certificate recorded in audit).");
        router.push("/");
      } else {
        setMessage(`${action} done.`);
      }
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  const disabled = busy !== null;

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap justify-end gap-2">
        {status === "SUSPENDED" ? (
          <button
            onClick={() => run("resume")}
            disabled={disabled}
            className="rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 px-3 py-2 text-sm font-medium"
          >
            {busy === "resume" ? "…" : "Resume"}
          </button>
        ) : (
          <button
            onClick={() => run("suspend")}
            disabled={disabled || status === "DELETING"}
            className="rounded-lg border border-amber-700 text-amber-300 hover:bg-amber-950 disabled:opacity-50 px-3 py-2 text-sm"
          >
            {busy === "suspend" ? "…" : "Suspend"}
          </button>
        )}

        {hasDatastore && (
          <button
            onClick={() => run("recount-seats")}
            disabled={disabled}
            className="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-50"
          >
            {busy === "recount-seats" ? "…" : "Recount seats"}
          </button>
        )}

        {status !== "DELETING" && (
          <button
            onClick={() => {
              const retentionDays = Number(window.prompt("Retention days before hard delete (default 30):", "30") ?? "30");
              if (Number.isFinite(retentionDays)) {
                void run("schedule-delete", { retentionDays });
              }
            }}
            disabled={disabled}
            className="rounded-lg border border-red-900 text-red-300 hover:bg-red-950 disabled:opacity-50 px-3 py-2 text-sm"
          >
            {busy === "schedule-delete" ? "…" : "Schedule deletion"}
          </button>
        )}

        {status === "DELETING" && (
          <button
            onClick={() => {
              if (window.confirm("Hard-delete this tenant now? The database is dropped. This is irreversible.")) {
                void run("hard-delete");
              }
            }}
            disabled={disabled}
            className="rounded-lg bg-red-900 hover:bg-red-800 disabled:opacity-50 px-3 py-2 text-sm font-medium"
          >
            {busy === "hard-delete" ? "…" : "Hard delete now"}
          </button>
        )}
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}
      {message && <p className="text-xs text-emerald-400">{message}</p>}
    </div>
  );
}