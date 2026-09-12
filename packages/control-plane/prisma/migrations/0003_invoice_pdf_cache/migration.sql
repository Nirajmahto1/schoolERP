-- ──────────────────────────────────────────────
-- Tax-invoice PDF cache (BUILD_PLAN 4.2.2)
--
-- SaasInvoice.invoicePdf holds the cached base64 PDF text. Re-downloads
-- serve the stored document; { regenerate: true } rebuilds after a
-- correction. Nullable — invoices without a rendered PDF are normal.
-- String (TEXT), matching Payment.receiptPdf in the tenant DB.
-- ──────────────────────────────────────────────

ALTER TABLE "saas_invoices" DROP COLUMN IF EXISTS "invoicePdf";
ALTER TABLE "saas_invoices" ADD COLUMN "invoicePdf" TEXT;
