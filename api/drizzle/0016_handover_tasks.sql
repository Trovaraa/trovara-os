ALTER TABLE "task_templates" ADD COLUMN IF NOT EXISTS "action_type" text;
ALTER TABLE "task_templates" ADD COLUMN IF NOT EXISTS "system_template_key" text;
ALTER TABLE "task_templates" ADD COLUMN IF NOT EXISTS "default_payload" jsonb;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "action_type" text;
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "action_payload" jsonb;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "task_templates_farm_system_key_uq"
  ON "task_templates" ("farm_id", "system_template_key")
  WHERE "system_template_key" IS NOT NULL;
