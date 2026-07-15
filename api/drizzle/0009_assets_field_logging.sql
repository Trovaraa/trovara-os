CREATE TABLE IF NOT EXISTS assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES farms(id),
  name text NOT NULL,
  category text NOT NULL DEFAULT 'other',
  unit text NOT NULL DEFAULT 'unit',
  quantity_owned integer NOT NULL DEFAULT 0,
  assigned_to_id uuid REFERENCES users(id),
  notes text,
  active boolean NOT NULL DEFAULT true,
  created_by_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS asset_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES farms(id),
  asset_id uuid NOT NULL REFERENCES assets(id),
  log_date timestamptz NOT NULL DEFAULT now(),
  count_available integer NOT NULL DEFAULT 0,
  count_damaged integer NOT NULL DEFAULT 0,
  condition text NOT NULL DEFAULT 'good',
  note text,
  photo_url text,
  recorded_by_id uuid NOT NULL REFERENCES users(id),
  verification_status text NOT NULL DEFAULT 'reported',
  verified_by_id uuid REFERENCES users(id),
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS asset_logs_asset_id_idx ON asset_logs (asset_id);
--> statement-breakpoint
ALTER TABLE harvest_lots ADD COLUMN IF NOT EXISTS photo_url text;
--> statement-breakpoint
ALTER TABLE harvest_lots ADD COLUMN IF NOT EXISTS reported_by_id uuid REFERENCES users(id);
--> statement-breakpoint
ALTER TABLE harvest_lots ADD COLUMN IF NOT EXISTS verification_status text NOT NULL DEFAULT 'verified';
--> statement-breakpoint
ALTER TABLE harvest_lots ADD COLUMN IF NOT EXISTS verified_by_id uuid REFERENCES users(id);
--> statement-breakpoint
ALTER TABLE harvest_lots ADD COLUMN IF NOT EXISTS verified_at timestamptz;
