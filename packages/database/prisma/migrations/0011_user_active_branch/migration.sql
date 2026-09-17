-- ──────────────────────────────────────────────
-- Phase: multi-branch access — the active-branch pointer
--
-- A token's branchId was pinned by "first branch-scoped role assignment wins"
-- at login. An owner with roles in several branches could never actually enter
-- the second one. `activeBranchId` is the explicit override:
--
--   NULL  → behave exactly as before (role assignment, then defaultBranchId)
--   set   → that branch is where this session lives, subject to one rule:
--           the user must hold a role assignment there (any role, or one of
--           their school-wide roles covers every branch)
--
-- Writable only through POST /auth/switch-branch, which enforces that rule —
-- never raw SQL from the client.
-- ──────────────────────────────────────────────

ALTER TABLE "users"
  ADD COLUMN "activeBranchId" TEXT;

ALTER TABLE "users"
  ADD CONSTRAINT "users_activeBranchId_fkey"
  FOREIGN KEY ("activeBranchId") REFERENCES "branches"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
