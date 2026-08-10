-- Brand kit photo/video processing fields (iPhone HEIC/MOV → ready JPEG/MP4).

ALTER TABLE brand_assets
  ALTER COLUMN filename DROP NOT NULL,
  ALTER COLUMN byte_size DROP NOT NULL;

ALTER TABLE brand_assets
  ADD COLUMN IF NOT EXISTS media_kind text NOT NULL DEFAULT 'image',
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'ready',
  ADD COLUMN IF NOT EXISTS processing_error text,
  ADD COLUMN IF NOT EXISTS source_mime_type text,
  ADD COLUMN IF NOT EXISTS duration_seconds integer,
  ADD COLUMN IF NOT EXISTS poster_filename text,
  ADD COLUMN IF NOT EXISTS pending_source_path text,
  ADD COLUMN IF NOT EXISTS pending_original_name text;

ALTER TABLE brand_assets
  DROP CONSTRAINT IF EXISTS brand_assets_media_kind_check;
ALTER TABLE brand_assets
  ADD CONSTRAINT brand_assets_media_kind_check
  CHECK (media_kind IN ('image', 'video'));

ALTER TABLE brand_assets
  DROP CONSTRAINT IF EXISTS brand_assets_status_check;
ALTER TABLE brand_assets
  ADD CONSTRAINT brand_assets_status_check
  CHECK (status IN ('uploading', 'processing', 'ready', 'failed'));

ALTER TABLE brand_assets
  DROP CONSTRAINT IF EXISTS brand_assets_duration_check;
ALTER TABLE brand_assets
  ADD CONSTRAINT brand_assets_duration_check
  CHECK (duration_seconds IS NULL OR duration_seconds >= 0);

CREATE INDEX IF NOT EXISTS brand_assets_status_idx
  ON brand_assets (farm_id, status);
