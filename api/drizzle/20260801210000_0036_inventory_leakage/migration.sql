-- Link sellable catalogue products to stock rows; typed I/O for theft/leakage.

ALTER TABLE "inventory_items"
  ADD COLUMN IF NOT EXISTS "product_id" uuid REFERENCES "products"("id") ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "inventory_items_farm_sku_uq"
  ON "inventory_items" ("farm_id", "sku");

CREATE UNIQUE INDEX IF NOT EXISTS "inventory_items_farm_product_uq"
  ON "inventory_items" ("farm_id", "product_id")
  WHERE "product_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "inventory_items_product_id_idx"
  ON "inventory_items" ("product_id");

CREATE TABLE IF NOT EXISTS "inventory_shrink_alerts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "farm_id" uuid NOT NULL REFERENCES "farms"("id") ON DELETE CASCADE,
  "item_id" uuid NOT NULL REFERENCES "inventory_items"("id") ON DELETE CASCADE,
  "sku" text NOT NULL,
  "alert_type" text NOT NULL,
  "period_days" integer NOT NULL DEFAULT 30,
  "period_start" timestamp with time zone NOT NULL,
  "period_end" timestamp with time zone NOT NULL,
  "qty_in" integer NOT NULL DEFAULT 0,
  "qty_out_sale" integer NOT NULL DEFAULT 0,
  "qty_out_task" integer NOT NULL DEFAULT 0,
  "qty_out_spoilage" integer NOT NULL DEFAULT 0,
  "qty_out_other" integer NOT NULL DEFAULT 0,
  "sold_qty" integer NOT NULL DEFAULT 0,
  "unexplained_out" integer NOT NULL DEFAULT 0,
  "tolerance" integer NOT NULL DEFAULT 0,
  "status" text NOT NULL DEFAULT 'open',
  "acknowledged_by_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "acknowledged_at" timestamp with time zone,
  "resolved_by_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "resolved_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "inventory_shrink_alerts_open_item_type_uq"
  ON "inventory_shrink_alerts" ("farm_id", "item_id", "alert_type")
  WHERE "status" <> 'resolved';

CREATE INDEX IF NOT EXISTS "inventory_shrink_alerts_farm_status_created_idx"
  ON "inventory_shrink_alerts" ("farm_id", "status", "created_at");
