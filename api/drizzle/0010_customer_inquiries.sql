CREATE TABLE IF NOT EXISTS customer_inquiries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES farms(id),
  contact_id uuid REFERENCES customer_contacts(id),
  channel text NOT NULL,
  question text NOT NULL,
  normalized text NOT NULL,
  answered_via text NOT NULL DEFAULT 'faq',
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS customer_inquiries_farm_idx ON customer_inquiries (farm_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS customer_inquiries_normalized_idx ON customer_inquiries (farm_id, normalized);
