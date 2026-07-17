ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "tracking_mode" text NOT NULL DEFAULT 'pool';
ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "asset_tag" text;
ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "manufacturer" text;
ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "model" text;
ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "serial_number" text;
ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "acquisition_date" timestamptz;
ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "acquisition_cost_minor" integer;
ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "currency" text DEFAULT 'NGN';
ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "zone_id" uuid REFERENCES "zones"("id");
ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "plot_id" uuid REFERENCES "plots"("id");
ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "location_text" text;
ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "operational_status" text NOT NULL DEFAULT 'operational';
ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "maintenance_interval_days" integer;
ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "next_service_at" timestamptz;
ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "disposed_at" timestamptz;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'assets_tracking_mode_check'
  ) THEN
    ALTER TABLE "assets"
      ADD CONSTRAINT "assets_tracking_mode_check"
      CHECK ("tracking_mode" IN ('pool', 'individual'));
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "asset_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "asset_id" uuid NOT NULL REFERENCES "assets"("id") ON DELETE CASCADE,
  "farm_id" uuid NOT NULL REFERENCES "farms"("id"),
  "event_type" text NOT NULL,
  "event_date" timestamptz NOT NULL DEFAULT now(),
  "cost_minor" integer,
  "notes" text,
  "evidence_url" text,
  "recorded_by_id" uuid NOT NULL REFERENCES "users"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "asset_events_type_check" CHECK (
    "event_type" IN ('service', 'repair', 'inspection', 'transfer', 'disposal')
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "asset_events_asset_idx"
  ON "asset_events" ("asset_id", "event_date" DESC);
--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD COLUMN IF NOT EXISTS "source_type" text;
ALTER TABLE "inventory_movements" ADD COLUMN IF NOT EXISTS "source_id" uuid;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "inventory_movements_source_uq"
  ON "inventory_movements" ("farm_id", "source_type", "source_id")
  WHERE "source_type" IS NOT NULL AND "source_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inventory_count_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "farm_id" uuid NOT NULL REFERENCES "farms"("id"),
  "task_id" uuid REFERENCES "tasks"("id"),
  "location_text" text,
  "status" text NOT NULL DEFAULT 'submitted',
  "recorded_by_id" uuid NOT NULL REFERENCES "users"("id"),
  "verified_by_id" uuid REFERENCES "users"("id"),
  "verified_at" timestamptz,
  "rejection_reason" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "inventory_count_sessions_status_check" CHECK (
    "status" IN ('draft', 'submitted', 'verified', 'rejected')
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inventory_count_sessions_farm_status_idx"
  ON "inventory_count_sessions" ("farm_id", "status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inventory_count_lines" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "session_id" uuid NOT NULL REFERENCES "inventory_count_sessions"("id") ON DELETE CASCADE,
  "item_id" uuid REFERENCES "inventory_items"("id"),
  "item_name" text NOT NULL,
  "category" text NOT NULL DEFAULT 'supplies',
  "unit" text NOT NULL DEFAULT 'units',
  "counted_quantity" integer NOT NULL,
  "notes" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "inventory_count_lines_qty_nonneg" CHECK ("counted_quantity" >= 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inventory_count_lines_session_idx"
  ON "inventory_count_lines" ("session_id");
