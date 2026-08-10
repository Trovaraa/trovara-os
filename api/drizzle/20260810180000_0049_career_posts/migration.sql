-- Careers postings authored in Trovara OS, published to the marketing site.

CREATE TABLE IF NOT EXISTS career_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  slug text NOT NULL,
  title text NOT NULL,
  department text,
  location text,
  employment_type text NOT NULL DEFAULT 'full_time',
  summary text NOT NULL,
  body_markdown text NOT NULL,
  apply_email text NOT NULL DEFAULT 'hello@trovara.farm',
  published boolean NOT NULL DEFAULT false,
  published_at timestamptz,
  created_by_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_by_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT career_posts_farm_slug_uq UNIQUE (farm_id, slug),
  CONSTRAINT career_posts_slug_format CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  CONSTRAINT career_posts_employment_type_check
    CHECK (employment_type IN ('full_time', 'part_time', 'contract', 'internship', 'temporary')),
  CONSTRAINT career_posts_published_at_consistent
    CHECK ((published = false) OR (published_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS career_posts_farm_created_idx
  ON career_posts (farm_id, created_at DESC);

CREATE INDEX IF NOT EXISTS career_posts_public_idx
  ON career_posts (farm_id, published_at DESC)
  WHERE published = true;
