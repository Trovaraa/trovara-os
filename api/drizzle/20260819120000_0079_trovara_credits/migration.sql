ALTER TABLE customer_survey_responses
  ADD COLUMN IF NOT EXISTS referral_code text;

CREATE TABLE IF NOT EXISTS customer_credit_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  survey_response_id uuid REFERENCES customer_survey_responses(id) ON DELETE SET NULL,
  marketing_lead_id uuid REFERENCES marketing_leads(id) ON DELETE SET NULL,
  email text NOT NULL,
  normalized_email text NOT NULL,
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  sent_at timestamptz,
  claimed_at timestamptz,
  claimed_by_account_id uuid REFERENCES customer_accounts(id) ON DELETE SET NULL,
  created_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_credit_invitations_farm_email_uq UNIQUE (farm_id, normalized_email)
);

CREATE INDEX IF NOT EXISTS customer_credit_invitations_farm_status_idx
  ON customer_credit_invitations (farm_id, claimed_at, sent_at);

CREATE TABLE IF NOT EXISTS customer_referral_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES customer_accounts(id) ON DELETE CASCADE,
  code text NOT NULL UNIQUE,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_referral_codes_account_uq UNIQUE (account_id)
);

CREATE INDEX IF NOT EXISTS customer_referral_codes_farm_idx
  ON customer_referral_codes (farm_id, active);

CREATE TABLE IF NOT EXISTS customer_credit_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES customer_accounts(id) ON DELETE CASCADE,
  amount integer NOT NULL,
  event_type text NOT NULL,
  source_id text NOT NULL,
  description text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_credit_ledger_amount_nonzero CHECK (amount <> 0),
  CONSTRAINT customer_credit_ledger_event_type_check CHECK (
    event_type IN ('welcome', 'survey_referral', 'adjustment', 'redemption')
  ),
  CONSTRAINT customer_credit_ledger_event_source_uq UNIQUE (account_id, event_type, source_id)
);

CREATE INDEX IF NOT EXISTS customer_credit_ledger_account_created_idx
  ON customer_credit_ledger (account_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS customer_credit_ledger_welcome_uq
  ON customer_credit_ledger (account_id) WHERE event_type = 'welcome';

CREATE TABLE IF NOT EXISTS customer_referral_attributions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  referral_code_id uuid NOT NULL REFERENCES customer_referral_codes(id) ON DELETE RESTRICT,
  referrer_account_id uuid NOT NULL REFERENCES customer_accounts(id) ON DELETE CASCADE,
  survey_response_id uuid NOT NULL REFERENCES customer_survey_responses(id) ON DELETE CASCADE,
  referred_normalized_contact text NOT NULL,
  ledger_entry_id uuid REFERENCES customer_credit_ledger(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_referral_attributions_survey_uq UNIQUE (survey_response_id),
  CONSTRAINT customer_referral_attributions_contact_uq UNIQUE (farm_id, referred_normalized_contact)
);

CREATE INDEX IF NOT EXISTS customer_referral_attributions_referrer_idx
  ON customer_referral_attributions (referrer_account_id, created_at DESC);
