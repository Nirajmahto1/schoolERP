-- ──────────────────────────────────────────────
-- Tax invoice fields per Rule 46, CGST Rules 2017 (Phase 4, Indian law)
--
-- A tax invoice MUST show: supplier legal name + address + GSTIN, recipient
-- legal name + address + GSTIN (if registered), HS/SAC code, taxable value,
-- CGST+SGST or IGST amounts (rate-wise), place of supply, whether tax is
-- payable on reverse charge, invoice number + date, and amount in words.
-- The existing columns already cover SAC, invoice number, and totals; these
-- columns carry the rest. CGST/SGST/IGST are stored explicitly because a
-- school's accountant files GSTR-2B claims per head — one lump "gstAmount"
-- is not filing material.
-- ──────────────────────────────────────────────

ALTER TABLE "saas_invoices"
  ADD COLUMN "supplierName"  TEXT,
  ADD COLUMN "supplierAddress" TEXT,
  ADD COLUMN "recipientName"   TEXT,
  ADD COLUMN "recipientAddress" TEXT,
  ADD COLUMN "cgstAmount"      DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN "sgstAmount"      DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN "igstAmount"      DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN "placeOfSupply"   TEXT,
  ADD COLUMN "reverseCharge"   BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "amountInWords"   TEXT,
  ADD COLUMN "issuedAt"        TIMESTAMP(3);

-- Customers are unregistered ("B2C"): most schools are not GST-registered,
-- and supplies to unregistered persons do not require a recipient GSTIN.
-- The registration-status marker keeps the invoice self-documenting for the
-- CA who files the return.
ALTER TABLE "tenants" ADD COLUMN "isGstRegistered" BOOLEAN NOT NULL DEFAULT false;
