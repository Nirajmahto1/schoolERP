import { NextResponse } from "next/server";
import { currentAdmin } from "@/lib/auth";
import { runOpsCli } from "@/lib/ops-cli";

export const maxDuration = 300;

/**
 * Fleet migration (BUILD_PLAN 1.4 / 1.7): fan out `prisma migrate deploy` to
 * every tenant with bounded concurrency, recording each attempt in
 * migration_run and updating schema versions. Stops on first failure and
 * reports which tenants were skipped so the operator can resume.
 *
 * Runs as the provisioning CLI child process — the migration itself spawns
 * the Prisma CLI, which cannot run inside the Next.js server bundle.
 */
export async function POST(request: Request) {
  const admin = await currentAdmin();
  if (!admin) {
    return NextResponse.json(
      { type: "authentication-error", title: "Unauthorized", status: 401, detail: "Sign in first." },
      { status: 401 },
    );
  }

  const body = (await request.json().catch(() => null)) as { tenantId?: string } | null;

  try {
    const args = ["migrate", "--all", "--actor", `console:${admin.email}`];
    if (body?.tenantId) args.push("--tenant-id", body.tenantId);

    const result = JSON.parse(runOpsCli(args)) as {
      targetVersion: number;
      attempted: number;
      succeeded: number;
      failed: number;
      skipped: number;
      failures: Array<{ tenantId: string; slug: string; error: string }>;
    };
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { type: "migration-failed", title: "Migration Failed", status: 500, detail: (err as Error).message },
      { status: 500 },
    );
  }
}