-- Canonical English content: translation display cache, generated-advice cache,
-- and per-row provenance for free-text columns.
CREATE TYPE "public"."translation_status" AS ENUM(
  'done',
  'pending',
  'failed'
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "content_translations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "content_hash" text NOT NULL,
  "target_locale" text NOT NULL,
  "translated_text" text NOT NULL,
  "model" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "content_translations_hash_locale_uq"
  ON "content_translations" ("content_hash", "target_locale");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "generated_advice" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "farm_id" uuid NOT NULL REFERENCES "farms"("id") ON DELETE CASCADE,
  "fingerprint" text NOT NULL,
  "rule_key" text NOT NULL,
  "happening_now" text NOT NULL,
  "what_next" text NOT NULL,
  "model" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "generated_advice_farm_fingerprint_uq"
  ON "generated_advice" ("farm_id", "fingerprint");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "generated_advice_expires_at_idx"
  ON "generated_advice" ("expires_at");
--> statement-breakpoint
-- Existing rows are treated as already-canonical: they predate translation-on-write.
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "source_locale" text;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "translation_status" "translation_status" DEFAULT 'done' NOT NULL;
--> statement-breakpoint
ALTER TABLE "livestock_logs" ADD COLUMN IF NOT EXISTS "source_locale" text;
--> statement-breakpoint
ALTER TABLE "livestock_logs" ADD COLUMN IF NOT EXISTS "translation_status" "translation_status" DEFAULT 'done' NOT NULL;
--> statement-breakpoint
ALTER TABLE "attendance_sessions" ADD COLUMN IF NOT EXISTS "source_locale" text;
--> statement-breakpoint
ALTER TABLE "attendance_sessions" ADD COLUMN IF NOT EXISTS "translation_status" "translation_status" DEFAULT 'done' NOT NULL;
--> statement-breakpoint
ALTER TABLE "crop_census_surveys" ADD COLUMN IF NOT EXISTS "source_locale" text;
--> statement-breakpoint
ALTER TABLE "crop_census_surveys" ADD COLUMN IF NOT EXISTS "translation_status" "translation_status" DEFAULT 'done' NOT NULL;
--> statement-breakpoint
ALTER TABLE "action_drafts" ADD COLUMN IF NOT EXISTS "source_locale" text;
--> statement-breakpoint
ALTER TABLE "action_drafts" ADD COLUMN IF NOT EXISTS "translation_status" "translation_status" DEFAULT 'done' NOT NULL;
--> statement-breakpoint
-- Rows still awaiting English are looked up by the retry job across all farms.
CREATE INDEX IF NOT EXISTS "tasks_translation_status_idx"
  ON "tasks" ("translation_status") WHERE "translation_status" <> 'done';
