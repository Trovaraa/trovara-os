-- Older repeat plans did not store Family Basket intent. Preserve their existing behaviour.
ALTER TABLE customer_recurring_orders
  ADD COLUMN family_basket_active boolean NOT NULL DEFAULT false;
