# Trovara OS - NDPA Compliance Plan (Future SaaS)

Brief compliance roadmap for Trovara OS when offered as multi-tenant SaaS in Nigeria. This is a planning document, not legal advice.

Regulation: Nigeria Data Protection Act (NDPA) 2023 and Nigeria Data Protection Commission (NDPC) guidance.

## Scope

Trovara OS processes farm operational data: user accounts, task logs, inventory, livestock records, financial summaries, audit trails, and optional WhatsApp integration metadata.

Personal data includes: names, email addresses, phone numbers (customers/workers), session metadata (hashed IP, user agent), and third-party analytics data collected in your browser (pages and app routes opened, device and browser details, connecting IP address, and a persistent visitor identifier). See Third-party analytics below.

## Data residency

- Primary database: host Postgres in Nigeria (e.g. AWS af-south-1 Lagos or local provider with NDPC registration).
- Backups: encrypted snapshots stored in same jurisdiction.
- CDN/static assets: non-PII only at edge; API and DB remain in-region.
- Third-party browser tags: each tag sends data straight from your browser to the vendor, bypassing the in-region API. Every tag, its destination, and its lawful basis must be inventoried.
- Cross-border transfer: every transfer an enabled integration performs must be disclosed, assessed, minimised, and protected with NDPC adequacy or contractual safeguards, plus consent where consent is the basis relied on.

Current dev state: local Docker on laptop, not in scope for production compliance.

Open issue: the WebMetrix analytics tag described below is live in the current app and sends browser data, including your IP address, to analytics.webmetrix.ai on every page load. This is a cross-border transfer unless the vendor is shown to process in Nigeria, and no adequacy or contractual safeguard has been documented yet. The cross-border bullet above previously said such transfers were prohibited without consent; that wording did not match what the product actually does and has been corrected.

## Lawful basis and consent

- Farm staff accounts: contract or legitimate interest.
- Customer phones on orders: legitimate interest or consent.
- AI summaries: consent where non-essential.
- Product analytics (WebMetrix): lawful basis not yet decided, and neither consent nor an opt-out is implemented. See Third-party analytics below.
- Staff app analytics (WebMetrix): the data subjects here are employees, so consent is rarely freely given; this needs an employee monitoring notice and a DPIA, or removal of the tag from the staff app.
- Marketing: separate opt-in consent, never bundled.

Consent records should capture userId, purpose, version, timestamp, and ipHash.

## Data subject rights

Support requests within 30 days:

- Access: owner can export audit and entity JSON per farm.
- Rectification: in-app edits with audit trail.
- Erasure: tenant offboarding and anonymization where needed.
- Portability: JSON export of operational records.
- Restrict processing: feature flags for non-essential processing. There is no in-app control for the analytics tag yet; you can block it in your browser by clearing or blocking cookies and site data for this site, using a private window, or blocking analytics.webmetrix.ai. Doing so does not affect your access to Trovara OS.

## Security measures

Already aligned:

- Argon2 passwords, httpOnly sessions, CSRF on mutations.
- RBAC, farm_id scoping, append-only audit.
- Rate limiting, secure headers, secrets in env.

SaaS additions:

- Encryption at rest.
- TLS 1.2+ everywhere.
- Tenant isolation with farm_id boundaries.
- Incident response playbook with 72h breach notification draft.

## DPO

- DPO appointment: required before public SaaS launch.
- Contact placeholder: dpo@trovara.farm
- NDPC registration: required when processing at scale.

## Retention

- Active operational data: subscription duration plus 90 days export window.
- Audit events: 7 years (or contract/legal requirement).
- Session records: 7 days after expiry.
- Backups: 30 days rolling, encrypted.
- WebMetrix analytics records: retention set by the vendor and not yet confirmed. The browser identifiers expire on their own after a period set by the SDK, which also needs confirming for this app.

## Third-party analytics

A third-party analytics SDK, WebMetrix, is loaded from analytics.webmetrix.ai in the page head of both the public Trovara Farm marketing site and this authenticated Trovara OS staff app, and is initialised with the Trovara tenant identifier. It is live now. Its use in the staff app was not disclosed anywhere until this revision.

Because the SDK runs inside the page and reports directly to the vendor, WebMetrix receives personal data in its own right and counts as a sub-processor and a recipient of your data. An analytics SDK of this kind collects the pages and app routes you open, page titles, the referring page, your browser and device details, your connecting IP address, on-page interactions such as clicks, and a persistent visitor identifier plus a session identifier stored in your browser.

The staff app is the more sensitive of the two properties. The people being measured here are identified employees, not anonymous visitors, and the analytics identifier belongs to the same browser session you sign in with, so route-level analytics can show which staff member used which screen and when. Trovara must not use this data to monitor an individual's productivity, performance, or conduct, or in a disciplinary process, without a separate lawful basis, an employee monitoring notice, and a DPIA.

Not yet confirmed with the vendor: where WebMetrix processes and stores the data, whether it stores or truncates your IP address, exactly which cookies or browser storage keys it sets in this app and for how long, how long it keeps the records, whether it will delete records on request, and whether a data processing agreement is in place.

Note also that the example production web server config for this app sets a Content Security Policy of script-src 'self' and connect-src 'self', which would block the SDK and its beacons. What the live deployment actually sends must be verified.

## Sub-processors

Document before launch:

- Cloud host
- Email/notification provider
- WhatsApp Business API (Meta)
- WebMetrix analytics (analytics.webmetrix.ai), on the marketing site and this app; data processing agreement, processing location, and retention all unconfirmed
- Payment processor (future)

## Pre-launch checklist

- NDPC registration filed.
- DPO appointed and published.
- Privacy policy and terms finalized.
- Data processing agreements signed.
- Nigeria-only production region verified.
- DPIA completed for AI/WhatsApp features.
- DPIA completed for WebMetrix analytics on the authenticated staff app.
- WebMetrix data processing agreement signed, processing location and retention confirmed.
- Lawful basis for analytics decided, and a consent or opt-out control implemented or the tag removed from the staff app.
- Breach notification runbook tested.
- Export/delete API tested.

References:

- https://ndpc.gov.ng/
