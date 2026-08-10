-- Public Moments gallery submissions (visitor upload + OS vetting).

CREATE TABLE IF NOT EXISTS moment_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES farms(id),
  status text NOT NULL DEFAULT 'pending',
  submitter_name text,
  submitter_email text,
  consent boolean NOT NULL DEFAULT false,
  media_kind text NOT NULL DEFAULT 'image',
  mime_type text NOT NULL,
  original_filename text,
  storage_key text NOT NULL,
  poster_storage_key text,
  byte_size integer NOT NULL DEFAULT 0,
  duration_seconds integer,
  review_note text,
  reviewed_by_id uuid REFERENCES users(id),
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT moment_submissions_status_check
    CHECK (status IN ('pending', 'approved', 'rejected')),
  CONSTRAINT moment_submissions_media_kind_check
    CHECK (media_kind IN ('image', 'video')),
  CONSTRAINT moment_submissions_duration_check
    CHECK (duration_seconds IS NULL OR duration_seconds >= 0)
);

CREATE INDEX IF NOT EXISTS moment_submissions_farm_status_idx
  ON moment_submissions (farm_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS moment_submissions_approved_idx
  ON moment_submissions (farm_id, created_at DESC)
  WHERE status = 'approved';
