ALTER TABLE "products"
  ADD COLUMN IF NOT EXISTS "description" text,
  ADD COLUMN IF NOT EXISTS "category" text NOT NULL DEFAULT 'fresh_from_trovara',
  ADD COLUMN IF NOT EXISTS "provenance" text NOT NULL DEFAULT 'trovara_grown',
  ADD COLUMN IF NOT EXISTS "family_basket_quantity" integer NOT NULL DEFAULT 0;

ALTER TABLE "products"
  DROP CONSTRAINT IF EXISTS "products_provenance_check",
  ADD CONSTRAINT "products_provenance_check"
    CHECK ("provenance" IN ('trovara_grown', 'trovara_sourced')),
  DROP CONSTRAINT IF EXISTS "products_family_basket_quantity_check",
  ADD CONSTRAINT "products_family_basket_quantity_check"
    CHECK ("family_basket_quantity" >= 0);

CREATE TABLE IF NOT EXISTS "shop_delivery_slots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "farm_id" uuid NOT NULL REFERENCES "farms"("id") ON DELETE CASCADE,
  "label" text NOT NULL,
  "day_of_week" integer NOT NULL,
  "start_time" text NOT NULL,
  "end_time" text NOT NULL,
  "cutoff_hours" integer NOT NULL DEFAULT 24,
  "active" boolean NOT NULL DEFAULT true,
  "sort_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "shop_delivery_slots_day_check" CHECK ("day_of_week" BETWEEN 0 AND 6),
  CONSTRAINT "shop_delivery_slots_cutoff_check" CHECK ("cutoff_hours" BETWEEN 0 AND 336)
);

CREATE INDEX IF NOT EXISTS "shop_delivery_slots_farm_active_idx"
  ON "shop_delivery_slots" ("farm_id", "active", "sort_order");

ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "delivery_slot_id" uuid REFERENCES "shop_delivery_slots"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "delivery_date" date;

CREATE TABLE IF NOT EXISTS "customer_recurring_orders" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "farm_id" uuid NOT NULL REFERENCES "farms"("id") ON DELETE CASCADE,
  "account_id" uuid NOT NULL REFERENCES "customer_accounts"("id") ON DELETE CASCADE,
  "frequency" text NOT NULL,
  "items" jsonb NOT NULL,
  "delivery_slot_id" uuid REFERENCES "shop_delivery_slots"("id") ON DELETE SET NULL,
  "address" text NOT NULL,
  "phone" text,
  "next_checkout_at" timestamptz NOT NULL,
  "active" boolean NOT NULL DEFAULT true,
  "last_order_id" uuid REFERENCES "orders"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "customer_recurring_orders_frequency_check"
    CHECK ("frequency" IN ('weekly', 'fortnightly', 'monthly'))
);

CREATE INDEX IF NOT EXISTS "customer_recurring_orders_account_idx"
  ON "customer_recurring_orders" ("account_id", "active", "next_checkout_at");
