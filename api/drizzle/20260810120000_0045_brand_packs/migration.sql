-- Brand asset library and password-gated press / brand share packs.

CREATE TABLE IF NOT EXISTS brand_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  filename text NOT NULL,
  original_name text NOT NULL,
  mime_type text NOT NULL,
  byte_size integer NOT NULL,
  width integer,
  height integer,
  created_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS brand_assets_farm_idx ON brand_assets (farm_id);
CREATE UNIQUE INDEX IF NOT EXISTS brand_assets_farm_filename_uq ON brand_assets (farm_id, filename);

CREATE TABLE IF NOT EXISTS brand_packs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  title text NOT NULL,
  notes text,
  share_token text NOT NULL,
  password_hash text,
  expires_at timestamptz,
  revoked_at timestamptz,
  view_count integer NOT NULL DEFAULT 0,
  download_count integer NOT NULL DEFAULT 0,
  created_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS brand_packs_share_token_uq ON brand_packs (share_token);
CREATE INDEX IF NOT EXISTS brand_packs_farm_idx ON brand_packs (farm_id);

CREATE TABLE IF NOT EXISTS brand_pack_assets (
  pack_id uuid NOT NULL REFERENCES brand_packs(id) ON DELETE CASCADE,
  asset_id uuid NOT NULL REFERENCES brand_assets(id) ON DELETE CASCADE,
  position integer NOT NULL DEFAULT 0,
  PRIMARY KEY (pack_id, asset_id)
);

CREATE INDEX IF NOT EXISTS brand_pack_assets_asset_idx ON brand_pack_assets (asset_id);
