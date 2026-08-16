CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS operation_guideline_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  guideline_id uuid REFERENCES operation_guidelines(id) ON DELETE SET NULL,
  original_filename text NOT NULL,
  storage_key text NOT NULL,
  mime_type text NOT NULL,
  size_bytes integer NOT NULL,
  sha256 text NOT NULL,
  extraction_status text NOT NULL DEFAULT 'needs_review',
  extracted_text text NOT NULL,
  extraction_warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  uploaded_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operation_guideline_documents_status_check
    CHECK (extraction_status IN ('needs_review', 'draft_created', 'failed', 'discarded'))
);

CREATE INDEX IF NOT EXISTS operation_guideline_documents_farm_status_idx
  ON operation_guideline_documents (farm_id, extraction_status);
CREATE INDEX IF NOT EXISTS operation_guideline_documents_farm_hash_idx
  ON operation_guideline_documents (farm_id, sha256);

CREATE TABLE IF NOT EXISTS operation_guideline_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  guideline_id uuid NOT NULL REFERENCES operation_guidelines(id) ON DELETE CASCADE,
  document_id uuid REFERENCES operation_guideline_documents(id) ON DELETE SET NULL,
  guideline_version integer NOT NULL,
  chunk_index integer NOT NULL,
  heading text,
  source_page integer,
  content text NOT NULL,
  embedding vector(1536) NOT NULL,
  embedding_model text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS operation_guideline_chunks_version_chunk_uq
  ON operation_guideline_chunks (guideline_id, guideline_version, chunk_index);
CREATE INDEX IF NOT EXISTS operation_guideline_chunks_farm_guideline_idx
  ON operation_guideline_chunks (farm_id, guideline_id);
CREATE INDEX IF NOT EXISTS operation_guideline_chunks_embedding_hnsw_idx
  ON operation_guideline_chunks USING hnsw (embedding vector_cosine_ops);
