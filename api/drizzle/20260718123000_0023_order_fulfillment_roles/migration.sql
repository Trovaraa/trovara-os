-- sales role for order fulfillment staff
ALTER TYPE "user_role" ADD VALUE IF NOT EXISTS 'sales';

-- staff preferred reply locale (en|yo|pcm|fr)
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "preferred_locale" text DEFAULT 'en' NOT NULL;

-- optional delivery proof + customer feedback on orders
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "delivery_photo_url" text;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "customer_feedback" text;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "customer_feedback_at" timestamp with time zone;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "feedback_requested_at" timestamp with time zone;
