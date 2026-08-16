-- Preventive maintenance, QR/barcode identity, and contractor engagements.

ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS scan_code text;
CREATE UNIQUE INDEX IF NOT EXISTS inventory_items_farm_scan_code_uq
  ON inventory_items(farm_id, scan_code) WHERE scan_code IS NOT NULL;

ALTER TABLE assets ADD COLUMN IF NOT EXISTS scan_code text;
CREATE UNIQUE INDEX IF NOT EXISTS assets_farm_scan_code_uq
  ON assets(farm_id, scan_code) WHERE scan_code IS NOT NULL;

CREATE TABLE IF NOT EXISTS contractors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  name text NOT NULL,
  company text,
  specialty text NOT NULL,
  phone text,
  email text,
  status text NOT NULL DEFAULT 'active',
  insurance_expires_at timestamptz,
  notes text,
  created_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contractors_status_check CHECK (status IN ('active', 'inactive', 'blocked'))
);
CREATE INDEX IF NOT EXISTS contractors_farm_status_idx ON contractors(farm_id, status);

CREATE TABLE IF NOT EXISTS contractor_engagements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  contractor_id uuid NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  title text NOT NULL,
  deliverables text,
  start_date date NOT NULL,
  end_date date,
  rate_type text NOT NULL DEFAULT 'fixed',
  agreed_amount_minor integer NOT NULL DEFAULT 0,
  paid_amount_minor integer NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'NGN',
  cost_centre_code text,
  status text NOT NULL DEFAULT 'planned',
  approved_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contractor_engagements_status_check CHECK (status IN ('planned', 'active', 'completed', 'cancelled')),
  CONSTRAINT contractor_engagements_rate_type_check CHECK (rate_type IN ('fixed', 'daily', 'hourly')),
  CONSTRAINT contractor_engagements_amounts_check CHECK (agreed_amount_minor >= 0 AND paid_amount_minor >= 0)
);
CREATE INDEX IF NOT EXISTS contractor_engagements_farm_status_idx
  ON contractor_engagements(farm_id, status);
CREATE INDEX IF NOT EXISTS contractor_engagements_contractor_idx
  ON contractor_engagements(contractor_id, start_date);

CREATE TABLE IF NOT EXISTS maintenance_work_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  asset_id uuid NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  contractor_id uuid REFERENCES contractors(id) ON DELETE SET NULL,
  assigned_to_id uuid REFERENCES users(id) ON DELETE SET NULL,
  title text NOT NULL,
  description text,
  service_type text NOT NULL DEFAULT 'preventive',
  priority text NOT NULL DEFAULT 'normal',
  status text NOT NULL DEFAULT 'open',
  due_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  meter_reading integer,
  checklist jsonb NOT NULL DEFAULT '[]'::jsonb,
  completion_notes text,
  parts_used text,
  estimated_cost_minor integer,
  actual_cost_minor integer,
  downtime_minutes integer,
  evidence_url text,
  created_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
  completed_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT maintenance_work_orders_status_check CHECK (status IN ('open', 'in_progress', 'completed', 'cancelled')),
  CONSTRAINT maintenance_work_orders_priority_check CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  CONSTRAINT maintenance_work_orders_service_type_check CHECK (service_type IN ('preventive', 'inspection', 'repair', 'replacement'))
);
CREATE INDEX IF NOT EXISTS maintenance_work_orders_farm_status_due_idx
  ON maintenance_work_orders(farm_id, status, due_at);
CREATE INDEX IF NOT EXISTS maintenance_work_orders_asset_idx
  ON maintenance_work_orders(asset_id, created_at);
