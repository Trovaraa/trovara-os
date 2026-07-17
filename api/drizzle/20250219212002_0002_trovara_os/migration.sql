DO $$ BEGIN
  CREATE TYPE "public"."recurrence" AS ENUM('daily', 'weekly', 'monthly', 'crop_stage');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."farm_event_type" AS ENUM('planted', 'watered', 'weeded', 'fertilized', 'harvested', 'fed', 'vaccinated', 'mortality', 'sold', 'moved', 'incident', 'other');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."poultry_batch_type" AS ENUM('broiler', 'layer', 'pullet', 'other');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
ALTER TYPE "expense_category" ADD VALUE IF NOT EXISTS 'feed';
--> statement-breakpoint
ALTER TYPE "expense_category" ADD VALUE IF NOT EXISTS 'medicine';
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "user_agent" text;
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "ip_hash" text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "zones" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "farm_id" uuid NOT NULL REFERENCES "farms"("id"),
  "name" text NOT NULL,
  "description" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "plots" ADD COLUMN IF NOT EXISTS "zone_id" uuid;
--> statement-breakpoint
ALTER TABLE "plots" ADD COLUMN IF NOT EXISTS "crop_variety" text;
--> statement-breakpoint
ALTER TABLE "plots" ADD COLUMN IF NOT EXISTS "plant_count" integer;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "planting_units" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "farm_id" uuid NOT NULL REFERENCES "farms"("id"),
  "plot_id" uuid NOT NULL REFERENCES "plots"("id"),
  "label" text NOT NULL,
  "unit_type" text NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "planted_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "task_templates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "farm_id" uuid NOT NULL REFERENCES "farms"("id"),
  "name" text NOT NULL,
  "description" text,
  "crop_type" text,
  "checklist" jsonb,
  "default_duration_hours" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "recurring_schedules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "farm_id" uuid NOT NULL REFERENCES "farms"("id"),
  "template_id" uuid NOT NULL REFERENCES "task_templates"("id"),
  "recurrence" "recurrence" NOT NULL,
  "assigned_to_id" uuid REFERENCES "users"("id"),
  "plot_id" uuid REFERENCES "plots"("id"),
  "active" boolean DEFAULT true NOT NULL,
  "next_run_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "farm_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "farm_id" uuid NOT NULL REFERENCES "farms"("id"),
  "actor_user_id" uuid REFERENCES "users"("id"),
  "entity_type" text NOT NULL,
  "entity_id" text NOT NULL,
  "event_type" "farm_event_type" NOT NULL,
  "before_value" jsonb,
  "after_value" jsonb,
  "source" text DEFAULT 'web' NOT NULL,
  "approval_status" text,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "template_id" uuid REFERENCES "task_templates"("id");
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "photo_url" text;
--> statement-breakpoint
ALTER TABLE "inventory_items" ADD COLUMN IF NOT EXISTS "cost_per_unit" integer;
--> statement-breakpoint
ALTER TABLE "inventory_items" ADD COLUMN IF NOT EXISTS "supplier" text;
--> statement-breakpoint
ALTER TABLE "inventory_items" ADD COLUMN IF NOT EXISTS "expiry_date" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "inventory_items" ADD COLUMN IF NOT EXISTS "storage_location" text;
--> statement-breakpoint
ALTER TABLE "inventory_items" ADD COLUMN IF NOT EXISTS "batch_number" text;
--> statement-breakpoint
ALTER TABLE "livestock_batches" ADD COLUMN IF NOT EXISTS "batch_type" "poultry_batch_type";
--> statement-breakpoint
ALTER TABLE "livestock_batches" ADD COLUMN IF NOT EXISTS "start_count" integer;
--> statement-breakpoint
ALTER TABLE "livestock_batches" ADD COLUMN IF NOT EXISTS "feed_used_kg" integer DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "livestock_batches" ADD COLUMN IF NOT EXISTS "target_closeout_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "vendor" text;
--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "receipt_ref" text;
--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "approval_status" text DEFAULT 'approved' NOT NULL;
