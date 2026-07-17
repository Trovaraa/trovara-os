ALTER TABLE "harvest_lots" ADD COLUMN "public_token" text;--> statement-breakpoint
UPDATE "harvest_lots" SET "public_token" = gen_random_uuid()::text WHERE "public_token" IS NULL;--> statement-breakpoint
ALTER TABLE "harvest_lots" ALTER COLUMN "public_token" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "harvest_lots_public_token_idx" ON "harvest_lots" ("public_token");
