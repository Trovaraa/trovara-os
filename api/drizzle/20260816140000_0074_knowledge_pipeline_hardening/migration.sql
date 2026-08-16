-- Harden Operations Library ingestion, retain immutable approvals, and make
-- embedding activation atomic so Farm AI never reads a half-built index.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE operation_guidelines ADD COLUMN IF NOT EXISTS active_version_id uuid;
ALTER TABLE operation_guidelines ADD COLUMN IF NOT EXISTS active_index_generation_id uuid;
ALTER TABLE operation_guidelines DROP CONSTRAINT IF EXISTS operation_guidelines_status_check;
ALTER TABLE operation_guidelines ADD CONSTRAINT operation_guidelines_status_check
  CHECK (status IN ('draft', 'indexing', 'approved', 'archived'));

ALTER TABLE operation_guideline_documents ADD COLUMN IF NOT EXISTS storage_bucket text;
ALTER TABLE operation_guideline_documents ADD COLUMN IF NOT EXISTS clean_storage_key text;
ALTER TABLE operation_guideline_documents ADD COLUMN IF NOT EXISTS scan_status text NOT NULL DEFAULT 'queued';
ALTER TABLE operation_guideline_documents ADD COLUMN IF NOT EXISTS scan_result text;
ALTER TABLE operation_guideline_documents ADD COLUMN IF NOT EXISTS scanned_at timestamptz;
ALTER TABLE operation_guideline_documents ADD COLUMN IF NOT EXISTS ocr_status text NOT NULL DEFAULT 'pending';
ALTER TABLE operation_guideline_documents ADD COLUMN IF NOT EXISTS ocr_confidence numeric(5,2);
ALTER TABLE operation_guideline_documents ALTER COLUMN extracted_text SET DEFAULT '';

UPDATE operation_guideline_documents
SET scan_status = 'clean', scanned_at = COALESCE(scanned_at, created_at),
    ocr_status = CASE WHEN mime_type = 'application/pdf' THEN 'not_needed' ELSE 'not_needed' END
WHERE extraction_status IN ('needs_review', 'draft_created');

ALTER TABLE operation_guideline_documents DROP CONSTRAINT IF EXISTS operation_guideline_documents_status_check;
ALTER TABLE operation_guideline_documents ADD CONSTRAINT operation_guideline_documents_status_check
  CHECK (extraction_status IN ('queued', 'scanning', 'extracting', 'needs_review', 'draft_created', 'failed', 'quarantined', 'discarded'));
