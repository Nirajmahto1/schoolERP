import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { controlPlane } from "@/lib/auth";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as
    | { email?: string; password?: string }
    | null;
  if (!body?.email || !body?.password) {
    return NextResponse.json(
      { type: "validation-error", title: "Invalid", status: 400, detail: "Email and password are required." },
      { status: 400 },
    );
  }

  const admin = await controlPlane().platformAdmin.findUnique({
    where: { email: body.email.trim().toLowerCase() },
    select: { id: true, passwordHash: true, isActive: true },
  });

  // Constant-ish work whether or not the admin exists.
  const hash =
    admin?.passwordHash ??
    "$2a$12$0000000000000000000000000000000000000000000000000000";
  const ok = await bcrypt.compare(body.password, hash);

  if (!admin || !ok || !admin.isActive) {
    return NextResponse.json(
      { type: "authentication-error", title: "Unauthorized", status: 401, detail: "Email or password is incorrect." },
      { status: 401 },
    );
  }

  const { createSession } = await import("@/lib/auth");
  await createSession(admin.id);
  return NextResponse.json({ ok: true });
}
