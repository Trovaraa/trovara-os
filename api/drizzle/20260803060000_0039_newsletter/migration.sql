DO $$ BEGIN
  CREATE TYPE newsletter_subscriber_status AS ENUM (
    'pending',
    'confirmed',
    'unsubscribed',
    'suppressed'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE newsletter_sync_status AS ENUM ('pending', 'synced', 'failed');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE newsletter_delivery_status AS ENUM ('pending', 'sent', 'failed');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS newsletter_subscribers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES farms(id) ON DELETE RESTRICT,
  email text NOT NULL,
  full_name text NOT NULL,
  phone text,
  email_consent_at timestamptz NOT NULL,
  email_consent_version text NOT NULL,
  email_consent_source text NOT NULL,
  phone_consent_at timestamptz,
  status newsletter_subscriber_status NOT NULL DEFAULT 'pending',
  confirmation_token_hash text,
  confirmation_token_expires_at timestamptz,
  confirmation_delivery_status newsletter_delivery_status NOT NULL DEFAULT 'pending',
  confirmation_delivery_error text,
  confirmation_last_sent_at timestamptz,
  unsubscribe_token_hash text NOT NULL,
  confirmed_at timestamptz,
  unsubscribed_at timestamptz,
  unsubscribed_reason text,
  suppressed_at timestamptz,
  suppressed_reason text,
  resend_contact_id text,
  resend_last_sync_status newsletter_sync_status NOT NULL DEFAULT 'pending',
  resend_last_sync_error text,
  resend_last_sync_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT newsletter_subscribers_email_normalized CHECK (email = lower(email)),
  CONSTRAINT newsletter_subscribers_confirmation_token_consistent
    CHECK ((confirmation_token_hash IS NULL) = (confirmation_token_expires_at IS NULL)),
  CONSTRAINT newsletter_subscribers_phone_consent_consistent
    CHECK (phone IS NULL OR phone_consent_at IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS newsletter_subscribers_farm_email_uq
  ON newsletter_subscribers (farm_id, email);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS newsletter_subscribers_confirmation_token_uq
  ON newsletter_subscribers (confirmation_token_hash)
  WHERE confirmation_token_hash IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS newsletter_subscribers_unsubscribe_token_uq
  ON newsletter_subscribers (unsubscribe_token_hash);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS newsletter_subscribers_farm_status_idx
  ON newsletter_subscribers (farm_id, status);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS newsletter_consent_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscriber_id uuid NOT NULL REFERENCES newsletter_subscribers(id) ON DELETE RESTRICT,
  farm_id uuid NOT NULL REFERENCES farms(id) ON DELETE RESTRICT,
  email text NOT NULL,
  full_name text NOT NULL,
  phone text,
  email_consent_at timestamptz NOT NULL,
  email_consent_version text NOT NULL,
  email_consent_source text NOT NULL,
  phone_consent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS newsletter_consent_events_subscriber_created_idx
  ON newsletter_consent_events (subscriber_id, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS newsletter_consent_events_farm_created_idx
  ON newsletter_consent_events (farm_id, created_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS newsletter_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES farms(id) ON DELETE RESTRICT,
  svix_id text NOT NULL,
  event_type text NOT NULL,
  processed_at timestamptz,
  processing_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS newsletter_webhook_events_svix_id_uq
  ON newsletter_webhook_events (svix_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS newsletter_webhook_events_farm_created_idx
  ON newsletter_webhook_events (farm_id, created_at);