DO $$ BEGIN
  ALTER TABLE operation_guideline_documents ADD CONSTRAINT operation_guideline_documents_scan_status_check
    CHECK (scan_status IN ('queued', 'scanning', 'clean', 'infected', 'error'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE operation_guideline_documents ADD CONSTRAINT operation_guideline_documents_ocr_status_check
    CHECK (ocr_status IN ('pending', 'not_needed', 'processing', 'completed', 'failed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS operation_guideline_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  guideline_id uuid NOT NULL REFERENCES operation_guidelines(id) ON DELETE CASCADE,
  version integer NOT NULL,
  title text NOT NULL,
  category text NOT NULL,
  body text NOT NULL,
  audience text NOT NULL,
  content_sha256 text NOT NULL,
  source_document_id uuid REFERENCES operation_guideline_documents(id) ON DELETE SET NULL,
  approved_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS operation_guideline_versions_guideline_version_uq
  ON operation_guideline_versions(guideline_id, version);
CREATE INDEX IF NOT EXISTS operation_guideline_versions_farm_guideline_idx
  ON operation_guideline_versions(farm_id, guideline_id);

CREATE OR REPLACE FUNCTION prevent_approved_guideline_version_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Approved guideline versions are immutable';
END $$;
DROP TRIGGER IF EXISTS operation_guideline_versions_immutable_update ON operation_guideline_versions;
CREATE TRIGGER operation_guideline_versions_immutable_update
BEFORE UPDATE ON operation_guideline_versions
FOR EACH ROW EXECUTE FUNCTION prevent_approved_guideline_version_update();

INSERT INTO operation_guideline_versions (
  farm_id, guideline_id, version, title, category, body, audience,
  content_sha256, source_document_id, approved_by_id, approved_at, created_at
)
SELECT g.farm_id, g.id, g.version, g.title, g.category, g.body, g.audience,
       encode(digest(g.title || E'\n' || g.category || E'\n' || g.audience || E'\n' || g.body, 'sha256'), 'hex'),
       d.id, g.approved_by_id, COALESCE(g.approved_at, g.updated_at), COALESCE(g.approved_at, g.updated_at)
FROM operation_guidelines g
LEFT JOIN LATERAL (
  SELECT id FROM operation_guideline_documents
  WHERE guideline_id = g.id ORDER BY created_at DESC LIMIT 1
) d ON true
WHERE g.status = 'approved'
ON CONFLICT (guideline_id, version) DO NOTHING;

UPDATE operation_guidelines g
SET active_version_id = v.id
FROM operation_guideline_versions v
WHERE v.guideline_id = g.id AND v.version = g.version AND g.active_version_id IS NULL;

CREATE TABLE IF NOT EXISTS operation_guideline_index_generations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  guideline_id uuid NOT NULL REFERENCES operation_guidelines(id) ON DELETE CASCADE,
  version_id uuid NOT NULL REFERENCES operation_guideline_versions(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'building',
  embedding_model text NOT NULL,
  chunk_count integer NOT NULL DEFAULT 0,
  validation_error text,
  validated_at timestamptz,
  activated_at timestamptz,
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operation_guideline_index_generations_status_check
    CHECK (status IN ('building', 'validated', 'active', 'failed', 'retired'))
);
CREATE INDEX IF NOT EXISTS operation_guideline_index_generations_farm_status_idx
  ON operation_guideline_index_generations(farm_id, status);

ALTER TABLE operation_guideline_chunks ADD COLUMN IF NOT EXISTS version_id uuid REFERENCES operation_guideline_versions(id) ON DELETE CASCADE;
ALTER TABLE operation_guideline_chunks ADD COLUMN IF NOT EXISTS generation_id uuid REFERENCES operation_guideline_index_generations(id) ON DELETE CASCADE;

INSERT INTO operation_guideline_index_generations (
  farm_id, guideline_id, version_id, status, embedding_model, chunk_count,
  validated_at, activated_at, created_at
)
SELECT c.farm_id, c.guideline_id, v.id, 'active', MIN(c.embedding_model), COUNT(*)::integer,
       now(), now(), MIN(c.created_at)
FROM operation_guideline_chunks c
JOIN operation_guideline_versions v
  ON v.guideline_id = c.guideline_id AND v.version = c.guideline_version
WHERE c.generation_id IS NULL
GROUP BY c.farm_id, c.guideline_id, v.id;

UPDATE operation_guideline_chunks c
SET version_id = g.version_id, generation_id = g.id
FROM operation_guideline_index_generations g
WHERE g.guideline_id = c.guideline_id AND g.status = 'active' AND c.generation_id IS NULL;

UPDATE operation_guidelines guideline
SET active_index_generation_id = generation.id
FROM operation_guideline_index_generations generation
WHERE generation.guideline_id = guideline.id AND generation.status = 'active'
  AND guideline.active_index_generation_id IS NULL;

ALTER TABLE operation_guidelines DROP CONSTRAINT IF EXISTS operation_guidelines_active_version_id_fk;
ALTER TABLE operation_guidelines ADD CONSTRAINT operation_guidelines_active_version_id_fk
  FOREIGN KEY (active_version_id) REFERENCES operation_guideline_versions(id) ON DELETE SET NULL;
ALTER TABLE operation_guidelines DROP CONSTRAINT IF EXISTS operation_guidelines_active_index_generation_id_fk;
ALTER TABLE operation_guidelines ADD CONSTRAINT operation_guidelines_active_index_generation_id_fk
  FOREIGN KEY (active_index_generation_id) REFERENCES operation_guideline_index_generations(id) ON DELETE SET NULL;

DROP INDEX IF EXISTS operation_guideline_chunks_version_chunk_uq;
CREATE UNIQUE INDEX IF NOT EXISTS operation_guideline_chunks_generation_chunk_uq
  ON operation_guideline_chunks(generation_id, chunk_index) WHERE generation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS operation_guideline_chunks_generation_idx
  ON operation_guideline_chunks(generation_id);

CREATE TABLE IF NOT EXISTS knowledge_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  type text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  progress integer NOT NULL DEFAULT 0,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  run_after timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  created_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT knowledge_jobs_type_check CHECK (type IN ('document_process', 'guideline_index', 'retrieval_evaluation')),
  CONSTRAINT knowledge_jobs_status_check CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'dead_letter')),
  CONSTRAINT knowledge_jobs_progress_check CHECK (progress BETWEEN 0 AND 100)
);
CREATE INDEX IF NOT EXISTS knowledge_jobs_claim_idx ON knowledge_jobs(status, run_after, created_at);
CREATE INDEX IF NOT EXISTS knowledge_jobs_farm_type_idx ON knowledge_jobs(farm_id, type);

CREATE TABLE IF NOT EXISTS knowledge_evaluation_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  question text NOT NULL,
  expected_guideline_id uuid NOT NULL REFERENCES operation_guidelines(id) ON DELETE CASCADE,
  expected_text text,
  audience text NOT NULL DEFAULT 'all',
  language text NOT NULL DEFAULT 'en',
  active boolean NOT NULL DEFAULT true,
  created_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS knowledge_evaluation_cases_farm_active_idx
  ON knowledge_evaluation_cases(farm_id, active);

CREATE TABLE IF NOT EXISTS knowledge_evaluation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued',
  embedding_model text NOT NULL,
  total_cases integer NOT NULL DEFAULT 0,
  passed_cases integer NOT NULL DEFAULT 0,
  mean_reciprocal_rank numeric(7,6),
  permission_leaks integer NOT NULL DEFAULT 0,
  average_latency_ms integer,
  started_at timestamptz,
  completed_at timestamptz,
  created_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT knowledge_evaluation_runs_status_check CHECK (status IN ('queued', 'running', 'succeeded', 'failed'))
);
CREATE INDEX IF NOT EXISTS knowledge_evaluation_runs_farm_created_idx
  ON knowledge_evaluation_runs(farm_id, created_at DESC);

CREATE TABLE IF NOT EXISTS knowledge_evaluation_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES knowledge_evaluation_runs(id) ON DELETE CASCADE,
  case_id uuid NOT NULL REFERENCES knowledge_evaluation_cases(id) ON DELETE CASCADE,
  retrieved_guideline_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  expected_rank integer,
  passed boolean NOT NULL DEFAULT false,
  permission_leak boolean NOT NULL DEFAULT false,
  latency_ms integer NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_evaluation_results_run_case_uq
  ON knowledge_evaluation_results(run_id, case_id);
