-- Farm-scoped roles with assignable permission grants, plus portal credential vault.

CREATE TABLE IF NOT EXISTS farm_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  name text NOT NULL,
  is_system boolean NOT NULL DEFAULT false,
  cloned_from text,
  permissions_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS farm_roles_farm_name_uq ON farm_roles (farm_id, name);
CREATE INDEX IF NOT EXISTS farm_roles_farm_cloned_from_idx ON farm_roles (farm_id, cloned_from);

CREATE TABLE IF NOT EXISTS farm_role_permissions (
  role_id uuid NOT NULL REFERENCES farm_roles(id) ON DELETE CASCADE,
  permission_key text NOT NULL,
  PRIMARY KEY (role_id, permission_key)
);

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS farm_role_id uuid REFERENCES farm_roles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS users_farm_role_id_idx ON users (farm_role_id);

CREATE TABLE IF NOT EXISTS portal_vault_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  label text NOT NULL,
  category text NOT NULL DEFAULT 'other',
  login_url text NOT NULL,
  login_email text NOT NULL,
  password_ciphertext text NOT NULL,
  notes text,
  last_verified_at timestamptz,
  created_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS portal_vault_entries_farm_idx ON portal_vault_entries (farm_id);
