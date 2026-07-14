ALTER TABLE "users"
  ALTER COLUMN "butler_tts_mode" SET DEFAULT 'voice_replies';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "task_inventory_usage" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "task_id" uuid NOT NULL REFERENCES "tasks"("id") ON DELETE cascade,
  "item_id" uuid NOT NULL REFERENCES "inventory_items"("id"),
  "quantity" integer NOT NULL,
  "farm_id" uuid NOT NULL REFERENCES "farms"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
