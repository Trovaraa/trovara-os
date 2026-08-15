-- Idempotent tenant guard for databases that applied the initial Journal
-- engagement migration before the composite foreign keys were introduced.

CREATE UNIQUE INDEX IF NOT EXISTS journal_posts_farm_id_uq
  ON journal_posts(farm_id, id);

DO $$ BEGIN
  ALTER TABLE journal_post_likes
    ADD CONSTRAINT journal_post_likes_post_farm_fk
    FOREIGN KEY (farm_id, post_id)
    REFERENCES journal_posts(farm_id, id)
    ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE journal_comments
    ADD CONSTRAINT journal_comments_post_farm_fk
    FOREIGN KEY (farm_id, post_id)
    REFERENCES journal_posts(farm_id, id)
    ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
