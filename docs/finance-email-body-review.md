# Finance email body review

Finance intake can nominate a pending expense from the email body when no supported PDF/JPEG/PNG/WebP attachment is available. It remains restricted to the existing configured finance recipient and farm; it does not scan other Zoho folders or change mail routing.

## Processing and review

- Prefer the existing receipt attachment path. Attachment-list/download failures remain retryable rather than being recorded as ignored. Attachment downloads reject redirects.
- Convert HTML to inert bounded text, excluding script/style and embedded executable content. Do not fetch links, cloud-drive videos, remote images or documents linked in the body.
- Use the existing configured LLM and farm budget to classify transaction relevance. Require typed JSON and an exact evidence quote for positive classifications. Treat message content as data, not model instructions. Invalid output, exhausted budget or provider failure uses conservative transaction rules; security alerts and unrelated messages are not imported by those rules. Classification is not infallible.
- Retain up to 64,000 characters of body evidence privately as `finance-email.txt`, with sender, subject and received timestamp. AI classification sees at most 11,000 body characters. Existing farm-scoped Finance attachment access protects the text copy.
- Extract suggested amount/vendor/date with the existing invoice extractor. Missing amounts remain zero and need review. A claim that something was paid does **not** create a payment, historical settlement or approval. Every new record is pending.
- Blank subjects fall back to sender plus a short body excerpt, instead of an empty invoice title. Ungrouped amounts such as `48150` are no longer truncated to three digits.

In **Finance**, look for **Email review required:** drafts. Open the expense drawer, view **Attachment** to read the retained email, verify the amount/currency/vendor/date and cost coding, then use the normal approval process. Record an actual payment or historical settlement only after independently verifying it. Retry extraction also supports these text evidence files.

## Rollout / historical mail

This is an API source/runtime change with no schema, environment, mail-provider, permission or dependency changes. Deploy the API after tests and the usual production backup/baseline checks. No frontend update is required.

Previously ignored events remain terminal and are **not** bulk replayed by deployment. Recovery must identify a specific original event, verify no expense already exists for that message, preserve its audit history and use the normal idempotency safeguards. Do not forward old invoices repeatedly or automatically mark them paid. Imported dates may differ from email arrival dates; use an all-time expense search when investigating missing mail.

Automated tests cover body-only pending drafts/evidence, grounded and malformed AI output, provider/budget fallback, irrelevant/security mail, HTML sanitization, attachment failures, no network fetch for body-only messages, extraction retries and amount parsing. Tests use synthetic messages only.

## Dependency gate (2026-10-15)

A fresh audit of unchanged main dependencies reports seven affected package entries: `shell-quote`/`concurrently` (critical), `source-map-js` (high), `postcss-selector-parser` and the `mammoth` → `argparse` → `sprintf-js` chain (moderate). The registry still lists `sprintf-js` 1.1.3 as latest, within the advisory range. Do not use npm's suggested downgrade to Mammoth 0.3.29, suppress the gate, or describe this branch as audit-clean. Dependency remediation is separate from this feature; production rollout is pending it. No manifest or lockfile changes are included here.
