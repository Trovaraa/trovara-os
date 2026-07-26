-- Extend content-locale provenance beyond the five tables in 0028.
-- Additive only: existing rows default to translation_status = 'done' and
-- translation_attempts = 0. Partial indexes match the retry job's
-- `translation_status <> 'done'` predicate.
--> statement-breakpoint
-- Tables that already received source_locale + translation_status in 0028.
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "translation_attempts" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "livestock_logs" ADD COLUMN IF NOT EXISTS "translation_attempts" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "attendance_sessions" ADD COLUMN IF NOT EXISTS "translation_attempts" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "crop_census_surveys" ADD COLUMN IF NOT EXISTS "translation_attempts" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "action_drafts" ADD COLUMN IF NOT EXISTS "translation_attempts" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- Remaining prose tables: locale pair + attempt counter.
ALTER TABLE "task_templates" ADD COLUMN IF NOT EXISTS "source_locale" text;
--> statement-breakpoint
ALTER TABLE "task_templates" ADD COLUMN IF NOT EXISTS "translation_status" "translation_status" DEFAULT 'done' NOT NULL;
--> statement-breakpoint
ALTER TABLE "task_templates" ADD COLUMN IF NOT EXISTS "translation_attempts" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "zones" ADD COLUMN IF NOT EXISTS "source_locale" text;
--> statement-breakpoint
ALTER TABLE "zones" ADD COLUMN IF NOT EXISTS "translation_status" "translation_status" DEFAULT 'done' NOT NULL;
--> statement-breakpoint
ALTER TABLE "zones" ADD COLUMN IF NOT EXISTS "translation_attempts" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "plots" ADD COLUMN IF NOT EXISTS "source_locale" text;
--> statement-breakpoint
ALTER TABLE "plots" ADD COLUMN IF NOT EXISTS "translation_status" "translation_status" DEFAULT 'done' NOT NULL;
--> statement-breakpoint
ALTER TABLE "plots" ADD COLUMN IF NOT EXISTS "translation_attempts" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD COLUMN IF NOT EXISTS "source_locale" text;
--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD COLUMN IF NOT EXISTS "translation_status" "translation_status" DEFAULT 'done' NOT NULL;
--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD COLUMN IF NOT EXISTS "translation_attempts" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "source_locale" text;
--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "translation_status" "translation_status" DEFAULT 'done' NOT NULL;
--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "translation_attempts" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN IF NOT EXISTS "source_locale" text;
--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN IF NOT EXISTS "translation_status" "translation_status" DEFAULT 'done' NOT NULL;
--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN IF NOT EXISTS "translation_attempts" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD COLUMN IF NOT EXISTS "source_locale" text;
--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD COLUMN IF NOT EXISTS "translation_status" "translation_status" DEFAULT 'done' NOT NULL;
--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD COLUMN IF NOT EXISTS "translation_attempts" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "crop_cycles" ADD COLUMN IF NOT EXISTS "source_locale" text;
--> statement-breakpoint
ALTER TABLE "crop_cycles" ADD COLUMN IF NOT EXISTS "translation_status" "translation_status" DEFAULT 'done' NOT NULL;
--> statement-breakpoint
ALTER TABLE "crop_cycles" ADD COLUMN IF NOT EXISTS "translation_attempts" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "advisory_observations" ADD COLUMN IF NOT EXISTS "source_locale" text;
--> statement-breakpoint
ALTER TABLE "advisory_observations" ADD COLUMN IF NOT EXISTS "translation_status" "translation_status" DEFAULT 'done' NOT NULL;
--> statement-breakpoint
ALTER TABLE "advisory_observations" ADD COLUMN IF NOT EXISTS "translation_attempts" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "livestock_batches" ADD COLUMN IF NOT EXISTS "source_locale" text;
--> statement-breakpoint
ALTER TABLE "livestock_batches" ADD COLUMN IF NOT EXISTS "translation_status" "translation_status" DEFAULT 'done' NOT NULL;
--> statement-breakpoint
ALTER TABLE "livestock_batches" ADD COLUMN IF NOT EXISTS "translation_attempts" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "harvest_lots" ADD COLUMN IF NOT EXISTS "source_locale" text;
--> statement-breakpoint
ALTER TABLE "harvest_lots" ADD COLUMN IF NOT EXISTS "translation_status" "translation_status" DEFAULT 'done' NOT NULL;
--> statement-breakpoint
ALTER TABLE "harvest_lots" ADD COLUMN IF NOT EXISTS "translation_attempts" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "source_locale" text;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "translation_status" "translation_status" DEFAULT 'done' NOT NULL;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "translation_attempts" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD COLUMN IF NOT EXISTS "source_locale" text;
--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD COLUMN IF NOT EXISTS "translation_status" "translation_status" DEFAULT 'done' NOT NULL;
--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD COLUMN IF NOT EXISTS "translation_attempts" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "source_locale" text;
--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "translation_status" "translation_status" DEFAULT 'done' NOT NULL;
--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "translation_attempts" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "asset_events" ADD COLUMN IF NOT EXISTS "source_locale" text;
--> statement-breakpoint
ALTER TABLE "asset_events" ADD COLUMN IF NOT EXISTS "translation_status" "translation_status" DEFAULT 'done' NOT NULL;
--> statement-breakpoint
ALTER TABLE "asset_events" ADD COLUMN IF NOT EXISTS "translation_attempts" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "asset_logs" ADD COLUMN IF NOT EXISTS "source_locale" text;
--> statement-breakpoint
ALTER TABLE "asset_logs" ADD COLUMN IF NOT EXISTS "translation_status" "translation_status" DEFAULT 'done' NOT NULL;
--> statement-breakpoint
ALTER TABLE "asset_logs" ADD COLUMN IF NOT EXISTS "translation_attempts" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "customer_inquiries" ADD COLUMN IF NOT EXISTS "source_locale" text;
--> statement-breakpoint
ALTER TABLE "customer_inquiries" ADD COLUMN IF NOT EXISTS "translation_status" "translation_status" DEFAULT 'done' NOT NULL;
--> statement-breakpoint
ALTER TABLE "customer_inquiries" ADD COLUMN IF NOT EXISTS "translation_attempts" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "source_locale" text;
--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "translation_status" "translation_status" DEFAULT 'done' NOT NULL;
--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "translation_attempts" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "inventory_count_sessions" ADD COLUMN IF NOT EXISTS "source_locale" text;
--> statement-breakpoint
ALTER TABLE "inventory_count_sessions" ADD COLUMN IF NOT EXISTS "translation_status" "translation_status" DEFAULT 'done' NOT NULL;
--> statement-breakpoint
ALTER TABLE "inventory_count_sessions" ADD COLUMN IF NOT EXISTS "translation_attempts" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "inventory_count_lines" ADD COLUMN IF NOT EXISTS "source_locale" text;
--> statement-breakpoint
ALTER TABLE "inventory_count_lines" ADD COLUMN IF NOT EXISTS "translation_status" "translation_status" DEFAULT 'done' NOT NULL;
--> statement-breakpoint
ALTER TABLE "inventory_count_lines" ADD COLUMN IF NOT EXISTS "translation_attempts" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- Partial indexes for the retry job (tasks already indexed in 0028).
CREATE INDEX IF NOT EXISTS "livestock_logs_translation_status_idx"
  ON "livestock_logs" ("translation_status") WHERE "translation_status" <> 'done';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "attendance_sessions_translation_status_idx"
  ON "attendance_sessions" ("translation_status") WHERE "translation_status" <> 'done';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "crop_census_surveys_translation_status_idx"
  ON "crop_census_surveys" ("translation_status") WHERE "translation_status" <> 'done';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "action_drafts_translation_status_idx"
  ON "action_drafts" ("translation_status") WHERE "translation_status" <> 'done';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_templates_translation_status_idx"
  ON "task_templates" ("translation_status") WHERE "translation_status" <> 'done';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "zones_translation_status_idx"
  ON "zones" ("translation_status") WHERE "translation_status" <> 'done';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "plots_translation_status_idx"
  ON "plots" ("translation_status") WHERE "translation_status" <> 'done';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inventory_movements_translation_status_idx"
  ON "inventory_movements" ("translation_status") WHERE "translation_status" <> 'done';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "suppliers_translation_status_idx"
  ON "suppliers" ("translation_status") WHERE "translation_status" <> 'done';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "purchase_orders_translation_status_idx"
  ON "purchase_orders" ("translation_status") WHERE "translation_status" <> 'done';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goods_receipts_translation_status_idx"
  ON "goods_receipts" ("translation_status") WHERE "translation_status" <> 'done';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "crop_cycles_translation_status_idx"
  ON "crop_cycles" ("translation_status") WHERE "translation_status" <> 'done';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "advisory_observations_translation_status_idx"
  ON "advisory_observations" ("translation_status") WHERE "translation_status" <> 'done';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "livestock_batches_translation_status_idx"
  ON "livestock_batches" ("translation_status") WHERE "translation_status" <> 'done';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "harvest_lots_translation_status_idx"
  ON "harvest_lots" ("translation_status") WHERE "translation_status" <> 'done';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_translation_status_idx"
  ON "orders" ("translation_status") WHERE "translation_status" <> 'done';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_refunds_translation_status_idx"
  ON "payment_refunds" ("translation_status") WHERE "translation_status" <> 'done';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assets_translation_status_idx"
  ON "assets" ("translation_status") WHERE "translation_status" <> 'done';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "asset_events_translation_status_idx"
  ON "asset_events" ("translation_status") WHERE "translation_status" <> 'done';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "asset_logs_translation_status_idx"
  ON "asset_logs" ("translation_status") WHERE "translation_status" <> 'done';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_inquiries_translation_status_idx"
  ON "customer_inquiries" ("translation_status") WHERE "translation_status" <> 'done';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "expenses_translation_status_idx"
  ON "expenses" ("translation_status") WHERE "translation_status" <> 'done';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inventory_count_sessions_translation_status_idx"
  ON "inventory_count_sessions" ("translation_status") WHERE "translation_status" <> 'done';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inventory_count_lines_translation_status_idx"
  ON "inventory_count_lines" ("translation_status") WHERE "translation_status" <> 'done';
