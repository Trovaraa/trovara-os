-- Single-use owner-registration tokens: replace the reusable
-- OWNER_REGISTRATION_SECRET env value with tokens that are consumed on first
-- successful /register and cannot be reused. Only the sha256 hash is stored.
CREATE TABLE IF NOT EXISTS "registration_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "token_hash" text NOT NULL,
  "label" text,
  "created_by_user_id" uuid,
  "expires_at" timestamp with time zone NOT NULL,
  "used_at" timestamp with time zone,
  "used_by_user_id" uuid,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "registration_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "registration_tokens" ADD CONSTRAINT "registration_tokens_created_by_user_id_users_id_fk"
  FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "registration_tokens" ADD CONSTRAINT "registration_tokens_used_by_user_id_users_id_fk"
  FOREIGN KEY ("used_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "registration_tokens_used_at_idx"
  ON "registration_tokens" USING btree ("used_at");
