DO $$ BEGIN
  ALTER TABLE marketing_leads
    ADD CONSTRAINT marketing_leads_survey_followup_shape
    CHECK (
      lead_type <> 'survey_followup'
      OR (
        (email IS NOT NULL OR phone IS NOT NULL)
        AND subject_key IS NOT NULL
        AND subject_label IS NOT NULL
      )
    );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS customer_survey_responses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES farms(id) ON DELETE RESTRICT,
  survey_key text NOT NULL,
  answers jsonb NOT NULL,
  follow_up text NOT NULL,
  name text,
  email text,
  phone text,
  normalized_contact text,
  lead_id uuid REFERENCES marketing_leads(id) ON DELETE SET NULL,
  source text NOT NULL,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  referrer text,
  consent_at timestamptz NOT NULL,
  consent_version text NOT NULL,
  privacy_notice_url text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_survey_responses_follow_up_check
    CHECK (follow_up IN ('yes', 'maybe', 'no')),
  CONSTRAINT customer_survey_responses_follow_up_contact
    CHECK (follow_up = 'no' OR normalized_contact IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS customer_survey_responses_farm_created_idx
  ON customer_survey_responses (farm_id, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS customer_survey_responses_farm_follow_up_idx
  ON customer_survey_responses (farm_id, follow_up);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS customer_survey_responses_farm_survey_idx
  ON customer_survey_responses (farm_id, survey_key);
