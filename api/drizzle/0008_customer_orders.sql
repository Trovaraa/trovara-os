CREATE TABLE IF NOT EXISTS products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES farms(id),
  name text NOT NULL,
  unit text NOT NULL DEFAULT 'unit',
  price_kobo integer NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'NGN',
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS customer_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES farms(id),
  channel text NOT NULL,
  external_id text NOT NULL,
  name text,
  phone text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS customer_contacts_farm_channel_external_uq
  ON customer_contacts (farm_id, channel, external_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id),
  product_id uuid REFERENCES products(id),
  product_name text NOT NULL,
  unit text NOT NULL DEFAULT 'unit',
  unit_price_kobo integer NOT NULL DEFAULT 0,
  quantity integer NOT NULL,
  line_total_kobo integer NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS customer_chat_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES farms(id),
  channel text NOT NULL,
  external_id text NOT NULL,
  step text NOT NULL DEFAULT 'idle',
  cart jsonb,
  draft jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS customer_chat_sessions_farm_channel_external_uq
  ON customer_chat_sessions (farm_id, channel, external_id);
--> statement-breakpoint
ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_contact_id uuid REFERENCES customer_contacts(id);
--> statement-breakpoint
ALTER TABLE orders ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'staff';
