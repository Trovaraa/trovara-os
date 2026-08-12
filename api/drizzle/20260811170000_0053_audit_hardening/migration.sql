-- Expand-only security and reliability invariants from the August 2026 audit.

-- Tenant-bound registration tokens. Existing tokens inherit their creator's
-- farm; bootstrap tokens are only inferred when exactly one farm exists.
ALTER TABLE registration_tokens ADD COLUMN IF NOT EXISTS farm_id uuid;
UPDATE registration_tokens rt
SET farm_id = u.farm_id
FROM users u
WHERE rt.created_by_user_id = u.id AND rt.farm_id IS NULL;
UPDATE registration_tokens
SET farm_id = (SELECT id FROM farms ORDER BY created_at, id LIMIT 1)
WHERE farm_id IS NULL AND (SELECT count(*) FROM farms) = 1;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM registration_tokens WHERE farm_id IS NULL) THEN
    RAISE EXCEPTION 'registration_tokens contains unscoped rows; assign farm_id before migrating';
  END IF;
END $$;
ALTER TABLE registration_tokens ALTER COLUMN farm_id SET NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'registration_tokens_farm_id_farms_id_fk'
  ) THEN
    ALTER TABLE registration_tokens
      ADD CONSTRAINT registration_tokens_farm_id_farms_id_fk
      FOREIGN KEY (farm_id) REFERENCES farms(id) ON DELETE CASCADE;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS registration_tokens_farm_created_idx
  ON registration_tokens (farm_id, created_at DESC);

-- Payment/refund idempotency and document uniqueness. These indexes
-- intentionally fail the migration if production already contains duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS invoices_order_id_uq ON invoices (order_id);
CREATE UNIQUE INDEX IF NOT EXISTS invoices_farm_number_uq
  ON invoices (farm_id, invoice_number);
CREATE UNIQUE INDEX IF NOT EXISTS payment_receipts_attempt_uq
  ON payment_receipts (payment_attempt_id);
CREATE UNIQUE INDEX IF NOT EXISTS payment_receipts_farm_number_uq
  ON payment_receipts (farm_id, receipt_number);
ALTER TABLE payment_refunds
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS last_error text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX IF NOT EXISTS payment_refunds_idempotency_uq
  ON payment_refunds (payment_attempt_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Reclaimable finance inbound processing.
ALTER TABLE finance_inbound_events
  ALTER COLUMN processed_at DROP NOT NULL,
  ALTER COLUMN processed_at DROP DEFAULT,
  ALTER COLUMN status SET DEFAULT 'received',
  ADD COLUMN IF NOT EXISTS locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS lock_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error text;
UPDATE finance_inbound_events
SET processed_at = COALESCE(processed_at, now()),
    status = CASE
      WHEN status IN ('processed', 'duplicate', 'ignored') THEN status
      ELSE 'processed'
    END;
ALTER TABLE finance_inbound_events
  DROP CONSTRAINT IF EXISTS finance_inbound_events_status_check;
ALTER TABLE finance_inbound_events
  ADD CONSTRAINT finance_inbound_events_status_check
  CHECK (status IN ('received', 'processing', 'processed', 'failed', 'duplicate', 'ignored'));
CREATE INDEX IF NOT EXISTS finance_inbound_events_reclaim_idx
  ON finance_inbound_events (status, lock_expires_at);

-- Durable shared state for rate limiting, TOTP, webhook processing, and jobs.
CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  rate_key text PRIMARY KEY,
  attempt_count integer NOT NULL DEFAULT 0,
  window_starts_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rate_limit_buckets_expiry_idx ON rate_limit_buckets (expires_at);

CREATE TABLE IF NOT EXISTS totp_challenges (
  challenge_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  failed_attempts integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS totp_challenges_user_expiry_idx
  ON totp_challenges (user_id, expires_at);

CREATE TABLE IF NOT EXISTS totp_recovery_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT totp_recovery_codes_user_code_uq UNIQUE (user_id, code_hash)
);

CREATE TABLE IF NOT EXISTS totp_replay_steps (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  step integer NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, step)
);

CREATE TABLE IF NOT EXISTS whatsapp_processed_messages (
  phone_number_id text NOT NULL,
  message_id text NOT NULL,
  status text NOT NULL DEFAULT 'processing',
  last_error text,
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (phone_number_id, message_id),
  CONSTRAINT whatsapp_processed_messages_status_check
    CHECK (status IN ('processing', 'processed', 'failed'))
);

CREATE TABLE IF NOT EXISTS alert_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  job_type text NOT NULL,
  period_key text NOT NULL,
  status text NOT NULL DEFAULT 'processing',
  last_error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT alert_runs_farm_job_period_uq UNIQUE (farm_id, job_type, period_key),
  CONSTRAINT alert_runs_status_check CHECK (status IN ('processing', 'completed', 'failed'))
);

CREATE TABLE IF NOT EXISTS storage_cleanup_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_root text NOT NULL,
  storage_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT storage_cleanup_jobs_root_key_uq UNIQUE (storage_root, storage_key)
);
CREATE INDEX IF NOT EXISTS storage_cleanup_jobs_status_idx
  ON storage_cleanup_jobs (status, created_at);

