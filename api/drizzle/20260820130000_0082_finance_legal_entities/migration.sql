ALTER TABLE orders
  ADD COLUMN entity_code text NOT NULL DEFAULT '002';

ALTER TABLE payment_attempts
  ADD COLUMN entity_code text NOT NULL DEFAULT '002';

ALTER TABLE invoices
  ADD COLUMN entity_code text NOT NULL DEFAULT '002';

ALTER TABLE payment_refunds
  ADD COLUMN entity_code text NOT NULL DEFAULT '002';

ALTER TABLE expenses
  ADD COLUMN entity_code text NOT NULL DEFAULT '002';

ALTER TABLE orders
  ADD CONSTRAINT orders_entity_code_check CHECK (entity_code IN ('001', '002'));

ALTER TABLE payment_attempts
  ADD CONSTRAINT payment_attempts_entity_code_check CHECK (entity_code IN ('001', '002'));

ALTER TABLE invoices
  ADD CONSTRAINT invoices_entity_code_check CHECK (entity_code IN ('001', '002'));

ALTER TABLE payment_refunds
  ADD CONSTRAINT payment_refunds_entity_code_check CHECK (entity_code IN ('001', '002'));

ALTER TABLE expenses
  ADD CONSTRAINT expenses_entity_code_check CHECK (entity_code IN ('001', '002'));

CREATE INDEX orders_farm_entity_idx ON orders (farm_id, entity_code);
CREATE INDEX payment_attempts_farm_entity_idx ON payment_attempts (farm_id, entity_code);
CREATE INDEX invoices_farm_entity_idx ON invoices (farm_id, entity_code);
CREATE INDEX payment_refunds_farm_entity_idx ON payment_refunds (farm_id, entity_code);
CREATE INDEX expenses_farm_entity_idx ON expenses (farm_id, entity_code);

COMMENT ON COLUMN expenses.entity_code IS
  'Legal entity responsible for the expense: 001 Green Frontier or 002 Trovara.';

COMMENT ON COLUMN orders.entity_code IS
  'Legal entity earning the order revenue: 001 Green Frontier or 002 Trovara.';
