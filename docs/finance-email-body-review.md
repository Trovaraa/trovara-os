# Finance email body review

Finance intake can nominate a pending expense from the email body when no supported PDF/JPEG/PNG/WebP attachment is available. It remains restricted to the existing configured finance recipient and farm; it does not scan other Zoho folders or change mail routing.

## Processing and review

- Apply a shared security-notification exclusion before either intake path, attachment download or AI call. Zoho sign-in notifications, login alerts, password resets and verification messages are ignored even with inline images or PDFs.
- Check financial relevance for attachments too: readable PDF text is classified and image attachments receive vision classification. A logo or arbitrary supported file alone no longer creates an expense. Unreadable documents, unavailable vision review and attachment-list/download failures remain retryable rather than being silently discarded. Attachment downloads reject redirects.
- Convert HTML to inert bounded text, excluding script/style and embedded executable content. Do not fetch links, cloud-drive videos, remote images or documents linked in the body.
- Use the existing configured LLM and farm budget to classify transaction relevance. Require typed JSON and an exact evidence quote for positive classifications. Treat message content as data, not model instructions. Invalid output, exhausted budget or provider failure uses conservative transaction rules; security alerts and unrelated messages are not imported by those rules. Classification is not infallible.
- Retain up to 64,000 characters of body evidence privately as `finance-email.txt`, with sender, subject and received timestamp. AI classification sees at most 11,000 body characters. Existing farm-scoped Finance attachment access protects the text copy.
- Extract suggested amount/vendor/date with the existing invoice extractor. Missing amounts remain zero and need review. A claim that something was paid does **not** create a payment, historical settlement or approval. Every new record is pending.
- Blank subjects fall back to sender plus a short body excerpt, instead of an empty invoice title. Ungrouped amounts such as `48150` are no longer truncated to three digits.

In **Finance**, look for **Email review required:** drafts. Open the expense drawer, view **Attachment** to read the retained email, verify the amount/currency/vendor/date and cost coding, then use the normal approval process. Record an actual payment or historical settlement only after independently verifying it. Retry extraction also supports these text evidence files.

## Rollout / historical mail

This changes API source/runtime and dependency resolutions, with no schema, environment, mail-provider or permission changes. Deploy the verified API, patched dependencies and both document-processing workers after the usual production backup/baseline checks. Rebuild the frontend with the patched build dependencies; UI behavior is unchanged.

Previously ignored events remain terminal and are **not** bulk replayed by deployment. Recovery must identify a specific original event, verify no expense already exists for that message, preserve its audit history and use the normal idempotency safeguards. Do not forward old invoices repeatedly or automatically mark them paid. Imported dates may differ from email arrival dates; use an all-time expense search when investigating missing mail.

Automated tests cover body-only pending drafts/evidence, grounded and malformed AI output, provider/budget fallback, irrelevant/security mail, HTML sanitization, attachment failures, no network fetch for body-only messages, extraction retries and amount parsing. Tests use synthetic messages only.

## Dependency remediation (2026-10-15)

The original main audit reported seven affected entries. Patched `concurrently` to 10.0.6 (shell-quote 1.12.0), source-map-js to 1.2.2 and postcss-selector-parser to 7.1.6. Mammoth stays at 1.13.0; a narrowly scoped override replaces its obsolete CLI-only argparse 1 dependency with argparse 2.0.1, removing the unpatched sprintf-js chain. Tests exercise real DOCX conversion through both Mammoth's library and legacy CLI, as well as lockfile security floors. The CLI emits deprecation warnings for its old argument-parser API but remains functional. No audit suppression or ancient Mammoth downgrade is used.
