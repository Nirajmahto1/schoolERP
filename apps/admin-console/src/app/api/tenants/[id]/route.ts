import { NextResponse } from "next/server";
import { currentAdmin, controlPlane } from "@/lib/auth";

/**
 * Tenant lifecycle actions (BUILD_PLAN 1.5 / 1.7).
 *
 * Every action is audited by the provisioning service and requires an
 * authenticated platform admin. Hard-delete additionally requires the
 * maintenance/admin database URL so the tenant database itself can be dropped.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const admin = await currentAdmin();
  if (!admin) {
    return NextResponse.json(
      { type: "authentication-error", title: "Unauthorized", status: 401, detail: "Sign in first." },
      { status: 401 },
    );
  }

  const { id } = await context.params;
  const body = (await request.json().catch(() => null)) as
    | { action?: string; reason?: string; retentionDays?: number; planCode?: string; seats?: number; invoiceId?: string; metric?: string; value?: number; limit?: number }
    | null;
  const action = body?.action;

  const cp = controlPlane();
  const actor = `console:${admin.email}`;

  try {
    // Lazy import: Node-only module chain (Prisma engines, child processes) that
    // must never be bundled into the client.
    const lifecycle = await import("@school-erp/provisioning-service/dist/index.js");
    const { loadProvisioningEnv } = await import("@school-erp/provisioning-service/dist/config.js");

    switch (action) {
      case "suspend": {
        const reason = body?.reason?.trim() || "suspended from platform console";
        await lifecycle.suspendTenant(cp, id, reason, actor);
        return NextResponse.json({ ok: true, status: "SUSPENDED" });
      }
      case "resume": {
        await lifecycle.resumeTenant(cp, id, actor);
        return NextResponse.json({ ok: true, status: "resumed" });
      }
      case "schedule-delete": {
        const retentionDays = Math.max(0, Math.min(365, body?.retentionDays ?? 30));
        const { deleteAfter } = await lifecycle.scheduleTenantDeletion(cp, id, retentionDays, actor);
        return NextResponse.json({ ok: true, deleteAfter: deleteAfter.toISOString() });
      }
      case "hard-delete": {
        const env = loadProvisioningEnv();
        const certificate = await lifecycle.hardDeleteTenant(cp, id, env.adminDatabaseUrl, actor);
        return NextResponse.json({ ok: true, certificate });
      }
      case "recount-seats": {
        const seats = await lifecycle.recountSeats(cp, id, actor);
        return NextResponse.json({ ok: true, seats });
      }
      case "convert-paid": {
        // Trial → paid (BUILD_PLAN 4.2.2): issues the Rule 46 tax invoice in
        // the same transaction. Supplier identity comes from env, exactly
        // like the CLI convert command.
        const planCode = body?.planCode?.trim().toUpperCase();
        const seats = Math.floor(Number(body?.seats));
        if (!planCode) throw new Error("planCode is required.");
        if (!Number.isFinite(seats) || seats <= 0) throw new Error("seats must be a positive number.");
        const { convertTenantToPaid } = await import("@school-erp/provisioning-service/dist/billing.js");
        const { loadProvisioningEnv } = await import("@school-erp/provisioning-service/dist/config.js");
        const env = loadProvisioningEnv();
        const result = await convertTenantToPaid(cp, {
          tenantId: id,
          planCode,
          seats,
          supplierGstin: env.supplierGstin,
          supplierName: env.supplierName,
          supplierAddress: env.supplierAddress,
          actor,
        });
        return NextResponse.json({ ok: true, invoiceId: result.invoiceId, invoiceNo: result.invoiceNo, total: result.total, amountInWords: result.amountInWords });
      }
      case "renew": {
        // Renewal (4.2.2): rolls the period forward one year and issues the
        // next sequentially numbered invoice on the tenant's current plan.
        const seats = Math.floor(Number(body?.seats));
        if (!Number.isFinite(seats) || seats <= 0) throw new Error("seats must be a positive number.");
        const { issueRenewalInvoice } = await import("@school-erp/provisioning-service/dist/billing.js");
        const { loadProvisioningEnv } = await import("@school-erp/provisioning-service/dist/config.js");
        const env = loadProvisioningEnv();
        const result = await issueRenewalInvoice(cp, {
          tenantId: id,
          seats,
          supplierGstin: env.supplierGstin,
          supplierName: env.supplierName,
          supplierAddress: env.supplierAddress,
          actor,
        });
        return NextResponse.json({ ok: true, invoiceId: result.invoiceId, invoiceNo: result.invoiceNo, total: result.total, amountInWords: result.amountInWords });
      }
      case "invoice-paid": {
        const invoiceId = body?.invoiceId?.trim();
        if (!invoiceId) throw new Error("invoiceId is required.");
        const { markSaasInvoicePaid } = await import("@school-erp/provisioning-service/dist/billing.js");
        const invoice = await markSaasInvoicePaid(cp, invoiceId, actor);
        return NextResponse.json({ ok: true, invoiceNo: invoice.invoiceNo, status: invoice.status });
      }
      case "record-usage": {
        // Point-in-time sample (BUILD_PLAN 4.2.4) — normally pushed by the
        // platform's nightly metering job; this is the manual/ops path.
        const billing = await import("@school-erp/provisioning-service/dist/billing.js");
        const metric = body?.metric as string | undefined;
        const value = Math.round(Number(body?.value));
        if (!metric || !["students", "staff", "storage_bytes", "messaging_credits"].includes(metric)) {
          throw new Error("metric must be students | staff | storage_bytes | messaging_credits.");
        }
        if (!Number.isFinite(value) || value < 0) throw new Error("value must be a non-negative number.");
        await billing.recordUsage(cp, id, metric as "students" | "staff" | "storage_bytes" | "messaging_credits", value);
        return NextResponse.json({ ok: true, metric, value });
      }
      case "usage-recon": {
        // Seats vs measured students — overage is flagged, never silently billed.
        const { reconcileMeteredBilling } = await import("@school-erp/provisioning-service/dist/billing.js");
        const recon = await reconcileMeteredBilling(cp, id);
        return NextResponse.json({ ok: true, ...recon });
      }
      case "usage-history": {
        // Recent samples per metric for the console's usage sparkline table.
        const limit = Math.min(500, Math.max(1, Math.floor(Number(body?.limit) || 200)));
        const rows = await cp.usageRecord.findMany({
          where: { tenantId: id },
          orderBy: { capturedAt: "desc" },
          take: limit,
          select: { metric: true, value: true, capturedAt: true },
        });
        return NextResponse.json({
          ok: true,
          rows: rows.map((r) => ({ metric: r.metric, value: Number(r.value), capturedAt: r.capturedAt.toISOString() })),
        });
      }
      default:
        return NextResponse.json(
          { type: "validation-error", title: "Unknown Action", status: 400, detail: `No such action: ${action ?? "(none)"}` },
          { status: 400 },
        );
    }
  } catch (err) {
    const message = (err as Error).message;
    // Hard-delete requires the tenant to be DELETING first — surface that as a 409.
    if (/not DELETING/i.test(message)) {
      return NextResponse.json(
        { type: "state-conflict", title: "Wrong State", status: 409, detail: message },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { type: "action-failed", title: "Action Failed", status: 500, detail: message },
      { status: 500 },
    );
  }
}