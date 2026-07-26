-- Noiler rename, and the move of poultry agronomy out of the code and onto the farm.
--
-- Two changes that have to land together: renaming the enum member is what makes
-- the hardcoded broiler calendar visibly wrong, and the tables below are where
-- the replacement lives.

-- 1. The farm keeps Noilers, not broilers. RENAME VALUE rewrites every existing
-- row's label in place, so no data migration is needed and no row is stranded on
-- a value the enum no longer defines. Reversible by renaming back.
ALTER TYPE "public"."poultry_batch_type" RENAME VALUE 'broiler' TO 'noiler';

DO $$ BEGIN
  CREATE TYPE "public"."agronomy_source" AS ENUM('generated', 'manual');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- 2. Growth expectation per batch, replacing CHICK_START_WEIGHT_KG /
-- BROILER_TARGET_WEIGHT_KG / BROILER_DAILY_GAIN_KG in routes/livestock.ts.
--
-- All nullable and left null for existing rows on purpose. A null curve means
-- nobody has established one for that batch, and the route withholds the weight
-- estimate rather than showing a broiler's 2.5 kg for a bird that will never
-- reach it. Backfilling the old constants here would relabel a wrong number as
-- this farm's own figure, which is the thing being fixed.
ALTER TABLE "livestock_batches" ADD COLUMN IF NOT EXISTS "start_weight_kg" numeric(6, 3);
ALTER TABLE "livestock_batches" ADD COLUMN IF NOT EXISTS "target_weight_kg" numeric(6, 3);
ALTER TABLE "livestock_batches" ADD COLUMN IF NOT EXISTS "daily_gain_kg" numeric(6, 4);
ALTER TABLE "livestock_batches" ADD COLUMN IF NOT EXISTS "cycle_days" integer;
ALTER TABLE "livestock_batches" ADD COLUMN IF NOT EXISTS "agronomy_source" "agronomy_source";

-- 3. The vaccination and husbandry calendar, per batch, replacing
-- BROILER_VACCINATION_SCHEDULE. Generated once from the species the farmer
-- entered, then owned by the farm: editable and deletable.
--
-- ON DELETE CASCADE because a schedule has no meaning without its batch.
--
-- `name` and `vaccine` are prose and carry the same locale pair as every other
-- free-text column (migration 0029), so a calendar generated in English reads
-- back in the worker's language and the retry job can repair it.
CREATE TABLE IF NOT EXISTS "livestock_schedule_entries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "farm_id" uuid NOT NULL REFERENCES "farms"("id"),
  "batch_id" uuid NOT NULL REFERENCES "livestock_batches"("id") ON DELETE CASCADE,
  "day_offset" integer NOT NULL,
  "name" text NOT NULL,
  "vaccine" text,
  "source" "agronomy_source" DEFAULT 'generated' NOT NULL,
  "source_locale" text,
  "translation_status" "translation_status" DEFAULT 'done' NOT NULL,
  "translation_attempts" integer DEFAULT 0 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "livestock_schedule_batch_day_idx"
  ON "livestock_schedule_entries" ("batch_id", "day_offset");

-- Partial, like the other retry indexes: the job only ever looks for rows that
-- still owe a translation, and those are a small minority.
CREATE INDEX IF NOT EXISTS "livestock_schedule_pending_idx"
  ON "livestock_schedule_entries" ("farm_id")
  WHERE "translation_status" <> 'done';
