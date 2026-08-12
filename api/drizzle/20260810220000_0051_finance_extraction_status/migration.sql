-- Persist invoice extraction provenance for inbound expense review and retries.

ALTER TABLE expenses
  ADD COLUMN IF NOT EXISTS extraction_method text,
  ADD COLUMN IF NOT EXISTS extraction_status text;

ALTER TABLE expenses
  DROP CONSTRAINT IF EXISTS expenses_extraction_method_check;
ALTER TABLE expenses
  ADD CONSTRAINT expenses_extraction_method_check
  CHECK (
    extraction_method IS NULL
    OR extraction_method IN ('heuristic', 'pdf_text', 'llm_text', 'llm_vision', 'none')
  );

ALTER TABLE expenses
  DROP CONSTRAINT IF EXISTS expenses_extraction_status_check;
ALTER TABLE expenses
  ADD CONSTRAINT expenses_extraction_status_check
  CHECK (extraction_status IS NULL OR extraction_status IN ('success', 'failed'));
