-- ──────────────────────────────────────────────
-- Report builder & scheduled delivery (BUILD_PLAN 7.1)
--
-- Three tables: the saved spec, its schedule, and one row per delivery
-- carrying the rendered snapshot plus the hashed download token. Tokens are
-- hashed at rest (sha256) — the plaintext only ever travels in the sent
-- message, so a database leak cannot be replayed into a report download.
--
-- Nothing here is written by the analytics service except reports and their
-- own delivery bookkeeping: it reads school data and never mutates it.
-- ──────────────────────────────────────────────

-- CreateEnum
CREATE TYPE "ReportFormat" AS ENUM ('XLSX', 'PDF');

-- CreateEnum
CREATE TYPE "ReportCadence" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY');

-- CreateEnum
CREATE TYPE "ReportDeliveryStatus" AS ENUM ('STORED', 'DELIVERED', 'FAILED');

-- CreateTable
CREATE TABLE "saved_reports" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "format" "ReportFormat" NOT NULL DEFAULT 'XLSX',
    "filters" JSONB NOT NULL DEFAULT '{}',
    "createdBy" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "saved_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_schedules" (
    "id" TEXT NOT NULL,
    "savedReportId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "cadence" "ReportCadence" NOT NULL,
    "hourLocal" INTEGER NOT NULL DEFAULT 7,
    "dayOfWeek" INTEGER,
    "dayOfMonth" INTEGER,
    "channel" "NotificationChannel" NOT NULL DEFAULT 'EMAIL',
    "targetRoles" TEXT[],
    "recipients" TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "nextRunAt" TIMESTAMP(3) NOT NULL,
    "lastRunAt" TIMESTAMP(3),
    "lastStatus" TEXT,
    "lastError" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_deliveries" (
    "id" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "format" "ReportFormat" NOT NULL,
    "fileName" TEXT NOT NULL,
    "artifact" BYTEA NOT NULL,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "status" "ReportDeliveryStatus" NOT NULL DEFAULT 'STORED',
    "recipients" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "downloads" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "saved_reports_branchId_isActive_idx" ON "saved_reports"("branchId", "isActive");

-- CreateIndex
CREATE INDEX "report_schedules_isActive_nextRunAt_idx" ON "report_schedules"("isActive", "nextRunAt");

-- CreateIndex
CREATE INDEX "report_schedules_branchId_idx" ON "report_schedules"("branchId");

-- CreateIndex
CREATE INDEX "report_deliveries_branchId_createdAt_idx" ON "report_deliveries"("branchId", "createdAt");

-- CreateIndex
CREATE INDEX "report_deliveries_expiresAt_idx" ON "report_deliveries"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "report_deliveries_tokenHash_key" ON "report_deliveries"("tokenHash");

-- AddForeignKey
ALTER TABLE "report_schedules" ADD CONSTRAINT "report_schedules_savedReportId_fkey" FOREIGN KEY ("savedReportId") REFERENCES "saved_reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_deliveries" ADD CONSTRAINT "report_deliveries_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "report_schedules"("id") ON DELETE CASCADE ON UPDATE CASCADE;
