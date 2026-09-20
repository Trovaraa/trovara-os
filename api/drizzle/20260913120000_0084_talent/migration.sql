CREATE TABLE "talent_candidates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "farm_id" uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  "name" text NOT NULL,
  "email" text,
  "phone" text,
  "location" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE (farm_id, id)
);
CREATE UNIQUE INDEX talent_candidates_email_uq ON talent_candidates(farm_id, email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX career_posts_talent_scope_uq ON career_posts(farm_id, id);

CREATE TABLE "talent_applications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "farm_id" uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  "candidate_id" uuid NOT NULL,
  "career_post_id" uuid,
  "role_label" text NOT NULL DEFAULT 'Unassigned / general interest',
  "stage" text NOT NULL DEFAULT 'new' CHECK (stage IN ('new','reviewing','shortlisted','interview','offer','hired','rejected','withdrawn')),
  "source" text NOT NULL CHECK (source IN ('cv_upload','email_import','zoho','website')),
  "source_key" text NOT NULL,
  "needs_review" boolean NOT NULL DEFAULT true,
  "assigned_to_id" uuid REFERENCES users(id) ON DELETE SET NULL,
  "next_action" text,
  "due_at" timestamptz,
  "received_at" timestamptz NOT NULL DEFAULT now(),
  "retention_until" timestamptz NOT NULL DEFAULT (now() + interval '180 days'),
  "privacy_notice_version" text,
  "acknowledged_at" timestamptz,
  "deleted_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE (farm_id, id),
  UNIQUE (farm_id, source_key),
  FOREIGN KEY (farm_id, candidate_id) REFERENCES talent_candidates(farm_id, id),
  FOREIGN KEY (farm_id, career_post_id) REFERENCES career_posts(farm_id, id)
);
CREATE INDEX talent_applications_queue_idx ON talent_applications(farm_id, stage, received_at);
CREATE INDEX talent_applications_retention_idx ON talent_applications(retention_until);

CREATE TABLE "talent_documents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "farm_id" uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  "application_id" uuid NOT NULL,
  "filename" text NOT NULL,
  "mime_type" text NOT NULL,
  "storage_key" text NOT NULL,
  "sha256" text NOT NULL,
  "kind" text NOT NULL DEFAULT 'cv' CHECK (kind IN ('cv','supporting','email')),
  "extraction_status" text NOT NULL DEFAULT 'pending' CHECK (extraction_status IN ('pending','processing','ready','needs_review','not_applicable')),
  "extracted_text" text,
  "extracted_fields" jsonb,
  "warnings" jsonb NOT NULL DEFAULT '[]',
  "processing_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (farm_id, application_id) REFERENCES talent_applications(farm_id, id) ON DELETE CASCADE,
  UNIQUE (application_id, sha256)
);
CREATE INDEX talent_documents_processing_idx ON talent_documents(extraction_status, created_at);

CREATE TABLE "talent_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "farm_id" uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  "application_id" uuid NOT NULL,
  "actor_id" uuid REFERENCES users(id) ON DELETE SET NULL,
  "kind" text NOT NULL,
  "body" text NOT NULL,
  "message_key" text,
  "occurred_at" timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (farm_id, application_id) REFERENCES talent_applications(farm_id, id) ON DELETE CASCADE,
  UNIQUE (farm_id, message_key)
);
CREATE INDEX talent_events_application_idx ON talent_events(application_id, occurred_at);

CREATE TABLE "talent_mail_cursors" (
  "id" text PRIMARY KEY,
  "farm_id" uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  "start_at" integer NOT NULL DEFAULT 0,
  "last_synced_at" timestamptz,
  "last_error" text
);

-- Non-content fingerprints prevent retained Zoho mail / exports resurrecting erased applications.
CREATE TABLE talent_suppressed_sources (
  farm_id uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  fingerprint text NOT NULL,
  PRIMARY KEY (farm_id, fingerprint)
);
