-- Paystack customer-order payments: payment status on orders, attempts,
-- immutable invoices/receipts, and refunds (state separate from fulfilment).
CREATE TYPE "public"."payment_status" AS ENUM(
  'unpaid',
  'paid',
  'not_required',
  'refunded',
  'partially_refunded',
  'refund_pending'
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "payment_status" "payment_status" DEFAULT 'not_required' NOT NULL;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "cancelled_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "cancelled_by" text;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "refund_requested_at" timestamp with time zone;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payment_attempts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "farm_id" uuid NOT NULL,
  "order_id" uuid NOT NULL,
  "provider" text DEFAULT 'paystack' NOT NULL,
  "provider_reference" text NOT NULL,
  "access_code" text,
  "amount_kobo" integer NOT NULL,
  "currency" text DEFAULT 'NGN' NOT NULL,
  "status" text DEFAULT 'initiated' NOT NULL,
  "provider_event_id" text,
  "paid_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "metadata" jsonb,
  CONSTRAINT "payment_attempts_provider_reference_unique" UNIQUE("provider_reference")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "invoices" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "farm_id" uuid NOT NULL,
  "order_id" uuid NOT NULL,
  "invoice_number" text NOT NULL,
  "snapshot" jsonb NOT NULL,
  "currency" text DEFAULT 'NGN' NOT NULL,
  "amount_kobo" integer NOT NULL,
  "public_token" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "invoices_public_token_unique" UNIQUE("public_token")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payment_receipts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "farm_id" uuid NOT NULL,
  "invoice_id" uuid NOT NULL,
  "payment_attempt_id" uuid NOT NULL,
  "receipt_number" text NOT NULL,
  "amount_kobo" integer NOT NULL,
  "paid_at" timestamp with time zone NOT NULL,
  "public_token" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "payment_receipts_public_token_unique" UNIQUE("public_token")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payment_refunds" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "farm_id" uuid NOT NULL,
  "payment_attempt_id" uuid NOT NULL,
  "order_id" uuid NOT NULL,
  "amount_kobo" integer NOT NULL,
  "provider_refund_id" text,
  "status" text DEFAULT 'pending' NOT NULL,
  "reason" text,
  "created_by_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_farm_id_farms_id_fk"
  FOREIGN KEY ("farm_id") REFERENCES "public"."farms"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_order_id_orders_id_fk"
  FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_farm_id_farms_id_fk"
  FOREIGN KEY ("farm_id") REFERENCES "public"."farms"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_order_id_orders_id_fk"
  FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payment_receipts" ADD CONSTRAINT "payment_receipts_farm_id_farms_id_fk"
  FOREIGN KEY ("farm_id") REFERENCES "public"."farms"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payment_receipts" ADD CONSTRAINT "payment_receipts_invoice_id_invoices_id_fk"
  FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payment_receipts" ADD CONSTRAINT "payment_receipts_payment_attempt_id_payment_attempts_id_fk"
  FOREIGN KEY ("payment_attempt_id") REFERENCES "public"."payment_attempts"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_farm_id_farms_id_fk"
  FOREIGN KEY ("farm_id") REFERENCES "public"."farms"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_payment_attempt_id_payment_attempts_id_fk"
  FOREIGN KEY ("payment_attempt_id") REFERENCES "public"."payment_attempts"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_order_id_orders_id_fk"
  FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_created_by_id_users_id_fk"
  FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_attempts_order_id_idx"
  ON "payment_attempts" USING btree ("order_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoices_order_id_idx"
  ON "invoices" USING btree ("order_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_refunds_order_id_idx"
  ON "payment_refunds" USING btree ("order_id");
