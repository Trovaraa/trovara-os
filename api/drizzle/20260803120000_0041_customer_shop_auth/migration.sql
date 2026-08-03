-- Add email_verified_at column to customer_accounts
ALTER TABLE customer_accounts ADD COLUMN email_verified_at timestamptz;
--> statement-breakpoint

-- Backfill: grandfather existing customers
UPDATE customer_accounts SET email_verified_at = created_at WHERE email_verified_at IS NULL;
--> statement-breakpoint

-- Customer password reset tokens table
CREATE TABLE IF NOT EXISTS customer_password_reset_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES customer_accounts(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- Customer email verification tokens table
CREATE TABLE IF NOT EXISTS customer_email_verification_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES customer_accounts(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- Index for customer_password_reset_tokens lookups
CREATE INDEX IF NOT EXISTS customer_password_reset_tokens_account_idx
  ON customer_password_reset_tokens (account_id);
--> statement-breakpoint

-- Index for customer_email_verification_tokens lookups
CREATE INDEX IF NOT EXISTS customer_email_verification_tokens_account_idx
  ON customer_email_verification_tokens (account_id);
