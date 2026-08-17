-- Review-only anomaly observations. No trigger mutates source records or sends notifications.

CREATE TABLE IF NOT EXISTS anomaly_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  fingerprint text NOT NULL,
  observation_type text NOT NULL,
  category text NOT NULL,
  title text NOT NULL,
  summary text NOT NULL,
  severity text NOT NULL DEFAULT 'medium',
  confidence integer NOT NULL DEFAULT 50,
  entity_type text,
  entity_id uuid,
  source_rule text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'observed',
  reviewed_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  review_note text,
  first_observed_at timestamptz NOT NULL DEFAULT now(),
  last_observed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT anomaly_observations_category_check CHECK (category IN ('inventory', 'finance', 'maintenance')),
  CONSTRAINT anomaly_observations_severity_check CHECK (severity IN ('low', 'medium', 'high')),
  CONSTRAINT anomaly_observations_confidence_check CHECK (confidence BETWEEN 0 AND 100),
  CONSTRAINT anomaly_observations_status_check CHECK (status IN ('observed', 'explained', 'confirmed', 'false_positive'))
);

CREATE UNIQUE INDEX IF NOT EXISTS anomaly_observations_farm_open_fingerprint_uq
  ON anomaly_observations(farm_id, fingerprint) WHERE status = 'observed';
CREATE INDEX IF NOT EXISTS anomaly_observations_farm_status_last_idx
  ON anomaly_observations(farm_id, status, last_observed_at);
