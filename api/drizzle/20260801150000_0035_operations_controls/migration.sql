ALTER TABLE "attendance_sessions"
  ADD COLUMN IF NOT EXISTS "work_summary" text;

ALTER TABLE "products"
  ADD COLUMN IF NOT EXISTS "sku" text;

UPDATE "products"
SET "sku" = 'PRD-' || upper(substr(replace("id"::text, '-', ''), 1, 8))
WHERE "sku" IS NULL OR btrim("sku") = '';

ALTER TABLE "products"
  ALTER COLUMN "sku" SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "products_farm_sku_uq"
  ON "products" ("farm_id", "sku");

ALTER TABLE "inventory_items"
  ADD COLUMN IF NOT EXISTS "sku" text,
  ADD COLUMN IF NOT EXISTS "variance_tolerance" integer DEFAULT 0 NOT NULL;

UPDATE "inventory_items"
SET "sku" = 'INV-' || upper(substr(replace("id"::text, '-', ''), 1, 8))
WHERE "sku" IS NULL OR btrim("sku") = '';

ALTER TABLE "inventory_items"
  ALTER COLUMN "sku" SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "inventory_items_farm_sku_uq"
  ON "inventory_items" ("farm_id", "sku");

ALTER TABLE "harvest_lots"
  ADD COLUMN IF NOT EXISTS "product_id" uuid REFERENCES "products"("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "harvest_lots_product_id_idx"
  ON "harvest_lots" ("product_id");

ALTER TABLE "inventory_count_sessions"
  ADD COLUMN IF NOT EXISTS "has_variance" boolean DEFAULT false NOT NULL;

ALTER TABLE "inventory_count_lines"
  ADD COLUMN IF NOT EXISTS "expected_quantity" integer,
  ADD COLUMN IF NOT EXISTS "variance" integer;

CREATE TABLE IF NOT EXISTS "field_reports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "farm_id" uuid NOT NULL REFERENCES "farms"("id") ON DELETE CASCADE,
  "created_by_id" uuid NOT NULL REFERENCES "users"("id"),
  "category" text NOT NULL,
  "severity" text NOT NULL DEFAULT 'normal',
  "description" text NOT NULL,
  "plot_id" uuid REFERENCES "plots"("id") ON DELETE SET NULL,
  "batch_id" uuid REFERENCES "livestock_batches"("id") ON DELETE SET NULL,
  "asset_id" uuid REFERENCES "assets"("id") ON DELETE SET NULL,
  "photo_url" text,
  "status" text NOT NULL DEFAULT 'open',
  "assigned_to_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "resolved_by_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "resolved_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "field_reports_farm_status_created_idx"
  ON "field_reports" ("farm_id", "status", "created_at");

CREATE TABLE IF NOT EXISTS "customer_support_tickets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "farm_id" uuid NOT NULL REFERENCES "farms"("id") ON DELETE CASCADE,
  "reference" text NOT NULL,
  "contact_id" uuid REFERENCES "customer_contacts"("id") ON DELETE SET NULL,
  "order_id" uuid REFERENCES "orders"("id") ON DELETE SET NULL,
  "channel" text NOT NULL DEFAULT 'staff',
  "category" text NOT NULL DEFAULT 'complaint',
  "priority" text NOT NULL DEFAULT 'normal',
  "status" text NOT NULL DEFAULT 'open',
  "description" text NOT NULL,
  "assigned_to_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "resolved_by_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "resolved_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "customer_support_tickets_farm_reference_uq"
  ON "customer_support_tickets" ("farm_id", "reference");

CREATE INDEX IF NOT EXISTS "customer_support_tickets_farm_status_created_idx"
  ON "customer_support_tickets" ("farm_id", "status", "created_at");

CREATE TABLE IF NOT EXISTS "inventory_reconciliation_alerts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "farm_id" uuid NOT NULL REFERENCES "farms"("id") ON DELETE CASCADE,
  "session_id" uuid NOT NULL REFERENCES "inventory_count_sessions"("id") ON DELETE CASCADE,
  "line_id" uuid NOT NULL REFERENCES "inventory_count_lines"("id") ON DELETE CASCADE,
  "item_id" uuid NOT NULL REFERENCES "inventory_items"("id") ON DELETE CASCADE,
  "sku" text NOT NULL,
  "expected_quantity" integer NOT NULL,
  "counted_quantity" integer NOT NULL,
  "variance" integer NOT NULL,
  "tolerance" integer DEFAULT 0 NOT NULL,
  "status" text DEFAULT 'open' NOT NULL,
  "acknowledged_by_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "acknowledged_at" timestamp with time zone,
  "resolved_by_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "resolved_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "inventory_reconciliation_alerts_line_uq"
  ON "inventory_reconciliation_alerts" ("line_id");

CREATE INDEX IF NOT EXISTS "inventory_reconciliation_alerts_farm_status_created_idx"
  ON "inventory_reconciliation_alerts" ("farm_id", "status", "created_at");
