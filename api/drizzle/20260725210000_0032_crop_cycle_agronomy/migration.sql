-- Crop lifecycles move out of the code and onto the farm, the same way poultry
-- agronomy did in 0031.
--
-- `lib/crop-lifecycle.ts` held two literals — PLANTAIN_LIFECYCLE and
-- COCONUT_LIFECYCLE — carrying stage durations and suggested work for every farm
-- growing either crop. A farm on different soil, a different variety or a
-- different planting season had no way to correct them, and a farm growing
-- anything else got no lifecycle at all.
--
-- Nothing is backfilled. A cycle with no rows has no lifecycle established, and
-- the callers treat that as "unknown" rather than substituting the old figures,
-- because copying them in would relabel a generic guess as this farm's own plan.

CREATE TABLE IF NOT EXISTS "crop_cycle_stages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "farm_id" uuid NOT NULL REFERENCES "farms"("id"),
  "crop_cycle_id" uuid NOT NULL REFERENCES "crop_cycles"("id") ON DELETE CASCADE,
  "stage" "crop_stage" NOT NULL,
  "sequence" integer NOT NULL,
  "duration_days" integer NOT NULL,
  "source" "agronomy_source" DEFAULT 'generated' NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);

-- A cycle cannot be in the same stage twice, and a duplicate row would
-- double-count toward the expected harvest date.
CREATE UNIQUE INDEX IF NOT EXISTS "crop_cycle_stages_cycle_stage_key"
  ON "crop_cycle_stages" ("crop_cycle_id", "stage");

CREATE INDEX IF NOT EXISTS "crop_cycle_stages_cycle_seq_idx"
  ON "crop_cycle_stages" ("crop_cycle_id", "sequence");

CREATE TABLE IF NOT EXISTS "crop_cycle_tasks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "farm_id" uuid NOT NULL REFERENCES "farms"("id"),
  "crop_cycle_id" uuid NOT NULL REFERENCES "crop_cycles"("id") ON DELETE CASCADE,
  "stage" "crop_stage" NOT NULL,
  -- Counted from the day the stage is entered, not from planting, so a stage
  -- that runs long does not drag its work out of order behind it.
  "offset_days" integer NOT NULL,
  "template_name" text NOT NULL,
  "description" text,
  "default_duration_hours" integer,
  "source" "agronomy_source" DEFAULT 'generated' NOT NULL,
  "source_locale" text,
  "translation_status" "translation_status" DEFAULT 'done' NOT NULL,
  "translation_attempts" integer DEFAULT 0 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "crop_cycle_tasks_cycle_stage_idx"
  ON "crop_cycle_tasks" ("crop_cycle_id", "stage", "offset_days");

-- Partial, like the other retry indexes: the job only looks for rows that still
-- owe a translation, and those are a small minority.
CREATE INDEX IF NOT EXISTS "crop_cycle_tasks_pending_idx"
  ON "crop_cycle_tasks" ("farm_id")
  WHERE "translation_status" <> 'done';