-- Lease brand processing across API instances.
ALTER TABLE brand_assets
  ADD COLUMN IF NOT EXISTS processing_lease_token text,
  ADD COLUMN IF NOT EXISTS processing_lease_expires_at timestamptz;
CREATE INDEX IF NOT EXISTS brand_assets_processing_lease_idx
  ON brand_assets (status, processing_lease_expires_at);

-- Enforce farm identity on cross-tenant association tables.
CREATE UNIQUE INDEX IF NOT EXISTS brand_packs_farm_id_uq ON brand_packs (farm_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS brand_assets_farm_id_uq ON brand_assets (farm_id, id);
ALTER TABLE brand_pack_assets ADD COLUMN IF NOT EXISTS farm_id uuid;
UPDATE brand_pack_assets bpa
SET farm_id = bp.farm_id
FROM brand_packs bp
WHERE bpa.pack_id = bp.id AND bpa.farm_id IS NULL;
ALTER TABLE brand_pack_assets ALTER COLUMN farm_id SET NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'brand_pack_assets_farm_id_farms_id_fk') THEN
    ALTER TABLE brand_pack_assets ADD CONSTRAINT brand_pack_assets_farm_id_farms_id_fk
      FOREIGN KEY (farm_id) REFERENCES farms(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'brand_pack_assets_pack_farm_fk') THEN
    ALTER TABLE brand_pack_assets ADD CONSTRAINT brand_pack_assets_pack_farm_fk
      FOREIGN KEY (farm_id, pack_id) REFERENCES brand_packs(farm_id, id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'brand_pack_assets_asset_farm_fk') THEN
    ALTER TABLE brand_pack_assets ADD CONSTRAINT brand_pack_assets_asset_farm_fk
      FOREIGN KEY (farm_id, asset_id) REFERENCES brand_assets(farm_id, id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS expenses_farm_id_uq ON expenses (farm_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS expense_labels_farm_id_uq ON expense_labels (farm_id, id);
ALTER TABLE expense_label_links ADD COLUMN IF NOT EXISTS farm_id uuid;
UPDATE expense_label_links ell
SET farm_id = e.farm_id
FROM expenses e
WHERE ell.expense_id = e.id AND ell.farm_id IS NULL;
ALTER TABLE expense_label_links ALTER COLUMN farm_id SET NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'expense_label_links_farm_id_farms_id_fk') THEN
    ALTER TABLE expense_label_links ADD CONSTRAINT expense_label_links_farm_id_farms_id_fk
      FOREIGN KEY (farm_id) REFERENCES farms(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'expense_label_links_expense_farm_fk') THEN
    ALTER TABLE expense_label_links ADD CONSTRAINT expense_label_links_expense_farm_fk
      FOREIGN KEY (farm_id, expense_id) REFERENCES expenses(farm_id, id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'expense_label_links_label_farm_fk') THEN
    ALTER TABLE expense_label_links ADD CONSTRAINT expense_label_links_label_farm_fk
      FOREIGN KEY (farm_id, label_id) REFERENCES expense_labels(farm_id, id) ON DELETE CASCADE;
  END IF;
END $$;

-- Historical FX provenance.
ALTER TABLE expenses
  ADD COLUMN IF NOT EXISTS fx_rate_date date,
  ADD COLUMN IF NOT EXISTS fx_rate_source text;
UPDATE expenses
SET fx_rate_date = COALESCE(fx_rate_date, fx_converted_at::date),
    fx_rate_source = COALESCE(fx_rate_source, 'legacy-latest-rate')
WHERE fx_rate IS NOT NULL;
ALTER TABLE expenses DROP CONSTRAINT IF EXISTS expenses_fx_provenance_check;
ALTER TABLE expenses ADD CONSTRAINT expenses_fx_provenance_check
  CHECK (
    (fx_rate IS NULL AND fx_rate_date IS NULL AND fx_rate_source IS NULL)
    OR
    (fx_rate IS NOT NULL AND fx_rate_date IS NOT NULL AND fx_rate_source IS NOT NULL)
  );

-- Versioned Moments consent, accessible descriptions, and retention cleanup.
ALTER TABLE moment_submissions
  ADD COLUMN IF NOT EXISTS consent_version text,
  ADD COLUMN IF NOT EXISTS consent_at timestamptz,
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS retention_expires_at timestamptz;
UPDATE moment_submissions
SET consent_version = COALESCE(consent_version, '2026-08'),
    consent_at = COALESCE(consent_at, created_at)
WHERE consent = true;
ALTER TABLE moment_submissions DROP CONSTRAINT IF EXISTS moment_submissions_consent_check;
ALTER TABLE moment_submissions ADD CONSTRAINT moment_submissions_consent_check
  CHECK (
    consent = false
    OR (consent_version IS NOT NULL AND consent_at IS NOT NULL)
  );
UPDATE moment_submissions
SET retention_expires_at = COALESCE(retention_expires_at, created_at + interval '30 days')
WHERE status IN ('pending', 'rejected');
CREATE INDEX IF NOT EXISTS moment_submissions_retention_idx
  ON moment_submissions (status, retention_expires_at);
