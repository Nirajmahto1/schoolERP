-- ──────────────────────────────────────────────
-- Branch geofence as a bounding box (replaces center+radius).
-- The ERP form provides two latitudes and two longitudes; the attendance
-- self-mark accepts a position only when it is equal to or between the
-- bounds on both axes. min/max are normalized on write.
-- ──────────────────────────────────────────────

ALTER TABLE "branches"
  ADD COLUMN IF NOT EXISTS "minLatitude"  DECIMAL(10,7),
  ADD COLUMN IF NOT EXISTS "maxLatitude"  DECIMAL(10,7),
  ADD COLUMN IF NOT EXISTS "minLongitude" DECIMAL(10,7),
  ADD COLUMN IF NOT EXISTS "maxLongitude" DECIMAL(10,7);

-- Migrate any existing center+radius fence to an equivalent box (best effort
-- for deployments that already configured one; ~1 degree ≈ 111 km / 111000 m).
UPDATE "branches"
SET "minLatitude"  = "latitude"  - ("geofenceRadius" / 111000.0),
    "maxLatitude"  = "latitude"  + ("geofenceRadius" / 111000.0),
    "minLongitude" = "longitude" - ("geofenceRadius" / (111000.0 * GREATEST(COS(RADIANS("latitude")), 0.01))),
    "maxLongitude" = "longitude" + ("geofenceRadius" / (111000.0 * GREATEST(COS(RADIANS("latitude")), 0.01)))
WHERE "latitude" IS NOT NULL AND "longitude" IS NOT NULL AND "geofenceRadius" IS NOT NULL
  AND "minLatitude" IS NULL;

ALTER TABLE "branches"
  DROP COLUMN IF EXISTS "latitude",
  DROP COLUMN IF EXISTS "longitude",
  DROP COLUMN IF EXISTS "geofenceRadius";
