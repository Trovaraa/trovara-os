-- Extend the catalogue without reclassifying or otherwise changing existing expenses.
-- Drizzle runs this replacement transactionally: no unconstrained write window.
ALTER TABLE expenses DROP CONSTRAINT expenses_cost_centre_check;
ALTER TABLE expenses ADD CONSTRAINT expenses_cost_centre_check
  CHECK (
    cost_centre_code IS NULL
    OR cost_centre_code IN ('CC01', 'CC02', 'CC03', 'CC04', 'CC10', 'CC20', 'CC30', 'CC40', 'CC50', 'CC60', 'CC70', 'CC80')
  );
