-- Curated project/event labels for approved public Moments; absent labels fall back to month.
ALTER TABLE moment_submissions
  ADD COLUMN IF NOT EXISTS group_label text;

ALTER TABLE moment_submissions
  ADD CONSTRAINT moment_submissions_group_label_length_check
  CHECK (group_label IS NULL OR char_length(group_label) BETWEEN 1 AND 80);

CREATE INDEX IF NOT EXISTS moment_submissions_approved_group_idx
  ON moment_submissions (farm_id, group_label, created_at DESC)
  WHERE status = 'approved';
