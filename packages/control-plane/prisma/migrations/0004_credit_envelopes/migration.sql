-- ──────────────────────────────────────────────
-- Messaging credit envelope (BUILD_PLAN 5.7)
--
-- One row per tenant. The balance IS the row: the dispatcher decrements it
-- per send (cost-carrying channels only), top-ups increment it. Lives in
-- the control plane so billing is ours — a tenant can never touch it.
-- ──────────────────────────────────────────────

CREATE TABLE "credit_envelopes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "balance" INTEGER NOT NULL DEFAULT 0,
    "purchased" INTEGER NOT NULL DEFAULT 0,
    "lowBalanceAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "credit_envelopes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "credit_envelopes_tenantId_key" ON "credit_envelopes"("tenantId");

ALTER TABLE "credit_envelopes" ADD CONSTRAINT "credit_envelopes_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
