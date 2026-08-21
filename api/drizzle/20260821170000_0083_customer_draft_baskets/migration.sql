CREATE TABLE IF NOT EXISTS "customer_draft_baskets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "farm_id" uuid NOT NULL REFERENCES "farms"("id") ON DELETE CASCADE,
  "account_id" uuid NOT NULL REFERENCES "customer_accounts"("id") ON DELETE CASCADE,
  "items" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "family_basket_active" boolean NOT NULL DEFAULT false,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "customer_draft_baskets_account_uq"
  ON "customer_draft_baskets" ("account_id");

CREATE INDEX IF NOT EXISTS "customer_draft_baskets_farm_updated_idx"
  ON "customer_draft_baskets" ("farm_id", "updated_at");
