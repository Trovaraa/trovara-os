# Talent — recruitment at Trovara

## Durable project decisions

Confirmed by the owner on 2026-09-13: **Zoho is Trovara's only email provider. Recruitment uses hello@trovara.farm. There is no careers@trovara.farm mailbox.** Do not change MX records, move the mailbox to another provider, or ingest unrelated hello inbox mail. Existing non-Talent integrations are outside this change.

## What is implemented

- `/talent`: restricted applications list with name/email/role search, stage, role, reviewer, received-date and needs-review filters; 50-row pagination.
- Separate candidates and applications. One candidate can apply for multiple roles. Existing public Careers records remain the job catalogue.
- CV-only PDF/DOCX uploads, up to 10 MB each. Batch uploads of up to 20 files are processed individually, with per-file results. The name can remain unknown until review.
- Original `.eml` imports preserve messages, dates and attachments. Zoho uses the same ingestion pipeline. Unrelated messages from the same sender are separate applications unless reference headers identify a known thread or the subject contains an exact Talent reference. Both matching methods require the same candidate email and farm. Outgoing Talent messages include that reference. No automatic role assignment based on subject wording.
- Private document downloads, extracted source text and suggested name/contact/summary/education/experience/skills/certification/language sections. Suggestions must be checked against the original. Headings/layouts vary: missing fields remain empty, unknown sections remain in the full text. Scanned PDFs use local OCR; unavailable or unsuccessful OCR is explicitly marked for manual review. No external LLM receives applicant data; no ranking/rejection automation.
- Hiring stages, reviewer assignment, next action/due date with overdue indicators, private notes, email timeline and explicit Zoho send confirmation.
- Candidate email matching does not overwrite an existing profile during intake. The review form offers explicit linking when a CV belongs to an existing candidate. Updating a shared candidate's contact details affects all their applications.
- Public job application form without account creation; a server-generated application reference is returned. Email is always hello@trovara.farm. The form is feature-gated until backend dependencies are ready.

## Configuration and activation

Deploy the API migration and code before the marketing form. Do not enable public intake until the scanner, encrypted object store, extraction worker and retention process are verified.

Add these values to the **server secret environment**, never to Git, browser code, tickets or chat:

```dotenv
# Public form remains off until explicitly enabled.
TALENT_PUBLIC_APPLICATIONS_ENABLED=false
# Explicit farm binding is mandatory for the worker and mailbox access.
TALENT_FARM_ID=<Trovara farm UUID>
TALENT_ZOHO_REGION=com
TALENT_ZOHO_ACCOUNT_ID=<hello mailbox account ID>
TALENT_ZOHO_CLIENT_ID=<OAuth client ID>
TALENT_ZOHO_CLIENT_SECRET=<OAuth client secret>
TALENT_ZOHO_REFRESH_TOKEN=<offline OAuth refresh token>
TALENT_ZOHO_FOLDER_IDS=<recruitment folder ID>,<optional second folder ID>
TALENT_ZOHO_ENABLED=false
TALENT_ZOHO_SEND_ENABLED=false
TALENT_RETENTION_ENABLED=false
```

1. In Zoho, create/use dedicated recruitment folders under the **hello@trovara.farm** mailbox, e.g. the existing Farm Supervisor Applicants folder. Move/copy the selected historical applications there. Use specific mail rules for new recruitment messages and manually file ambiguous ones. Do not configure the general Inbox folder. Moving mail and setting rules require owner approval; the integration does neither.
2. Create an OAuth client and offline refresh token. Runtime intake requires `ZohoMail.messages.READ`. Optional sending requires `ZohoMail.messages.CREATE`. Account/folder discovery can use `ZohoMail.accounts.READ` and `ZohoMail.folders.READ` during setup. The READ OAuth grant itself is mailbox-wide; the application restricts reads to the configured folders, so keep credentials server-side and access tightly controlled. Verify the account ID belongs to hello before enabling it. Check that the Zoho plan permits API access.
3. Choose the account's data centre (`com`, `eu`, `in`, `com.au`, `jp`, `ca`). Origins are allowlisted, not arbitrary environment URLs. No DNS/MX changes and no Resend intake are used for Talent.
4. Use the existing `CLAMAV_*` and `KNOWLEDGE_STORAGE_*` configuration. The API and worker must share the same private S3-compatible storage and encryption key. Production fails closed when scanning/storage is unavailable. Do not point these keys at a public bucket.
   Configure the reverse proxy for at least 12 MB request bodies and sufficient scan/upload time. Ensure it overwrites untrusted client-IP headers and that `TRUSTED_PROXY_HOPS` matches the real proxy chain, so public rate limits use a trusted client identity.
