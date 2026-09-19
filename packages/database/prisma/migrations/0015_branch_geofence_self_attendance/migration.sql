-- ──────────────────────────────────────────────
-- Staff self-attendance geofencing (Phase: mobile self-mark)
--
-- Branches gain an optional GPS fence (lat/lng/radius meters) set from the
-- ERP branch form; staff self-marks are accepted only from inside it.
-- StaffAttendance rows made through self-service record the server clock
-- time (markedAt) and the reported coordinates for audit — device clocks
-- and mock locations are never trusted.
-- ──────────────────────────────────────────────

ALTER TABLE "branches"
  ADD COLUMN "latitude"       DECIMAL(10,7),
  ADD COLUMN "longitude"      DECIMAL(10,7),
  ADD COLUMN "geofenceRadius" INTEGER;

ALTER TABLE "staff_attendances"
  ADD COLUMN "markedAt"  TIMESTAMP(3),
  ADD COLUMN "latitude"  DECIMAL(10,7),
  ADD COLUMN "longitude" DECIMAL(10,7);
