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
    | { action?: string; reason?: string; retentionDays?: number }
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