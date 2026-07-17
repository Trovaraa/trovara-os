ALTER TABLE "farms" ADD COLUMN IF NOT EXISTS "live_mode" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "farms" ADD COLUMN IF NOT EXISTS "live_started_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "rejection_reason" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "daily_wage_ngn" integer;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "must_change_password" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "harvest_lots" ADD COLUMN IF NOT EXISTS "public_notes" text;
--> statement-breakpoint
ALTER TABLE "harvest_lots" ADD COLUMN IF NOT EXISTS "internal_notes" text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "password_reset_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "token_hash" text NOT NULL UNIQUE,
  "expires_at" timestamp with time zone NOT NULL,
  "used_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "consent_records" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "farm_id" uuid NOT NULL REFERENCES "farms"("id") ON DELETE cascade,
  "consent_type" text NOT NULL,
  "version" text NOT NULL,
  "accepted_at" timestamp with time zone DEFAULT now() NOT NULL
);
