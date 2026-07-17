CREATE TYPE "public"."purchase_order_status" AS ENUM(
  'draft',
  'approved',
  'sent',
  'partially_received',
  'received',
  'cancelled'
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "farm_id" uuid NOT NULL,
  "name" text NOT NULL,
  "phone" text,
  "email" text,
  "notes" text,
  "active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_orders" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "farm_id" uuid NOT NULL,
  "supplier_id" uuid NOT NULL,
  "status" "purchase_order_status" DEFAULT 'draft' NOT NULL,
  "created_by_id" uuid NOT NULL,
  "approved_by_id" uuid,
  "approved_at" timestamp with time zone,
  "notes" text,
  "expected_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_order_lines" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "purchase_order_id" uuid NOT NULL,
  "item_id" uuid,
  "item_name" text NOT NULL,
  "unit" "inventory_unit" NOT NULL,
  "quantity_ordered" integer NOT NULL,
  "quantity_received" integer DEFAULT 0 NOT NULL,
  "unit_cost_minor" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "purchase_order_lines_quantities_check"
    CHECK ("quantity_ordered" > 0 AND "quantity_received" >= 0 AND "quantity_received" <= "quantity_ordered"),
  CONSTRAINT "purchase_order_lines_unit_cost_check"
    CHECK ("unit_cost_minor" IS NULL OR "unit_cost_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "goods_receipts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "farm_id" uuid NOT NULL,
  "purchase_order_id" uuid NOT NULL,
  "idempotency_key" text NOT NULL,
  "received_by_id" uuid NOT NULL,
  "notes" text,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "goods_receipt_lines" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "goods_receipt_id" uuid NOT NULL,
  "purchase_order_line_id" uuid NOT NULL,
  "item_id" uuid NOT NULL,
  "quantity_received" integer NOT NULL,
  "inventory_movement_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "goods_receipt_lines_quantity_check" CHECK ("quantity_received" > 0),
  CONSTRAINT "goods_receipt_lines_receipt_po_line_uq" UNIQUE("goods_receipt_id", "purchase_order_line_id"),
  CONSTRAINT "goods_receipt_lines_inventory_movement_uq" UNIQUE("inventory_movement_id")
);
--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_farm_id_farms_id_fk"
  FOREIGN KEY ("farm_id") REFERENCES "public"."farms"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_farm_id_farms_id_fk"
  FOREIGN KEY ("farm_id") REFERENCES "public"."farms"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_supplier_id_suppliers_id_fk"
  FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_created_by_id_users_id_fk"
  FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_approved_by_id_users_id_fk"
  FOREIGN KEY ("approved_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_purchase_order_id_purchase_orders_id_fk"
  FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_item_id_inventory_items_id_fk"
  FOREIGN KEY ("item_id") REFERENCES "public"."inventory_items"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_farm_id_farms_id_fk"
  FOREIGN KEY ("farm_id") REFERENCES "public"."farms"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_purchase_order_id_purchase_orders_id_fk"
  FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_received_by_id_users_id_fk"
  FOREIGN KEY ("received_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_goods_receipt_id_goods_receipts_id_fk"
  FOREIGN KEY ("goods_receipt_id") REFERENCES "public"."goods_receipts"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_purchase_order_line_id_purchase_order_lines_id_fk"
  FOREIGN KEY ("purchase_order_line_id") REFERENCES "public"."purchase_order_lines"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_item_id_inventory_items_id_fk"
  FOREIGN KEY ("item_id") REFERENCES "public"."inventory_items"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_inventory_movement_id_inventory_movements_id_fk"
  FOREIGN KEY ("inventory_movement_id") REFERENCES "public"."inventory_movements"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "goods_receipts_po_idempotency_uq"
  ON "goods_receipts" USING btree ("purchase_order_id", "idempotency_key");
--> statement-breakpoint
CREATE INDEX "suppliers_farm_id_idx" ON "suppliers" USING btree ("farm_id");
--> statement-breakpoint
CREATE INDEX "purchase_orders_farm_id_idx" ON "purchase_orders" USING btree ("farm_id");
