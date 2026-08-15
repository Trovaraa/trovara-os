-- Public Journal likes and moderated comments.
-- Anonymous readers are represented only by a SHA-256 hash of a random,
-- browser-held token; no raw visitor token is persisted.

CREATE UNIQUE INDEX IF NOT EXISTS journal_posts_farm_id_uq
  ON journal_posts(farm_id, id);

CREATE TABLE IF NOT EXISTS journal_post_likes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  post_id uuid NOT NULL REFERENCES journal_posts(id) ON DELETE CASCADE,
  visitor_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT journal_post_likes_post_farm_fk
    FOREIGN KEY (farm_id, post_id) REFERENCES journal_posts(farm_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS journal_post_likes_post_visitor_uq
  ON journal_post_likes(post_id, visitor_hash);
CREATE INDEX IF NOT EXISTS journal_post_likes_farm_post_idx
  ON journal_post_likes(farm_id, post_id);

CREATE TABLE IF NOT EXISTS journal_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  post_id uuid NOT NULL REFERENCES journal_posts(id) ON DELETE CASCADE,
  visitor_hash text NOT NULL,
  author_name text NOT NULL,
  body text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  moderated_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
  moderated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT journal_comments_status_check
    CHECK (status IN ('pending', 'approved', 'rejected')),
  CONSTRAINT journal_comments_author_name_length
    CHECK (char_length(author_name) BETWEEN 1 AND 80),
  CONSTRAINT journal_comments_body_length
    CHECK (char_length(body) BETWEEN 2 AND 1200),
  CONSTRAINT journal_comments_post_farm_fk
    FOREIGN KEY (farm_id, post_id) REFERENCES journal_posts(farm_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS journal_comments_farm_post_status_idx
  ON journal_comments(farm_id, post_id, status);
CREATE INDEX IF NOT EXISTS journal_comments_farm_created_idx
  ON journal_comments(farm_id, created_at);
