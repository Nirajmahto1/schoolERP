import { redirect } from "next/navigation";
import Link from "next/link";
import { currentAdmin, controlPlane } from "@/lib/auth";
import { latestSchemaVersionClient } from "@/lib/fleet";
import LogoutButton from "./logout-button";
import FleetMigrateButton from "./fleet-migrate";

export const dynamic = "force-dynamic";

const STATUS_STYLES: Record<string, string> = {
  ACTIVE: "bg-emerald-950 text-emerald-300 border-emerald-800",
  TRIAL: "bg-sky-950 text-sky-300 border-sky-800",
  SUSPENDED: "bg-amber-950 text-amber-300 border-amber-800",
  DELETING: "bg-red-950 text-red-300 border-red-800",
  CHURNED: "bg-slate-800 text-slate-400 border-slate-700",
};

const DRIFT_STYLES: Record<string, string> = {
  current: "text-emerald-400",
  behind: "text-amber-400",
  ahead: "text-sky-400",
  "no-datastore": "text-slate-500",
};

export default async function DashboardPage() {
  const admin = await currentAdmin();
  if (!admin) redirect("/login");

  const cp = controlPlane();
  const [tenants, targetVersion, recentAudit, grants] = await Promise.all([
    cp.tenant.findMany({
      include: { datastore: true, plan: true },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
    latestSchemaVersionClient(),
    cp.provisionAudit.findMany({ orderBy: { at: "desc" }, take: 12, include: { tenant: true } }),
    cp.supportGrant.findMany({
      where: { expiresAt: { gte: new Date() } },
      include: { admin: true, tenant: true },
      orderBy: { expiresAt: "desc" },
    }),
  ]);

  const counts = tenants.reduce<Record<string, number>>((acc, t) => {
    acc[t.status] = (acc[t.status] ?? 0) + 1;
    return acc;
  }, {});
  const drifting = tenants.filter(
    (t) => t.datastore && t.datastore.schemaVersion !== targetVersion,
  ).length;

  return (
    <main className="mx-auto max-w-7xl p-6 space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Platform Console</h1>
          <p className="text-sm text-slate-400">
            Signed in as {admin.email} · {admin.role}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <FleetMigrateButton />
          <Link
            href="/provision"
            className="rounded-lg bg-sky-600 hover:bg-sky-500 px-4 py-2 text-sm font-medium"
          >
            Provision school
          </Link>
          <LogoutButton />
        </div>
      </header>

      <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {["ACTIVE", "TRIAL", "SUSPENDED", "DELETING"].map((status) => (
          <div key={status} className="rounded-xl border border-slate-800 bg-slate-900 p-4">
            <p className="text-xs uppercase tracking-wide text-slate-500">{status}</p>
            <p className="text-2xl font-semibold mt-1">{counts[status] ?? 0}</p>
          </div>
        ))}
      </section>

      <section className="rounded-xl border border-slate-800 bg-slate-900 p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-medium">
            Tenants{" "}
            <span className="text-slate-500 text-sm">
              (schema target v{targetVersion}
              {drifting > 0 ? ` · ${drifting} drifting` : " · fleet current"})
            </span>
          </h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-slate-500 border-b border-slate-800">
                <th className="py-2 pr-4">Slug</th>
                <th className="py-2 pr-4">Status</th>
                <th className="py-2 pr-4">Plan</th>
                <th className="py-2 pr-4">Schema</th>
                <th className="py-2 pr-4">Last migrated</th>
                <th className="py-2 pr-4">Created</th>
                <th className="py-2"></th>
              </tr>
            </thead>
            <tbody>
              {tenants.map((t) => (
                <tr key={t.id} className="border-b border-slate-800/50 hover:bg-slate-900/60">
                  <td className="py-2 pr-4 font-mono text-slate-300">
                    {t.slug}
                    <span className="block text-xs text-slate-600">{t.legalName}</span>
                  </td>
                  <td className="py-2 pr-4">
                    <span
                      className={`rounded-md border px-2 py-0.5 text-xs ${STATUS_STYLES[t.status] ?? ""}`}
                    >
                      {t.status}
                    </span>
                  </td>
                  <td className="py-2 pr-4 text-slate-400">{t.plan?.name ?? "—"}</td>
                  <td className={`py-2 pr-4 font-mono ${DRIFT_STYLES[t.datastore ? (t.datastore.schemaVersion === targetVersion ? "current" : "behind") : "no-datastore"]}`}>
                    {t.datastore ? `v${t.datastore.schemaVersion}` : "—"}
                  </td>
                  <td className="py-2 pr-4 text-slate-500">
                    {t.datastore?.lastMigratedAt
                      ? new Date(t.datastore.lastMigratedAt).toLocaleDateString()
                      : "—"}
                  </td>
                  <td className="py-2 pr-4 text-slate-500">
                    {new Date(t.createdAt).toLocaleDateString()}
                  </td>
                  <td className="py-2 text-right">
                    <Link href={`/tenants/${t.id}`} className="text-sky-400 hover:text-sky-300 text-xs">
                      manage →
                    </Link>
                  </td>
                </tr>
              ))}
              {tenants.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-slate-500">
                    No tenants yet — provision the first school.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid md:grid-cols-2 gap-6">
        <section className="rounded-xl border border-slate-800 bg-slate-900 p-4">
          <h2 className="font-medium mb-3">Recent provisioning activity</h2>
          <ul className="space-y-2 text-sm">
            {recentAudit.map((a) => (
              <li key={a.id} className="flex items-baseline justify-between gap-4">
                <span className="text-slate-300">
                  <span className="font-mono text-xs text-slate-500">{a.action}</span>{" "}
                  {a.tenant?.slug ?? "—"}
                </span>
                <span className="text-xs text-slate-500">
                  {new Date(a.at).toLocaleString()}
                </span>
              </li>
            ))}
            {recentAudit.length === 0 && <li className="text-slate-500">No activity yet.</li>}
          </ul>
        </section>

        <section className="rounded-xl border border-slate-800 bg-slate-900 p-4">
          <h2 className="font-medium mb-3">Active support grants</h2>
          <ul className="space-y-2 text-sm">
            {grants.map((g) => (
              <li key={g.id} className="flex items-baseline justify-between gap-4">
                <span className="text-slate-300">
                  {g.tenant.slug}{" "}
                  <span className="block text-xs text-slate-500">{g.reason}</span>
                </span>
                <span className="text-xs text-amber-400">
                  until {new Date(g.expiresAt).toLocaleString()}
                </span>
              </li>
            ))}
            {grants.length === 0 && (
              <li className="text-slate-500">
                None. Access to school data requires a time-boxed, audited grant.
              </li>
            )}
          </ul>
        </section>
      </div>
    </main>
  );
}
