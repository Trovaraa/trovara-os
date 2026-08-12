-- Structured role details for consultancy, NYSC, and standard employment postings.
ALTER TABLE career_posts
  ADD COLUMN IF NOT EXISTS engagement_details text,
  ADD COLUMN IF NOT EXISTS project_name text,
  ADD COLUMN IF NOT EXISTS duration text,
  ADD COLUMN IF NOT EXISTS application_deadline date,
  ADD COLUMN IF NOT EXISTS expected_start_date date,
  ADD COLUMN IF NOT EXISTS apply_subject text,
  ADD COLUMN IF NOT EXISTS application_instructions text;
