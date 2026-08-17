ALTER TABLE operation_guidelines
  ADD COLUMN IF NOT EXISTS owner_id uuid REFERENCES users(id) ON DELETE SET NULL;

-- Existing guidance remains owned by the person who originally documented it.
UPDATE operation_guidelines
SET owner_id = created_by_id
WHERE owner_id IS NULL AND created_by_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS operation_guidelines_farm_owner_idx
  ON operation_guidelines(farm_id, owner_id);

ALTER TABLE operation_guideline_versions
  ADD COLUMN IF NOT EXISTS owner_id uuid REFERENCES users(id) ON DELETE SET NULL;

UPDATE operation_guideline_versions AS version
SET owner_id = guideline.owner_id
FROM operation_guidelines AS guideline
WHERE version.guideline_id = guideline.id
  AND version.owner_id IS NULL;
