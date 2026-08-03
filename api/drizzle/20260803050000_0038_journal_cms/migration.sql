CREATE TABLE IF NOT EXISTS journal_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  slug text NOT NULL,
  title text NOT NULL,
  excerpt text NOT NULL,
  body_markdown text NOT NULL,
  author_name text NOT NULL,
  category text NOT NULL,
  tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  cover_image_url text,
  published boolean NOT NULL DEFAULT false,
  published_at timestamptz,
  created_by_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_by_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT journal_posts_slug_format
    CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  CONSTRAINT journal_posts_published_at_consistent
    CHECK (published = false OR published_at IS NOT NULL),
  CONSTRAINT journal_posts_tags_array
    CHECK (jsonb_typeof(tags) = 'array')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS journal_posts_farm_slug_uq
  ON journal_posts (farm_id, slug);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS journal_posts_farm_created_idx
  ON journal_posts (farm_id, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS journal_posts_public_idx
  ON journal_posts (farm_id, published_at)
  WHERE published = true;
