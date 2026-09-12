-- ──────────────────────────────────────────────
-- Phase 4.2: SaaS billing mechanics
--
--   tenants.gstin          — the school's GSTIN, printed on our tax invoices
--                            for their input credit (BUILD_PLAN 4.2.2)
--   saas_invoices.*        — tax-invoice numbering, GST breakdown, SAC code,
--                            period, seats, paid timestamp
--   usage_records          — metering: students / staff / storage / credits
--                            (4.2.4)
--   dunning_events         — reminders → grace → suspension → churn trail,
--                            with next-stage timestamps (4.2.3)
-- Additive only. Reversible by DROP COLUMN / DROP TABLE.
-- ──────────────────────────────────────────────

ALTER TABLE "tenants" ADD COLUMN "gstin" TEXT;

ALTER TABLE "saas_invoices" ADD COLUMN "invoiceNo" TEXT;
ALTER TABLE "saas_invoices" ADD COLUMN "periodStart" TIMESTAMP(3);
ALTER TABLE "saas_invoices" ADD COLUMN "periodEnd" TIMESTAMP(3);
ALTER TABLE "saas_invoices" ADD COLUMN "seats" INTEGER;
ALTER TABLE "saas_invoices" ADD COLUMN "pricePerStudent" DECIMAL(10,2);
ALTER TABLE "saas_invoices" ADD COLUMN "gstRate" DECIMAL(5,2) NOT NULL DEFAULT 18;
ALTER TABLE "saas_invoices" ADD COLUMN "sacCode" TEXT NOT NULL DEFAULT '997331';
ALTER TABLE "saas_invoices" ADD COLUMN "supplierGstin" TEXT;
ALTER TABLE "saas_invoices" ADD COLUMN "paidAt" TIMESTAMP(3);
CREATE UNIQUE INDEX "saas_invoices_invoiceNo_key" ON "saas_invoices"("invoiceNo");

CREATE TABLE "usage_records" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "value" BIGINT NOT NULL DEFAULT 0,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_records_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "usage_records_tenantId_metric_capturedAt_idx" ON "usage_records"("tenantId", "metric", "capturedAt");
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "dunning_events" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "channel" TEXT,
    "message" TEXT,
    "nextStageAt" TIMESTAMP(3),
    "actor" TEXT NOT NULL DEFAULT 'system',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dunning_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "dunning_events_tenantId_createdAt_idx" ON "dunning_events"("tenantId", "createdAt");
ALTER TABLE "dunning_events" ADD CONSTRAINT "dunning_events_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
