-- ──────────────────────────────────────────────
-- §13.2.5: request-demo leads. Public form → control plane → console
-- follow-up workflow. A lead is not yet a school: no tenant relation.
-- ──────────────────────────────────────────────
CREATE TYPE "LeadStatus" AS ENUM ('NEW', 'CONTACTED', 'DEMO_SCHEDULED', 'PILOT', 'WON', 'LOST');
CREATE TABLE "demo_leads" (
    "id" TEXT NOT NULL,
    "school" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "city" TEXT,
    "band" TEXT,
    "notes" TEXT,
    "status" "LeadStatus" NOT NULL DEFAULT 'NEW',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "demo_leads_pkey" PRIMARY KEY ("id")
);
