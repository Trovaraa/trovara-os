ALTER TABLE "farms" ADD COLUMN IF NOT EXISTS "latitude" text;
--> statement-breakpoint
ALTER TABLE "farms" ADD COLUMN IF NOT EXISTS "longitude" text;
--> statement-breakpoint
ALTER TABLE "farms" ADD COLUMN IF NOT EXISTS "timezone" text DEFAULT 'Africa/Lagos';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "weather_cache" (
  "farm_id" uuid PRIMARY KEY NOT NULL,
  "provider" text NOT NULL,
  "payload" jsonb NOT NULL,
  "fetched_at" timestamp with time zone NOT NULL,
  "expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "weather_cache"
    ADD CONSTRAINT "weather_cache_farm_id_farms_id_fk"
    FOREIGN KEY ("farm_id") REFERENCES "public"."farms"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
