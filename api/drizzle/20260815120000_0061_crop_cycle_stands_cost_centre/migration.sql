-- Operational crop-cycle fields requested by the farm team.

ALTER TABLE crop_cycles
  ADD COLUMN IF NOT EXISTS stand_count integer,
  ADD COLUMN IF NOT EXISTS cost_centre text;

DO $$ BEGIN
  ALTER TABLE crop_cycles
    ADD CONSTRAINT crop_cycles_stand_count_positive
    CHECK (stand_count IS NULL OR stand_count > 0);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS crop_cycles_farm_cost_centre_idx
  ON crop_cycles (farm_id, cost_centre);
