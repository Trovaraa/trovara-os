-- Expense labels (many-to-many tags) + inbound invoice source fields.

CREATE TABLE IF NOT EXISTS expense_labels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES farms(id),
  name text NOT NULL,
  slug text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT expense_labels_farm_slug_uq UNIQUE (farm_id, slug)
);

CREATE INDEX IF NOT EXISTS expense_labels_farm_idx ON expense_labels (farm_id);

CREATE TABLE IF NOT EXISTS expense_label_links (
  expense_id uuid NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  label_id uuid NOT NULL REFERENCES expense_labels(id) ON DELETE CASCADE,
  PRIMARY KEY (expense_id, label_id)
);

CREATE INDEX IF NOT EXISTS expense_label_links_label_idx ON expense_label_links (label_id);

ALTER TABLE expenses
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS inbound_message_id text,
  ADD COLUMN IF NOT EXISTS attachment_filename text,
  ADD COLUMN IF NOT EXISTS attachment_storage_key text,
  ADD COLUMN IF NOT EXISTS attachment_mime_type text;

ALTER TABLE expenses
  DROP CONSTRAINT IF EXISTS expenses_source_check;
ALTER TABLE expenses
  ADD CONSTRAINT expenses_source_check
  CHECK (source IN ('manual', 'inbound_email'));

CREATE UNIQUE INDEX IF NOT EXISTS expenses_inbound_message_uq
  ON expenses (farm_id, inbound_message_id)
  WHERE inbound_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS finance_inbound_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  svix_id text NOT NULL UNIQUE,
  resend_email_id text,
  processed_at timestamptz NOT NULL DEFAULT now(),
  expense_id uuid REFERENCES expenses(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'processed',
  detail text
);

-- Seed default labels for every existing farm.
INSERT INTO expense_labels (farm_id, name, slug)
SELECT f.id, d.name, d.slug
FROM farms f
CROSS JOIN (
  VALUES
    ('Salary', 'salary'),
    ('Consultant', 'consultant'),
    ('Capex', 'capex'),
    ('Opex', 'opex'),
    ('Recurring', 'recurring')
) AS d(name, slug)
ON CONFLICT (farm_id, slug) DO NOTHING;
