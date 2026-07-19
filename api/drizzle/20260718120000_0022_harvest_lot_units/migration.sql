ALTER TABLE "harvest_lots" ADD COLUMN IF NOT EXISTS "unit" text DEFAULT 'kg' NOT NULL;
ALTER TABLE "harvest_lots" ADD COLUMN IF NOT EXISTS "order_id" uuid;
DO $$ BEGIN
  ALTER TABLE "harvest_lots"
    ADD CONSTRAINT "harvest_lots_order_id_orders_id_fk"
    FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS "harvest_lots_order_id_idx" ON "harvest_lots" ("order_id");
