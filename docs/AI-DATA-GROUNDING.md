# How Trovara OS data is stored and used by AI

Last updated: 2026-08-15

## The short version

Trovara OS does **not** train or fine-tune the language model on private farm data. The application remains the system of record. For each AI request, the server reads a limited, permission-scoped set of current records from PostgreSQL, turns those records into a compact context, and sends that context with the user’s question to the configured OpenAI-compatible model.

The model’s reply is advice or a draft. It does not become a farm record unless an authorised user confirms a separately validated action.

## Storage and AI-use boundaries

| Data | Storage | When AI can use it | Important boundary |
| --- | --- | --- | --- |
| Tasks, inventory, crops, livestock, orders, finance, assets, hours | Farm-scoped PostgreSQL tables | Included at request time only when the user has the matching read permission | The model is not trained on these rows and cannot bypass tenant or role scope. |
| Photos, voice, receipts, and other evidence | Private evidence storage; PostgreSQL stores the protected reference and metadata | Sent only for an authorised diagnosis, transcription, extraction, or evidence-aware request | Raw private evidence is not exposed through public URLs. |
| Finance Excel/CSV/PDF imports | The preview is parsed in memory and protected by a short-lived signed token; only selected, confirmed rows become PostgreSQL expenses | Confirmed expenses can enter finance context for users with finance access | The uploaded file is not blindly placed in the Copilot prompt. Duplicate fingerprints prevent repeated import. |
| Inbound invoice attachments | Private evidence storage plus extraction metadata and a pending/approved expense record | Structured, approved expense data can be used by authorised finance AI context | Extracted text is treated as untrusted document data, not as instructions. |
| Operations Library guidance | Application-encrypted PDF/DOCX objects in private S3-compatible storage plus immutable, reviewed PostgreSQL versions and generation-scoped pgvector chunks | Only the active approved generation is semantically retrieved for the question, then filtered by farm, audience, and the user’s permissions | Uploads are quarantined, malware-scanned, optionally OCR'd, and human-reviewed. A failed replacement index leaves the previous approved generation live. |
| AI conversations and answer feedback | Farm- and user-scoped conversation/message tables; each assistant message may store a thumbs rating, optional correction, and timestamp | Restores the user’s thread; a correction on a negatively rated answer guides later turns in that same thread | Ratings do not automatically train or fine-tune a model. Another farm or user cannot read or apply the feedback. |
| Anomaly observations | `anomaly_observations` with rule, confidence, evidence, timestamps, and human review outcome | Open observations can be included for users with `anomalies.read`; AI may explain evidence and recommend review | They are explicitly labelled unconfirmed. AI must not call them theft, fraud, or misconduct. |

## Observation mode and feedback

The first anomaly release uses deterministic rules rather than an opaque model:

- verified inventory counts outside configured tolerance;
- unexplained inventory output outside tolerance;
- a recent expense at least three times the median of five or more earlier matching expenses, with a minimum material difference;
- repeated completed repairs for the same equipment within 90 days.

Each result stores the source rule, source record ID, supporting figures, confidence, first/last observed time, and review status. A reviewer records one of:

- **Explained** — unusual, but supported by a known reason;
- **Confirmed issue** — requires operational follow-up;
- **False positive** — the rule did not describe a useful issue.

This feedback is retained for people to tune rules and thresholds. It does not automatically retrain the LLM. Moving beyond observation mode requires reviewed pilot data, an agreed false-positive target, and a separate product decision about notifications.

## Copilot answer feedback and safe learning

Every persisted Copilot answer offers a thumbs-up or thumbs-down control. A thumbs-down can include a short correction. The server stores the rating on the exact assistant message, scoped to the same farm and user. A sanitized correction is appended to the model history for later turns in that same conversation, so the Copilot can adjust immediately without changing global behaviour.

This is a feedback and evaluation loop, not automatic model training. A single click must never rewrite prompts, alter permissions, publish guidance, or fine-tune the production model. Future training requires a separate reviewed export that removes sensitive data, verifies corrections, separates training and evaluation sets, measures the candidate against the current model, and requires an authorised release decision. Positive/negative totals alone are evaluation signals; the optional correction is the more useful evidence.

## How an AI answer is produced

1. Authenticate the person and resolve farm, role, teams, and individual permission overrides.
2. Query only the farm records that person is allowed to read.
3. Embed the question, retrieve the most relevant approved Operations Library chunks with pgvector, and enforce farm, audience, and user permissions before prompt construction. If semantic retrieval is unavailable, use a small permission-filtered approved-text fallback.
4. Add open anomaly observations only when the person has anomaly access, clearly labelled as unconfirmed.
5. Sanitize stored text and place it inside a prompt that treats record/document text as data, not instructions.
6. Ask the configured model to answer in the user’s selected language using only the supplied records.
7. Return and persist the answer so the user can rate the exact message. Any supported write is created as a server-validated draft and requires explicit confirmation.
8. If the user corrects an unhelpful answer, sanitize that correction and use it only in the rest of their current conversation. Retain ratings for later reviewed evaluation; do not train automatically.

## Uploading consultant documents

The Operations Library accepts PDF and DOCX files up to 10 MB. The API checks the filename and file signature, encrypts the source into a private quarantine prefix, and queues it. A separate worker scans with ClamAV, extracts selectable text, and uses OCRmyPDF/Tesseract for image-only PDFs. The consultant must compare the extraction with the source, correct mistakes, choose an audience, and save a draft. A manager approves the reviewed draft; imported documents require a different manager unless the approving account is the owner. Approval creates an immutable content-hashed version and queues 1,536-dimension embeddings using `EMBEDDING_MODEL` (default `text-embedding-3-small`) into a side-by-side pgvector generation.

The source file is downloadable only by an authorised same-farm user. Raw uploads and drafts are never retrieved by Farm AI. Retrieved context contains source markers such as `[Operations Library: Poultry biosecurity v2, section 3]` so the answer can cite the operating guideline it used. Document text remains untrusted data and cannot grant permissions or replace server-side safety rules.

### Still intentionally not included

- Automatic fine-tuning from consultant uploads or raw thumbs feedback. pgvector is retrieval, not training; reviewed documents remain the source of truth. A reviewed/redacted dataset export, evaluation suite, model comparison, and explicit release gate are still required before any fine-tuning experiment.
