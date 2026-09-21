import { createHash, randomBytes } from "crypto";
import { NextResponse } from "next/server";
import { currentAdmin, controlPlane } from "@/lib/auth";

/**
 * Support-grant flow (BUILD_PLAN 1.1 / §13.4.2).
 *
 * Platform support staff never get standing access to a school's data: every
 * grant is time-boxed, reason-required, and audited. Creating a grant mints a
 * ONE-TIME activation code — shown exactly once in this response, stored only
 * as a SHA-256 hash. The engineer redeems it at
 * POST /api/v1/auth/support/activate to receive a time-boxed session inside
 * the school (attributed to the grant in every audit row).
 *
 * DELETE revokes mid-window — the school can demand it, and it takes effect
 * on the next refresh.
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
  if (reason.length < 10) {
    return NextResponse.json(
      { type: "validation-error", title: "Reason Required", status: 400, detail: "Describe the support task (min 10 chars) — the school can read this reason in their audit trail." },
      { status: 400 },
    );
  }
  const hours = Math.max(1, Math.min(72, body?.hours ?? 24));

  // 32 bytes of CSPRNG, base64url — ~43 chars, unguessable, transcribable.
  const code = randomBytes(32).toString("base64url");
  const codeHash = createHash("sha256").update(code).digest("hex");

  try {
    const grant = await controlPlane().supportGrant.create({
      data: {
        tenantId: id,
        platformAdminId: admin.adminId,
        reason,
        expiresAt: new Date(Date.now() + hours * 3_600_000),
        codeHash,
      },
      include: { admin: { select: { email: true } } },
    });
    // The plaintext code exists ONLY here — never persisted, never logged.
    return NextResponse.json({
      ok: true,
      code,
      grant: { id: grant.id, reason: grant.reason, expiresAt: grant.expiresAt, admin: grant.admin.email },
      activateWith: "POST /api/v1/auth/support/activate { code }",
    });
  } catch (err) {
    return NextResponse.json(
      { type: "grant-failed", title: "Grant Failed", status: 500, detail: (err as Error).message },
      { status: 500 },
    );
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const admin = await currentAdmin();
  if (!admin) {
    return NextResponse.json(
      { type: "authentication-error", title: "Unauthorized", status: 401, detail: "Sign in first." },
      { status: 401 },
    );
  }

  const { id } = await context.params;
  const url = new URL(_request.url);
  const grantId = url.searchParams.get("grantId");
  if (!grantId) {
    return NextResponse.json(
      { type: "validation-error", title: "Grant Id Required", status: 400, detail: "Pass ?grantId= of the grant to revoke." },
      { status: 400 },
    );
  }

  try {
    // Conditional revoke: never resurrect or double-revoke.
    const revoked = await controlPlane().supportGrant.updateMany({
      where: { id: grantId, tenantId: id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (revoked.count !== 1) {
      return NextResponse.json(
        { type: "not-found", title: "Not Revocable", status: 404, detail: "No such active grant for this tenant." },
        { status: 404 },
      );
    }
    return NextResponse.json({ ok: true, note: "Revoked. Live access tokens die within their 15-minute TTL; refresh fails immediately." });
  } catch (err) {
    return NextResponse.json(
      { type: "revoke-failed", title: "Revoke Failed", status: 500, detail: (err as Error).message },
      { status: 500 },
    );
  }
}
