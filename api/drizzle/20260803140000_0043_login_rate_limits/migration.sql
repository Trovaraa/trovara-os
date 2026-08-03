CREATE TABLE IF NOT EXISTS login_rate_limits (
  rate_key text PRIMARY KEY,
  attempt_count integer NOT NULL DEFAULT 0,
  window_starts_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
