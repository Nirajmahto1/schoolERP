-- ──────────────────────────────────────────────
-- §13.4.2: support-grant activation lifecycle.
--
-- Grants were creatable but inert — nothing redeemed them into actual
-- time-boxed access. A grant now carries a one-time activation code, stored
-- ONLY as a SHA-256 hash (the plaintext is shown once in the console and
-- never persists), plus usedAt (single-use proof) and revokedAt (the school
-- can demand mid-window revocation — and we can do it in seconds).
-- ──────────────────────────────────────────────
ALTER TABLE "support_grants" ADD COLUMN "codeHash" TEXT;
ALTER TABLE "support_grants" ADD COLUMN "revokedAt" TIMESTAMP(3);
ALTER TABLE "support_grants" ADD COLUMN "usedAt" TIMESTAMP(3);
CREATE UNIQUE INDEX "support_grants_codeHash_key" ON "support_grants"("codeHash");
