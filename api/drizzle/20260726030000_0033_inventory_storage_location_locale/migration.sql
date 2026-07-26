-- inventory_items.storage_location is worker prose ("back of the feed shed"),
-- the same kind of text as assets.location_text, but 0029 missed it: the column
-- had no locale pair, so text typed in French stayed French and the retry job
-- had nothing to sweep. That is a hole in the canonical-English guarantee.
--
-- Additive only, and on the same terms as 0029: existing rows land on
-- translation_status = 'done' with a null source_locale, so nothing already
-- stored is claimed to be in a known language or queued for translation.
--> statement-breakpoint
ALTER TABLE "inventory_items" ADD COLUMN IF NOT EXISTS "source_locale" text;
--> statement-breakpoint
ALTER TABLE "inventory_items" ADD COLUMN IF NOT EXISTS "translation_status" "translation_status" DEFAULT 'done' NOT NULL;
--> statement-breakpoint
ALTER TABLE "inventory_items" ADD COLUMN IF NOT EXISTS "translation_attempts" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inventory_items_translation_status_idx"
  ON "inventory_items" ("translation_status") WHERE "translation_status" <> 'done';
