ALTER TABLE farms ADD COLUMN IF NOT EXISTS slug text;
--> statement-breakpoint
UPDATE farms
SET slug = trim(both '-' from regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g'))
WHERE slug IS NULL OR slug = '';
--> statement-breakpoint
UPDATE farms SET slug = 'farm' WHERE slug IS NULL OR slug = '';
--> statement-breakpoint
UPDATE farms f
SET slug = f.slug || '-' || substr(replace(f.id::text, '-', ''), 1, 6)
WHERE EXISTS (
  SELECT 1 FROM farms g WHERE g.slug = f.slug AND g.id <> f.id
);
--> statement-breakpoint
ALTER TABLE farms ALTER COLUMN slug SET NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE farms ADD CONSTRAINT farms_slug_unique UNIQUE (slug);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