5. Run `npm run db:migrate`. Grant staff `talent.read` and optionally `talent.manage`; admins also need `talent.admin`. Owners automatically have access. Publishing jobs (`careers.manage`) does not grant applicant access. Assignment alone does not grant access; grant the reviewer permissions separately.
6. Start the resource-limited worker with `docker compose -f docker-compose.yml -f docker-compose.talent.yml up -d talent-worker`. Alternatively supervise `npm run talent-worker` once per minute using a restricted service account with OCRmyPDF installed. It processes a bounded intake page, up to 10 extraction jobs, receipts and expired records per run. Extraction runs in subprocesses with memory/time limits. Monitor exit failures and the intake status shown in Talent.
7. Verify a synthetic CV import, original download, suggested extraction, manual review, receipt, cross-user permission denial and retention on **test data**. Enable `TALENT_RETENTION_ENABLED=true` in the worker once the 180-day policy has been approved. Then enable public intake and optionally automatic Zoho intake/sending. Manual Zoho sync remains available to Talent admins when configured.

Zoho intake processes five emails per configured folder per run, retaining a cursor and rescanning after reaching the end. Message-ID fingerprints prevent duplicates across rescans and EML uploads. Failures are surfaced and retried on later passes; large/unsupported or infected messages may need manual action. Source mail is never deleted, moved, marked read, or sent a historical bulk acknowledgement by the importer. Public form receipts are the only automatic outgoing emails. Other messages require an explicit user send action.

Delivery failures can be ambiguous. Outgoing request IDs prevent automatic retry duplicates. Check Zoho Sent before resending an uncertain message; do not claim receipt delivery solely from application acceptance. The website always displays the reference even if email sending is not enabled.

## Privacy and security

- All staff routes require authentication and `talent.read`; mutations additionally require `talent.manage`. Destructive/retention/intake actions also require `talent.admin`. Every query is farm-scoped, with composite foreign keys for applications/documents/events.
- Sources are malware-scanned before accepting them. PDF/DOCX type and size validation and DOCX expansion limits are enforced. Original email HTML is never rendered; messages and CV text use escaped Vue interpolation. Unknown email attachments are retained in the scanned original EML, not extracted or rendered.
- Files use existing AES-256-GCM encrypted private object storage. Authenticated downloads are audited, attachment-only, no-store and nosniff. No permanent public URLs or applicant records are placed in browser localStorage or service-worker caches. Applicant text/profile fields in PostgreSQL rely on production DB/disk and backup encryption; restrict database access accordingly.
- Public submission has strict field validation, request-body bounds, per-IP and per-email durable rate limits, a honeypot, published-job/deadline checks and a versioned privacy acknowledgement. No public endpoint reads application status or CVs.
- Default retention: 180 days after receipt into Talent (historical imports start their retention window at import, preserving their original received date separately). All stages, including hired, are covered; move necessary employment records into the appropriate staff workflow instead of indefinitely retaining the whole CV. An admin can document a future retention date within one year.
- Expired records are removed by the opted-in retention worker; admins can explicitly erase an application. Objects are deleted before DB references are removed, and interrupted deletion remains hidden/retryable. The last application deletion removes the candidate profile. Audit logs retain action/entity IDs, not CV contents. Non-content source fingerprints prevent rescanning an old email/export from recreating an erased application.
- Source mail in Zoho and encrypted backups have separate retention: an OS deletion does not delete the source mailbox or immutable backup copies. Apply the agreed mailbox/backup policy and rerun deletion/retention after a restore before exposing applicant records. Do not promise immediate erasure from all backups.
- Applicant access/correction/withdrawal/deletion requests go to hello@trovara.farm and need identity verification by hiring staff. Recruitment permission grants and policy approval remain owner responsibilities.

## Rollout / rollback

Use synthetic data first. Keep `TALENT_PUBLIC_APPLICATIONS_ENABLED=false` and `TALENT_ZOHO_ENABLED=false` to pause new intake; the email fallback remains available. Disable `TALENT_ZOHO_SEND_ENABLED` to pause outgoing mail. Roll back application code without dropping Talent tables or storage. Back up both database and encrypted objects/keys before migration. Do not remove objects as part of code rollback.

## Verification

- `npm test`: API, Vue app and release-tool regression tests.
- `npm run typecheck`, `npm run lint`, `npm run build`.
- `npm run test:migration-upgrade` against a disposable PostgreSQL/pgvector database only.
- `TALENT_TEST_DATABASE_URL=<local talent_test database URL> npm run test:talent-integration -w api`: real-database intake, deduplication, permissions, cross-farm denial, extraction/download, notes, candidate linking, job preservation, supporting uploads and retention tests. The test configuration refuses non-local or non-`talent_test` database names. The fixture skips ClamAV and uses encrypted local temporary storage; real production scanner/OCR/Zoho verification is still required before activation.
- Marketing repository: `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`. Preview redirect tests prevent production application writes from previews.
- Local visual QA uses synthetic applicants, not inbox contents. Verify both mobile and desktop form layout, keyboard access, loading/error states and theme contrast.

## Zoho API references

- https://www.zoho.com/mail/help/api/using-oauth-2.html
- https://www.zoho.com/mail/help/api/get-emails-list.html
- https://www.zoho.com/mail/help/api/get-original-message.html
- https://www.zoho.com/mail/help/api/post-send-an-email.html
