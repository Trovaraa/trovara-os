CREATE TABLE IF NOT EXISTS "action_drafts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "farm_id" uuid NOT NULL REFERENCES "farms"("id"),
  "user_id" uuid NOT NULL REFERENCES "users"("id"),
  "channel" text NOT NULL DEFAULT 'web',
  "external_chat_id" text,
  "action_type" text NOT NULL,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "status" text NOT NULL DEFAULT 'pending',
  "expires_at" timestamptz NOT NULL,
  "confirmed_at" timestamptz,
  "telegram_message_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "action_drafts_status_check" CHECK (
    "status" IN ('pending', 'confirmed', 'cancelled', 'expired')
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "action_drafts_user_status_idx"
  ON "action_drafts" ("user_id", "status", "expires_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "telegram_processed_updates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "bot_key" text NOT NULL,
  "update_id" bigint NOT NULL,
  "processed_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "telegram_processed_updates_bot_update_uq"
  ON "telegram_processed_updates" ("bot_key", "update_id");
