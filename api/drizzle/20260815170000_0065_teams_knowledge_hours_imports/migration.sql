-- Team and person-specific access, consultant operations guidance, finance imports,
-- and submitted-hours approvals.

CREATE TABLE IF NOT EXISTS permission_teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  created_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS permission_teams_farm_name_uq ON permission_teams(farm_id, name);

CREATE TABLE IF NOT EXISTS permission_team_permissions (
  team_id uuid NOT NULL REFERENCES permission_teams(id) ON DELETE CASCADE,
  permission_key text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS permission_team_permissions_pk ON permission_team_permissions(team_id, permission_key);

CREATE TABLE IF NOT EXISTS permission_team_members (
  team_id uuid NOT NULL REFERENCES permission_teams(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS permission_team_members_pk ON permission_team_members(team_id, user_id);
CREATE INDEX IF NOT EXISTS permission_team_members_user_idx ON permission_team_members(user_id);

CREATE TABLE IF NOT EXISTS user_permission_overrides (
  farm_id uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission_key text NOT NULL,
  effect text NOT NULL,
  updated_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_permission_overrides_effect_check CHECK (effect IN ('allow', 'deny'))
);
CREATE UNIQUE INDEX IF NOT EXISTS user_permission_overrides_pk ON user_permission_overrides(user_id, permission_key);
CREATE INDEX IF NOT EXISTS user_permission_overrides_farm_idx ON user_permission_overrides(farm_id);

CREATE TABLE IF NOT EXISTS operation_guidelines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  title text NOT NULL,
  category text NOT NULL,
  body text NOT NULL,
  audience text NOT NULL DEFAULT 'all',
  status text NOT NULL DEFAULT 'draft',
  version integer NOT NULL DEFAULT 1,
  review_due_at timestamptz,
  created_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operation_guidelines_audience_check CHECK (audience IN ('all', 'management', 'finance', 'operations', 'sales')),
  CONSTRAINT operation_guidelines_status_check CHECK (status IN ('draft', 'approved', 'archived'))
);
CREATE INDEX IF NOT EXISTS operation_guidelines_farm_status_idx ON operation_guidelines(farm_id, status);

ALTER TABLE attendance_sessions ADD COLUMN IF NOT EXISTS work_date date;
ALTER TABLE attendance_sessions ADD COLUMN IF NOT EXISTS submitted_minutes integer;
ALTER TABLE attendance_sessions ADD COLUMN IF NOT EXISTS approval_status text NOT NULL DEFAULT 'approved';
ALTER TABLE attendance_sessions ADD COLUMN IF NOT EXISTS approved_by_id uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE attendance_sessions ADD COLUMN IF NOT EXISTS approved_at timestamptz;
ALTER TABLE attendance_sessions ADD COLUMN IF NOT EXISTS rejection_reason text;
DO $$ BEGIN
  ALTER TABLE attendance_sessions ADD CONSTRAINT attendance_sessions_approval_status_check
    CHECK (approval_status IN ('pending', 'approved', 'rejected'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE attendance_sessions ADD CONSTRAINT attendance_sessions_submitted_minutes_check
    CHECK (submitted_minutes IS NULL OR (submitted_minutes >= 15 AND submitted_minutes <= 960));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS attendance_sessions_user_work_date_uq
  ON attendance_sessions(farm_id, user_id, work_date) WHERE work_date IS NOT NULL;

ALTER TABLE expenses ADD COLUMN IF NOT EXISTS import_batch_id uuid;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS import_source_filename text;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS import_row_number integer;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS import_fingerprint text;
CREATE UNIQUE INDEX IF NOT EXISTS expenses_farm_import_fingerprint_uq
  ON expenses(farm_id, import_fingerprint) WHERE import_fingerprint IS NOT NULL;
ALTER TABLE expenses DROP CONSTRAINT IF EXISTS expenses_source_check;
ALTER TABLE expenses ADD CONSTRAINT expenses_source_check CHECK (source IN ('manual', 'inbound_email', 'import'));
