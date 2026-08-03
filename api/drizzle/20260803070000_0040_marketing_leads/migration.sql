DO $$ BEGIN
  CREATE TYPE marketing_lead_type AS ENUM ('contact', 'product_waitlist');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE marketing_lead_status AS ENUM ('new', 'in_progress', 'contacted', 'closed', 'spam');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE marketing_lead_notification_status AS ENUM ('pending', 'sent', 'failed');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS marketing_leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES farms(id) ON DELETE RESTRICT,
  lead_type marketing_lead_type NOT NULL,
  status marketing_lead_status NOT NULL DEFAULT 'new',
  name text NOT NULL,
  email text,
  phone text,
  normalized_contact text NOT NULL,
  subject_key text,
  subject_label text,
  message text,
  product_key text,
  product_label text,
  source text NOT NULL,
  submission_count integer NOT NULL DEFAULT 1,
  last_submitted_at timestamptz NOT NULL DEFAULT now(),
  assigned_to_id uuid REFERENCES users(id) ON DELETE SET NULL,
  staff_notification_status marketing_lead_notification_status NOT NULL DEFAULT 'pending',
  staff_notification_error text,
  staff_notified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT marketing_leads_contact_shape CHECK (
    lead_type <> 'contact'
    OR (email IS NOT NULL AND subject_key IS NOT NULL AND subject_label IS NOT NULL AND message IS NOT NULL)
  ),
  CONSTRAINT marketing_leads_waitlist_shape CHECK (
    lead_type <> 'product_waitlist'
    OR (product_key IS NOT NULL AND product_label IS NOT NULL AND (email IS NOT NULL OR phone IS NOT NULL))
  ),
  CONSTRAINT marketing_leads_submission_count_positive CHECK (submission_count >= 1)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS marketing_leads_farm_status_idx
  ON marketing_leads (farm_id, status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS marketing_leads_farm_type_idx
  ON marketing_leads (farm_id, lead_type);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS marketing_leads_farm_created_idx
  ON marketing_leads (farm_id, created_at);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS marketing_leads_waitlist_contact_uq
  ON marketing_leads (farm_id, product_key, normalized_contact)
  WHERE lead_type = 'product_waitlist';
