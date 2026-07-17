ALTER TABLE "plots" ADD COLUMN IF NOT EXISTS "code" text;
ALTER TABLE "plots" ADD COLUMN IF NOT EXISTS "notes" text;
ALTER TABLE "plots" ADD COLUMN IF NOT EXISTS "latitude" text;
ALTER TABLE "plots" ADD COLUMN IF NOT EXISTS "longitude" text;
ALTER TABLE "plots" ADD COLUMN IF NOT EXISTS "boundary_geojson" jsonb;
ALTER TABLE "plots" ADD COLUMN IF NOT EXISTS "active" boolean NOT NULL DEFAULT true;
ALTER TABLE "plots" ADD COLUMN IF NOT EXISTS "archived_at" timestamptz;
ALTER TABLE "plots" ADD COLUMN IF NOT EXISTS "updated_at" timestamptz NOT NULL DEFAULT now();

-- Ensure every farm with orphaned plots has a fallback zone, then attach them.
INSERT INTO "zones" ("id", "farm_id", "name", "description", "created_at")
SELECT gen_random_uuid(), p.farm_id, 'Unassigned', 'Auto-created for blocks without a zone', now()
FROM (
  SELECT DISTINCT farm_id
  FROM plots
  WHERE zone_id IS NULL
) p
WHERE NOT EXISTS (
  SELECT 1 FROM zones z
  WHERE z.farm_id = p.farm_id AND z.name = 'Unassigned'
);

UPDATE plots pl
SET zone_id = z.id
FROM zones z
WHERE pl.zone_id IS NULL
  AND z.farm_id = pl.farm_id
  AND z.name = 'Unassigned';

-- Repair dangling zone references via the same fallback.
UPDATE plots pl
SET zone_id = z.id
FROM zones z
WHERE pl.zone_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM zones z2 WHERE z2.id = pl.zone_id)
  AND z.farm_id = pl.farm_id
  AND z.name = 'Unassigned';

ALTER TABLE "plots" ALTER COLUMN "zone_id" SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'plots_zone_id_zones_id_fk'
  ) THEN
    ALTER TABLE "plots"
      ADD CONSTRAINT "plots_zone_id_zones_id_fk"
      FOREIGN KEY ("zone_id") REFERENCES "zones"("id");
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "plots_farm_zone_active_idx"
  ON "plots" ("farm_id", "zone_id", "active");

CREATE UNIQUE INDEX IF NOT EXISTS "plots_farm_zone_code_uq"
  ON "plots" ("farm_id", "zone_id", "code")
  WHERE "code" IS NOT NULL AND "active" = true;
