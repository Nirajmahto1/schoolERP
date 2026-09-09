import { NextResponse } from "next/server";
import { currentAdmin, controlPlane } from "@/lib/auth";

/**
 * Support-grant request flow (BUILD_PLAN 1.1 / 1.7).
 *
 * Platform support staff never get standing access to a school's data: every
 * grant is time-boxed, reason-required, and audited. The tenant is surfaced to
 * the school, so a grant is visible in the school's own audit trail too.
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
    | { reason?: string; hours?: number }
    | null;

  const reason = body?.reason?.trim() ?? "";
  if (!reason) {
    return NextResponse.json(
      { type: "validation-error", title: "Reason Required", status: 400, detail: "Every support grant needs a reason." },
      { status: 400 },
    );
  }
  const hours = Math.max(1, Math.min(72, body?.hours ?? 24));

  try {
    const grant = await controlPlane().supportGrant.create({
      data: {
        tenantId: id,
        platformAdminId: admin.adminId,
        reason,
        expiresAt: new Date(Date.now() + hours * 3_600_000),
      },
    });
    return NextResponse.json({ ok: true, grant });
  } catch (err) {
    return NextResponse.json(
      { type: "grant-failed", title: "Grant Failed", status: 500, detail: (err as Error).message },
      { status: 500 },
    );
  }
}