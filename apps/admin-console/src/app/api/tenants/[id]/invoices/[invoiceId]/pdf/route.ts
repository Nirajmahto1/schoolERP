import { NextResponse } from "next/server";
import { currentAdmin, controlPlane } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * Download a tenant's SaaS tax invoice as a printable PDF (BUILD_PLAN 4.2.2).
 *
 * Served to authenticated platform admins only, and scoped to the tenant in
 * the URL — an admin can't fish for another tenant's invoice by guessing
 * invoice IDs, and the 404 is indistinguishable from "no such invoice".
 * The bytes come from renderSaasInvoicePdf, which caches the base64 render
 * in SaasInvoice.invoicePdf, so repeat downloads don't re-render.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string; invoiceId: string }> },
) {
  const admin = await currentAdmin();
  if (!admin) {
    return NextResponse.json(
      { type: "authentication-error", title: "Unauthorized", status: 401, detail: "Sign in first." },
      { status: 401 },
    );
  }

  const { id, invoiceId } = await context.params;
  const cp = controlPlane();

  // Tenant-scoped fetch: also proves the invoice belongs to this tenant.
  const invoice = await cp.saasInvoice.findFirst({
    where: { id: invoiceId, tenantId: id },
    select: { invoiceNo: true },
  });
  if (!invoice) {
    return NextResponse.json(
      { type: "not-found", title: "Not Found", status: 404, detail: "No such invoice for this tenant." },
      { status: 404 },
    );
  }

  try {
    // Lazy import: Node-only module chain (Prisma engines) that must never be
    // bundled into the client — same pattern as the tenant lifecycle route.
    const { renderSaasInvoicePdf } = await import("@school-erp/provisioning-service/dist/invoice-pdf.js");
    const { pdf, cached } = await renderSaasInvoicePdf(cp, invoiceId);

    const filename = `${invoice.invoiceNo ?? invoiceId}.pdf`;
    return new NextResponse(new Uint8Array(pdf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${filename}"`,
        "Cache-Control": "private, no-store",
        "X-Invoice-Pdf-Cache": cached ? "hit" : "miss",
      },
    });
  } catch (err) {
    return NextResponse.json(
      { type: "render-failed", title: "Render Failed", status: 500, detail: (err as Error).message },
      { status: 500 },
    );
  }
}
