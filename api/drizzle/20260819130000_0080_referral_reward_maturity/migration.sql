ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS delivered_at timestamptz;

UPDATE orders
SET delivered_at = updated_at
WHERE status = 'delivered' AND delivered_at IS NULL;

ALTER TABLE customer_referral_attributions
  ADD COLUMN IF NOT EXISTS referred_account_id uuid REFERENCES customer_accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS qualifying_order_id uuid REFERENCES orders(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reward_eligible_at timestamptz,
  ADD COLUMN IF NOT EXISTS credited_at timestamptz;

CREATE INDEX IF NOT EXISTS customer_referral_attributions_referred_account_idx
  ON customer_referral_attributions (referred_account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS customer_referral_attributions_reward_due_idx
  ON customer_referral_attributions (reward_eligible_at, ledger_entry_id);

-- Credits created by the initial implementation were awarded at survey submit.
-- They are reversed here so referral balances follow the purchase + refund-window rule.
INSERT INTO customer_credit_ledger (
  farm_id,
  account_id,
  amount,
  event_type,
  source_id,
  description
)
SELECT
  ledger.farm_id,
  ledger.account_id,
  -ledger.amount,
  'adjustment',
  'referral-policy-reversal:' || attribution.id,
  'Referral reward moved to pending until the qualifying purchase clears its refund period'
FROM customer_referral_attributions attribution
JOIN customer_credit_ledger ledger ON ledger.id = attribution.ledger_entry_id
WHERE ledger.event_type = 'survey_referral'
  AND ledger.amount > 0
ON CONFLICT (account_id, event_type, source_id) DO NOTHING;

UPDATE customer_referral_attributions
SET ledger_entry_id = NULL,
    credited_at = NULL
WHERE ledger_entry_id IS NOT NULL;
