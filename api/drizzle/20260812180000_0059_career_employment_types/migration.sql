-- Expand career employment types to match the Careers API / UI
-- (consultancy + graduate_placement / NYSC).

ALTER TABLE career_posts
  DROP CONSTRAINT IF EXISTS career_posts_employment_type_check;

ALTER TABLE career_posts
  ADD CONSTRAINT career_posts_employment_type_check
  CHECK (
    employment_type IN (
      'full_time',
      'part_time',
      'contract',
      'internship',
      'temporary',
      'consultancy',
      'graduate_placement'
    )
  );
