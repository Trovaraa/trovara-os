-- Classify expenses by the stable cost-centre catalogue supplied by Finance.
-- Existing and inbound-email expenses stay nullable until a reviewer assigns one.

ALTER TABLE expenses
  ADD COLUMN IF NOT EXISTS cost_centre_code text;

DO $$ BEGIN
  ALTER TABLE expenses
    ADD CONSTRAINT expenses_cost_centre_check
    CHECK (
      cost_centre_code IS NULL
      OR cost_centre_code IN ('CC01', 'CC10', 'CC20', 'CC30', 'CC40', 'CC50', 'CC60', 'CC70', 'CC80')
    );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS expenses_farm_cost_centre_idx
  ON expenses (farm_id, cost_centre_code);

-- Normalize the two free-text examples previously shipped in seed data. Other
-- historical values are preserved and remain readable for audit purposes.
UPDATE crop_cycles SET cost_centre = 'CC10' WHERE cost_centre = 'PLANTAIN-2026';
UPDATE crop_cycles SET cost_centre = 'CC20' WHERE cost_centre = 'COCONUT-2026';
