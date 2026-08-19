UPDATE customer_credit_ledger
SET description = replace(description, 'Trovara Farm Credits', 'Trovara Credits')
WHERE description LIKE '%Trovara Farm Credits%';

COMMENT ON TABLE customer_credit_invitations IS
  'One-time invitations for eligible customers to activate a Trovara Credits account.';

COMMENT ON TABLE customer_credit_ledger IS
  'Immutable balance events for the Trovara Credits programme.';

COMMENT ON TABLE customer_referral_attributions IS
  'Referral attribution and first-purchase maturity state for 1,000-credit rewards.';
