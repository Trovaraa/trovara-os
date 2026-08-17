CREATE TABLE IF NOT EXISTS newsletter_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES farms(id) ON DELETE RESTRICT,
  campaign_type text NOT NULL,
  audience_type text NOT NULL,
  product_key text,
  journal_post_id uuid REFERENCES journal_posts(id) ON DELETE SET NULL,
  subject text NOT NULL,
  preview_text text,
  body_text text NOT NULL,
  cta_label text,
  cta_url text,
  status text NOT NULL DEFAULT 'draft',
  provider_broadcast_id text,
  recipient_count integer NOT NULL DEFAULT 0,
  delivered_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  last_error text,
  created_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT newsletter_campaigns_type_check
    CHECK (campaign_type IN ('journal', 'marketing', 'product_availability')),
  CONSTRAINT newsletter_campaigns_audience_check
    CHECK (audience_type IN ('newsletter', 'product_waitlist')),
  CONSTRAINT newsletter_campaigns_status_check
    CHECK (status IN ('draft', 'sending', 'sent', 'partial', 'failed')),
  CONSTRAINT newsletter_campaigns_product_shape
    CHECK ((audience_type = 'product_waitlist') = (product_key IS NOT NULL)),
  CONSTRAINT newsletter_campaigns_journal_shape
    CHECK ((campaign_type = 'journal') = (journal_post_id IS NOT NULL)),
  CONSTRAINT newsletter_campaigns_counts_check
    CHECK (recipient_count >= 0 AND delivered_count >= 0 AND failed_count >= 0)
);

CREATE INDEX IF NOT EXISTS newsletter_campaigns_farm_created_idx
  ON newsletter_campaigns(farm_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS newsletter_campaigns_journal_once_uq
  ON newsletter_campaigns(farm_id, journal_post_id)
  WHERE journal_post_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS newsletter_campaigns_provider_broadcast_uq
  ON newsletter_campaigns(provider_broadcast_id)
  WHERE provider_broadcast_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS newsletter_campaign_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES newsletter_campaigns(id) ON DELETE CASCADE,
  farm_id uuid NOT NULL REFERENCES farms(id) ON DELETE RESTRICT,
  marketing_lead_id uuid REFERENCES marketing_leads(id) ON DELETE SET NULL,
  recipient_email text NOT NULL,
  recipient_name text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  last_error text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT newsletter_campaign_deliveries_status_check
    CHECK (status IN ('pending', 'sent', 'failed')),
  CONSTRAINT newsletter_campaign_deliveries_email_normalized
    CHECK (recipient_email = lower(recipient_email))
);

CREATE UNIQUE INDEX IF NOT EXISTS newsletter_campaign_deliveries_campaign_email_uq
  ON newsletter_campaign_deliveries(campaign_id, recipient_email);
CREATE INDEX IF NOT EXISTS newsletter_campaign_deliveries_farm_campaign_idx
  ON newsletter_campaign_deliveries(farm_id, campaign_id);
