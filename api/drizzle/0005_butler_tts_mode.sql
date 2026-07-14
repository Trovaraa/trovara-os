DO $$
BEGIN
  CREATE TYPE "butler_tts_mode" AS ENUM ('off', 'voice_replies', 'always');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "totp_secret" text,
  ADD COLUMN IF NOT EXISTS "totp_enabled" boolean DEFAULT false NOT NULL,
  ADD COLUMN IF NOT EXISTS "butler_tts_mode" "butler_tts_mode" DEFAULT 'voice_replies' NOT NULL;
