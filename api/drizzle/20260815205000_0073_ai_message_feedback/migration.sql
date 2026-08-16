ALTER TABLE "ai_messages"
  ADD COLUMN IF NOT EXISTS "feedback_rating" text,
  ADD COLUMN IF NOT EXISTS "feedback_note" text,
  ADD COLUMN IF NOT EXISTS "feedback_at" timestamp with time zone;

DO $$
BEGIN
  ALTER TABLE "ai_messages"
    ADD CONSTRAINT "ai_messages_feedback_rating_check"
    CHECK ("feedback_rating" IS NULL OR "feedback_rating" IN ('up', 'down'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "ai_messages_farm_feedback_idx"
  ON "ai_messages" ("farm_id", "feedback_rating", "feedback_at");
