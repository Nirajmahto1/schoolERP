import { NextResponse } from "next/server";
import { currentAdmin } from "@/lib/auth";
import { runOpsCli } from "@/lib/ops-cli";

export const maxDuration = 300;

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESERVED = new Set([
  "www", "api", "admin", "app", "status", "mail", "ftp", "support", "help", "docs",
]);

interface ProvisionResult {
  tenantId: string;
  slug: string;
  database: string;
  /** Never surfaced to the browser — it contains the tenant role's password. */
  connRef?: string;
  schemaVersion: number;
  adminUserId: string | null;
  setupUrl: string | null;
  roleName: string | null;
  indexedUsers: number;
  alreadyProvisioned: boolean;
}

export async function POST(request: Request) {
  const admin = await currentAdmin();
  if (!admin) {
    return NextResponse.json(
      { type: "authentication-error", title: "Unauthorized", status: 401, detail: "Sign in first." },
      { status: 401 },
    );
  }

  const body = (await request.json().catch(() => null)) as
    | { slug?: string; legalName?: string; planCode?: string; trialDays?: number }
    | null;

  const slug = body?.slug?.trim().toLowerCase() ?? "";
  const legalName = body?.legalName?.trim() ?? "";
  if (!SLUG_RE.test(slug) || RESERVED.has(slug)) {
    return NextResponse.json(
      { type: "validation-error", title: "Invalid Slug", status: 400, detail: "That subdomain is not available." },
      { status: 400 },
    );
  }
  if (!legalName) {
    return NextResponse.json(
      { type: "validation-error", title: "Invalid Name", status: 400, detail: "A legal name is required." },
      { status: 400 },
    );
  }

  try {
    // The pipeline creates real databases and spawns the Prisma CLI — it must
    // run as its own process, not inside the Next.js server bundle.
    const args = [
      "create",
      "--slug", slug,
      "--legal-name", legalName,
      "--actor", `console:${admin.email}`,
    ];
    if (body?.planCode) args.push("--plan-code", body.planCode);
    if (body?.trialDays && body.trialDays > 0) args.push("--trial-days", String(body.trialDays));

    const result = JSON.parse(runOpsCli(args)) as ProvisionResult;
    // The connection reference embeds the tenant role's password; the plan's
    // rule is that connRefs are never surfaced in API responses.
    const { connRef: _connRef, ...safe } = result;
    return NextResponse.json(safe);
  } catch (err) {
    const message = (err as Error).message;
    if (/reserved|Invalid slug/i.test(message)) {
      return NextResponse.json(
        { type: "validation-error", title: "Invalid Slug", status: 400, detail: message },
        { status: 400 },
      );
    }
    return NextResponse.json(
      { type: "provision-failed", title: "Provisioning Failed", status: 500, detail: message },
      { status: 500 },
    );
  }
}