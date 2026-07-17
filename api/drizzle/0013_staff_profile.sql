ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "next_of_kin_name" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "next_of_kin_phone" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "next_of_kin_relationship" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "employee_number" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "job_title" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "employment_type" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "employment_start_date" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "employment_end_date" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "employment_status" text DEFAULT 'employed';
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "monthly_wage_effective_from" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "monthly_wage_confirmed_at" timestamptz;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "monthly_wage_confirmed_by_id" uuid REFERENCES "users"("id");

CREATE UNIQUE INDEX IF NOT EXISTS "users_farm_employee_number_uq"
  ON "users" ("farm_id", "employee_number")
  WHERE "employee_number" IS NOT NULL;
