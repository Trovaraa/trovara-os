-- Trovara OS Advisory: recommendations audit log, daily observations, crop stageEnteredAt
CREATE TYPE "public"."advisory_recommendation_status" AS ENUM(
  'pending',
  'notified',
  'accepted',
  'ignored',
  'completed'
);
--> statement-breakpoint
CREATE TYPE "public"."advisory_source_type" AS ENUM(
  'crop_cycle',
  'livestock_batch',
  'weather',
  'farm'
);
--> statement-breakpoint
ALTER TABLE "crop_cycles" ADD COLUMN IF NOT EXISTS "stage_entered_at" timestamp with time zone;
--> statement-breakpoint
UPDATE "crop_cycles"
SET "stage_entered_at" = "planted_at"
WHERE "stage_entered_at" IS NULL;
--> statement-breakpoint
ALTER TABLE "crop_cycles" ALTER COLUMN "stage_entered_at" SET NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "advisory_recommendations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "farm_id" uuid NOT NULL,
  "rule_key" text NOT NULL,
  "source_type" "advisory_source_type" NOT NULL,
  "source_id" text NOT NULL,
  "status" "advisory_recommendation_status" DEFAULT 'pending' NOT NULL,
  "notify_roles" text[] DEFAULT ARRAY[]::text[] NOT NULL,
  "payload" jsonb NOT NULL,
  "ai_summary" text,
  "fired_at" timestamp with time zone DEFAULT now() NOT NULL,
  "resolved_at" timestamp with time zone,
  "resolved_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "advisory_recommendations_farm_source_rule_uq"
  ON "advisory_recommendations" ("farm_id", "source_id", "rule_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "advisory_recommendations_farm_status_idx"
  ON "advisory_recommendations" ("farm_id", "status");
--> statement-breakpoint
ALTER TABLE "advisory_recommendations"
  ADD CONSTRAINT "advisory_recommendations_farm_id_farms_id_fk"
  FOREIGN KEY ("farm_id") REFERENCES "public"."farms"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "advisory_recommendations"
  ADD CONSTRAINT "advisory_recommendations_resolved_by_users_id_fk"
  FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "advisory_observations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "farm_id" uuid NOT NULL,
  "logged_at" timestamp with time zone DEFAULT now() NOT NULL,
  "source_type" "advisory_source_type",
  "source_id" text,
  "tiles" text[] DEFAULT ARRAY[]::text[] NOT NULL,
  "note" text,
  "created_by" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "advisory_observations_farm_logged_idx"
  ON "advisory_observations" ("farm_id", "logged_at");
--> statement-breakpoint
ALTER TABLE "advisory_observations"
  ADD CONSTRAINT "advisory_observations_farm_id_farms_id_fk"
  FOREIGN KEY ("farm_id") REFERENCES "public"."farms"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "advisory_observations"
  ADD CONSTRAINT "advisory_observations_created_by_users_id_fk"
  FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
