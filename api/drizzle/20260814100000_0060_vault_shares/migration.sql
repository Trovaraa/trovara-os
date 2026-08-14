-- Per-user shares for portal vault entries (e.g. social logins for a content creator).

CREATE TABLE IF NOT EXISTS portal_vault_shares (
  entry_id uuid NOT NULL REFERENCES portal_vault_entries(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shared_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entry_id, user_id)
);

CREATE INDEX IF NOT EXISTS portal_vault_shares_user_idx ON portal_vault_shares (user_id);
