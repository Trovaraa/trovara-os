# Operations Library document pipeline

Trovara OS treats uploaded consultant documents as untrusted until the complete
pipeline succeeds. Uploading a file never makes it available to Farm AI.

## Processing sequence

1. The API validates the size, extension and file signature.
2. The original bytes are encrypted with AES-256-GCM and stored under the
   private `quarantine/` prefix in the configured S3-compatible bucket.
3. A durable PostgreSQL job is created. The worker streams the decrypted bytes
   to ClamAV; scanner errors fail closed and are retried.
4. Infected files remain quarantined, are never downloaded through the normal
   route, and expire under the quarantine lifecycle policy.
5. Clean digital PDFs and DOCX files are extracted. Image-only PDFs run through
   OCRmyPDF/Tesseract. The OCR quality number is an estimate and never replaces
   consultant review against the source.
6. The clean source is encrypted and moved to `clean/`. The consultant corrects
   the extracted text and creates a draft.
7. A separate manager approves imported guidance (the owner may self-approve).
   The exact approved title, category, audience and body are written to an
   immutable version row with a SHA-256 content hash.
8. Embeddings are built asynchronously into a new index generation. Chunk count
   and vector dimensions are validated before one transaction retires the old
   generation and activates the new one. A failed build leaves the previous
   generation live.

Document, index and evaluation jobs are inserted in the same database
transaction as the record that needs the work. Multiple workers claim jobs with
`SKIP LOCKED`; an abandoned running job is requeued after
`KNOWLEDGE_JOB_STALE_MINUTES` and becomes dead-lettered when retries are spent.

## Storage

The application uses the S3 API rather than a vendor-specific SDK. Docker
Compose supplies SeaweedFS; production can use Amazon S3 by changing the
endpoint and credentials. Objects are application-encrypted, buckets are
private, downloads require Trovara permissions, and each download is audited.

Lifecycle rules expire quarantined objects after 14 days and discarded objects
after 30 days. Clean objects are retained while their database records exist.
The encrypted production backup snapshots clean objects into the evidence
backup tree before creating the GPG-protected archive.

## Worker operations

Start all local dependencies and the worker:

```bash
docker compose up -d --build
```

Inspect queue failures without exposing document content:

```sql
SELECT id, type, status, attempts, last_error, created_at
FROM knowledge_jobs
WHERE status IN ('failed', 'dead_letter')
ORDER BY created_at DESC;
```

Dead-letter jobs require a manager to address the dependency or source problem
before a deliberate retry is added. Do not bypass malware status in SQL.

## Retrieval evaluation

Managers add test questions from the Operations Library page, choose the
expected approved guideline, audience and language, and run the suite. Each run
records top-source rank, optional expected-text match, permission leaks and
latency. A release must not proceed when permission leaks are non-zero.

This evaluates retrieval; it does not train a model. Fine-tuning remains a
roadmap item and requires a separate reviewed/redacted dataset, held-out
evaluation set, explicit release gate, limited rollout and rollback plan.
