CREATE TABLE IF NOT EXISTS "crop_census_surveys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "farm_id" uuid NOT NULL REFERENCES "farms"("id"),
  "plot_id" uuid NOT NULL REFERENCES "plots"("id"),
  "task_id" uuid REFERENCES "tasks"("id"),
  "crop_type" text NOT NULL,
  "crop_variety" text,
  "plant_count" integer NOT NULL,
  "min_height" text,
  "max_height" text,
  "avg_height" text,
  "height_unit" text NOT NULL DEFAULT 'cm',
  "sample_size" integer,
  "counting_method" text,
  "condition_notes" text,
  "mortality_notes" text,
  "surveyed_at" timestamptz NOT NULL DEFAULT now(),
  "latitude" text,
  "longitude" text,
  "recorded_by_id" uuid NOT NULL REFERENCES "users"("id"),
  "verification_status" text NOT NULL DEFAULT 'reported',
  "verified_by_id" uuid REFERENCES "users"("id"),
  "verified_at" timestamptz,
  "rejection_reason" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "crop_census_surveys_plant_count_nonneg" CHECK ("plant_count" >= 0),
  CONSTRAINT "crop_census_surveys_height_unit" CHECK ("height_unit" IN ('cm', 'm')),
  CONSTRAINT "crop_census_surveys_verification_status" CHECK (
    "verification_status" IN ('reported', 'verified', 'rejected')
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "crop_census_surveys_plot_crop_idx"
  ON "crop_census_surveys" ("farm_id", "plot_id", "crop_type", "surveyed_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "crop_census_surveys_status_idx"
  ON "crop_census_surveys" ("farm_id", "verification_status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crop_census_evidence" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "survey_id" uuid NOT NULL REFERENCES "crop_census_surveys"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "evidence_url" text NOT NULL,
  "created_by_id" uuid NOT NULL REFERENCES "users"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "crop_census_evidence_kind" CHECK ("kind" IN ('photo', 'voice'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "crop_census_evidence_survey_idx"
  ON "crop_census_evidence" ("survey_id");
