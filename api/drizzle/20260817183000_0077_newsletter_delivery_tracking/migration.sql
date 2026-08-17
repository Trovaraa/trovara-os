-- Preserve sent Journal campaign history after its source post is deleted and
-- record the provider/delivery state separately from API acceptance.
ALTER TABLE newsletter_campaigns
  DROP CONSTRAINT IF EXISTS newsletter_campaigns_journal_shape;

ALTER TABLE newsletter_campaigns
  ADD CONSTRAINT newsletter_campaigns_journal_shape
  CHECK (campaign_type = 'journal' OR journal_post_id IS NULL);

ALTER TABLE newsletter_campaigns
  ADD COLUMN IF NOT EXISTS provider_status text;

ALTER TABLE newsletter_campaign_deliveries
  ADD COLUMN IF NOT EXISTS newsletter_subscriber_id uuid
  REFERENCES newsletter_subscribers(id) ON DELETE SET NULL;

ALTER TABLE newsletter_campaign_deliveries
  DROP CONSTRAINT IF EXISTS newsletter_campaign_deliveries_status_check;

ALTER TABLE newsletter_campaign_deliveries
  ADD CONSTRAINT newsletter_campaign_deliveries_status_check
  CHECK (status IN ('pending', 'sent', 'delivered', 'delayed', 'failed'));

ALTER TABLE newsletter_campaign_deliveries
  ADD CONSTRAINT newsletter_campaign_deliveries_recipient_source_check
  CHECK (NOT (newsletter_subscriber_id IS NOT NULL AND marketing_lead_id IS NOT NULL));

CREATE INDEX IF NOT EXISTS newsletter_campaign_deliveries_subscriber_idx
  ON newsletter_campaign_deliveries(newsletter_subscriber_id)
  WHERE newsletter_subscriber_id IS NOT NULL;
