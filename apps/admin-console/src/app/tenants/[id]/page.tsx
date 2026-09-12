import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { currentAdmin, controlPlane } from "@/lib/auth";
import { latestSchemaVersionClient } from "@/lib/fleet";
import TenantActions from "./tenant-actions";
import GrantForm from "./grant-form";

export const dynamic = "force-dynamic";

const STATUS_STYLES: Record<string, string> = {
  ACTIVE: "bg-emerald-950 text-emerald-300 border-emerald-800",
  TRIAL: "bg-sky-950 text-sky-300 border-sky-800",
  SUSPENDED: "bg-amber-950 text-amber-300 border-amber-800",
  DELETING: "bg-red-950 text-red-300 border-red-800",
  CHURNED: "bg-slate-800 text-slate-400 border-slate-700",
};

const SUB_STATUS_STYLES: Record<string, string> = {
  ACTIVE: "bg-emerald-950 text-emerald-300 border-emerald-800",
  TRIAL: "bg-sky-950 text-sky-300 border-sky-800",
  PAST_DUE: "bg-amber-950 text-amber-300 border-amber-800",
  CANCELLED: "bg-slate-800 text-slate-400 border-slate-700",
};

export default async function TenantPage({ params }: { params: Promise<{ id: string }> }) {
  const admin = await currentAdmin();
  if (!admin) redirect("/login");
  const { id } = await params;

  const cp = controlPlane();
  const tenant = await cp.tenant.findUnique({
    where: { id },
    include: {
      datastore: true,
      plan: true,
      subscriptions: { orderBy: { periodStart: "desc" }, take: 5 },
      invoices: { orderBy: { createdAt: "desc" }, take: 10 },
      migrationRuns: { orderBy: { createdAt: "desc" }, take: 20 },
      supportGrants: {
        where: { expiresAt: { gte: new Date() } },
        include: { admin: true },
        orderBy: { expiresAt: "desc" },
      },
      auditEvents: { orderBy: { at: "desc" }, take: 25 },
    },
  });
  if (!tenant) notFound();

  const targetVersion = latestSchemaVersionClient();
  const drift = tenant.datastore
    ? tenant.datastore.schemaVersion === targetVersion
      ? "current"
      : tenant.datastore.schemaVersion > targetVersion
        ? "ahead"
        : "behind"
    : "no-datastore";
  const subscription = tenant.subscriptions[0];

  return (
    <main className="mx-auto max-w-7xl p-6 space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <Link href="/" className="text-sm text-sky-400 hover:text-sky-300">
            ← All tenants
          </Link>
          <h1 className="text-2xl font-semibold mt-1">{tenant.legalName}</h1>
          <p className="text-sm text-slate-400">
            <span className="font-mono">{tenant.slug}</span> ·{" "}
            <span
              className={`rounded-md border px-2 py-0.5 text-xs ${STATUS_STYLES[tenant.status] ?? ""}`}
            >
              {tenant.status}
            </span>{" "}
            · region {tenant.region}
          </p>
        </div>
        <TenantActions
          tenantId={tenant.id}
          status={tenant.status}
          hasDatastore={!!tenant.datastore}
        />
      </header>

      <section className="grid md:grid-cols-2 gap-6">
        {/* Datastore & schema */}
        <div className="rounded-xl border border-slate-800 bg-slate-900 p-4 space-y-3">
          <h2 className="font-medium">Datastore &amp; schema</h2>
          {tenant.datastore ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-slate-500">kind</dt>
              <dd className="font-mono">{tenant.datastore.kind}</dd>
              <dt className="text-slate-500">schema</dt>
              <dd className="font-mono">
                v{tenant.datastore.schemaVersion} / target v{targetVersion}
                <span className={drift === "current" ? "text-emerald-400" : "text-amber-400"}>
                  {" "}
                  · {drift}
                </span>
              </dd>
              <dt className="text-slate-500">last migrated</dt>
              <dd className="text-slate-300">
                {tenant.datastore.lastMigratedAt
                  ? new Date(tenant.datastore.lastMigratedAt).toLocaleString()
                  : "—"}
              </dd>
            </dl>
          ) : (
            <p className="text-sm text-slate-500">No datastore yet — provisioning incomplete.</p>
          )}
        </div>

        {/* Plan & subscription */}
        <div className="rounded-xl border border-slate-800 bg-slate-900 p-4 space-y-3">
          <h2 className="font-medium">Plan &amp; billing</h2>
          {tenant.plan ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-slate-500">plan</dt>
              <dd className="text-slate-300">
                {tenant.plan.name}{" "}
                <span className="font-mono text-xs text-slate-500">({tenant.plan.code})</span>
              </dd>
              <dt className="text-slate-500">price</dt>
              <dd className="text-slate-300">₹{tenant.plan.pricePerStudentYear.toString()}/student/year</dd>
              <dt className="text-slate-500">limits</dt>
              <dd className="text-slate-300">
                {tenant.plan.maxBranches} branches · {tenant.plan.maxStudents} students
              </dd>
              <dt className="text-slate-500">features</dt>
              <dd className="font-mono text-xs text-slate-400">
                {Object.keys((tenant.plan.featureFlags as Record<string, unknown>) ?? {}).join(", ") ||
                  "—"}
              </dd>
            </dl>
          ) : (
            <p className="text-sm text-slate-500">No plan assigned.</p>
          )}

          {subscription ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm border-t border-slate-800 pt-3">
              <dt className="text-slate-500">subscription</dt>
              <dd>
                <span
                  className={`rounded-md border px-2 py-0.5 text-xs ${SUB_STATUS_STYLES[subscription.status] ?? ""}`}
                >
                  {subscription.status}
                </span>
              </dd>
              <dt className="text-slate-500">period</dt>
              <dd className="text-slate-300">
                {new Date(subscription.periodStart).toLocaleDateString()} →{" "}
                {new Date(subscription.periodEnd).toLocaleDateString()}
              </dd>
              <dt className="text-slate-500">seats</dt>
              <dd className="text-slate-300">
                {subscription.seats} active students
                <span className="text-slate-500"> / {tenant.plan?.maxStudents ?? "∞"}</span>
              </dd>
            </dl>
          ) : (
            <p className="text-sm text-slate-500 border-t border-slate-800 pt-3">
              No active subscription.
            </p>
          )}
        </div>
      </section>

      {/* Invoices (Rule 46 tax invoices, printable PDF) */}
      <section className="rounded-xl border border-slate-800 bg-slate-900 p-4">
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="font-medium">Tax invoices</h2>
          <span className="text-xs text-slate-500">latest 10 · Rule 46 (CGST Rules) PDF</span>
        </div>
        {tenant.invoices.length === 0 ? (
          <p className="text-sm text-slate-500 mt-3">No invoices yet — issue one on conversion or renewal.</p>
        ) : (
          <table className="w-full text-sm mt-3">
            <thead>
              <tr className="text-left text-slate-500 border-b border-slate-800">
                <th className="py-1.5 pr-3">Invoice</th>
                <th className="py-1.5 pr-3">Issued</th>
                <th className="py-1.5 pr-3">Period</th>
                <th className="py-1.5 pr-3 text-right">Amount</th>
                <th className="py-1.5 pr-3 text-right">GST</th>
                <th className="py-1.5 pr-3">Status</th>
                <th className="py-1.5 text-right">PDF</th>
              </tr>
            </thead>
            <tbody>
              {tenant.invoices.map((inv) => (
                <tr key={inv.id} className="border-b border-slate-800/50">
                  <td className="py-1.5 pr-3 font-mono text-xs">{inv.invoiceNo ?? "(unnumbered)"}</td>
                  <td className="py-1.5 pr-3 text-xs text-slate-400">
                    {inv.issuedAt ? new Date(inv.issuedAt).toLocaleDateString() : "—"}
                  </td>
                  <td className="py-1.5 pr-3 text-xs text-slate-400">
                    {inv.periodStart && inv.periodEnd
                      ? `${new Date(inv.periodStart).toLocaleDateString()} → ${new Date(inv.periodEnd).toLocaleDateString()}`
                      : "—"}
                  </td>
                  <td className="py-1.5 pr-3 text-right font-mono text-xs">
                    ₹{inv.amount.toString()}
                  </td>
                  <td className="py-1.5 pr-3 text-right font-mono text-xs text-slate-400">
                    ₹{inv.gstAmount.toString()}
                  </td>
                  <td className="py-1.5 pr-3">
                    <span
                      className={`rounded-md border px-2 py-0.5 text-xs ${
                        inv.status === "PAID"
                          ? "bg-emerald-950 text-emerald-300 border-emerald-800"
                          : inv.status === "ISSUED"
                            ? "bg-sky-950 text-sky-300 border-sky-800"
                            : ""
                      }`}
                    >
                      {inv.status}
                    </span>
                  </td>
                  <td className="py-1.5 text-right">
                    <a
                      href={`/api/tenants/${tenant.id}/invoices/${inv.id}/pdf`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sky-400 hover:text-sky-300 text-xs"
                    >
                      Open PDF ↗
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <div className="grid md:grid-cols-2 gap-6">
        {/* Migration runs */}
        <section className="rounded-xl border border-slate-800 bg-slate-900 p-4">
          <h2 className="font-medium mb-3">Migration runs</h2>
          {tenant.migrationRuns.length === 0 ? (
            <p className="text-sm text-slate-500">No fleet migrations recorded yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-slate-500 border-b border-slate-800">
                  <th className="py-1.5 pr-3">Run</th>
                  <th className="py-1.5 pr-3">From → To</th>
                  <th className="py-1.5 pr-3">Status</th>
                  <th className="py-1.5">When</th>
                </tr>
              </thead>
              <tbody>
                {tenant.migrationRuns.map((run) => (
                  <tr key={run.id} className="border-b border-slate-800/50">
                    <td className="py-1.5 pr-3 font-mono text-xs text-slate-400">{run.id.slice(-8)}</td>
                    <td className="py-1.5 pr-3 font-mono text-xs">
                      v{run.fromVersion} → v{run.toVersion}
                    </td>
                    <td className="py-1.5 pr-3">
                      <span
                        className={
                          run.status === "SUCCEEDED"
                            ? "text-emerald-400"
                            : run.status === "FAILED"
                              ? "text-red-400"
                              : "text-slate-400"
                        }
                      >
                        {run.status}
                      </span>
                      {run.error && (
                        <span className="block text-xs text-red-400/80 max-w-64 truncate" title={run.error}>
                          {run.error}
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 text-xs text-slate-500">
                      {new Date(run.createdAt).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        {/* Audit trail */}
        <section className="rounded-xl border border-slate-800 bg-slate-900 p-4">
          <h2 className="font-medium mb-3">Audit trail</h2>
          <ul className="space-y-2 text-sm">
            {tenant.auditEvents.map((a) => (
              <li key={a.id} className="flex items-baseline justify-between gap-4">
                <span className="text-slate-300">
                  <span className="font-mono text-xs text-slate-500">{a.action}</span>
                  <span className="block text-xs text-slate-600">{a.actor}</span>
                </span>
                <span className="text-xs text-slate-500">{new Date(a.at).toLocaleString()}</span>
              </li>
            ))}
            {tenant.auditEvents.length === 0 && (
              <li className="text-slate-500">No audit events yet.</li>
            )}
          </ul>
        </section>
      </div>

      {/* Support grants */}
      <section className="rounded-xl border border-slate-800 bg-slate-900 p-4">
        <h2 className="font-medium mb-3">Support grants (time-boxed, audited)</h2>
        <ul className="space-y-2 text-sm mb-4">
          {tenant.supportGrants.map((g) => (
            <li key={g.id} className="flex items-baseline justify-between gap-4">
              <span className="text-slate-300">
                {g.reason}
                <span className="block text-xs text-slate-500">
                  granted by {g.admin.email}
                </span>
              </span>
              <span className="text-xs text-amber-400">until {new Date(g.expiresAt).toLocaleString()}</span>
            </li>
          ))}
          {tenant.supportGrants.length === 0 && (
            <li className="text-slate-500">None active. No standing access — grants expire.</li>
          )}
        </ul>
        <GrantForm tenantId={tenant.id} />
      </section>
    </main>
  );
}