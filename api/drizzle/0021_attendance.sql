CREATE TABLE IF NOT EXISTS "attendance_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "farm_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "clock_in_at" timestamp with time zone NOT NULL DEFAULT now(),
  "clock_out_at" timestamp with time zone,
  "monthly_wage_snapshot_ngn" integer NOT NULL,
  "plot_id" uuid,
  "task_id" uuid,
  "notes" text,
  "corrected_by_id" uuid,
  "corrected_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "attendance_sessions_wage_nonnegative" CHECK ("monthly_wage_snapshot_ngn" >= 0),
  CONSTRAINT "attendance_sessions_time_order" CHECK ("clock_out_at" IS NULL OR "clock_out_at" >= "clock_in_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "attendance_sessions_one_open_per_user_uq"
  ON "attendance_sessions" ("farm_id", "user_id")
  WHERE "clock_out_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "attendance_sessions_farm_clock_in_idx"
  ON "attendance_sessions" ("farm_id", "clock_in_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "attendance_sessions_task_idx"
  ON "attendance_sessions" ("task_id")
  WHERE "task_id" IS NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "attendance_sessions"
    ADD CONSTRAINT "attendance_sessions_farm_id_farms_id_fk"
    FOREIGN KEY ("farm_id") REFERENCES "public"."farms"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "attendance_sessions"
    ADD CONSTRAINT "attendance_sessions_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "attendance_sessions"
    ADD CONSTRAINT "attendance_sessions_plot_id_plots_id_fk"
    FOREIGN KEY ("plot_id") REFERENCES "public"."plots"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "attendance_sessions"
    ADD CONSTRAINT "attendance_sessions_task_id_tasks_id_fk"
    FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "attendance_sessions"
    ADD CONSTRAINT "attendance_sessions_corrected_by_id_users_id_fk"
    FOREIGN KEY ("corrected_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
