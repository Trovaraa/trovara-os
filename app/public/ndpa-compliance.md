# Trovara OS - NDPA Compliance Plan (Future SaaS)

Brief compliance roadmap for Trovara OS when offered as multi-tenant SaaS in Nigeria. This is a planning document, not legal advice.

Regulation: Nigeria Data Protection Act (NDPA) 2023 and Nigeria Data Protection Commission (NDPC) guidance.

## Scope

Trovara OS processes farm operational data: user accounts, task logs, inventory, livestock records, financial summaries, audit trails, and optional WhatsApp integration metadata.

Personal data includes: names, email addresses, phone numbers (customers/workers), session metadata (hashed IP, user agent).

## Data residency

- Primary database: host Postgres in Nigeria (e.g. AWS af-south-1 Lagos or local provider with NDPC registration).
- Backups: encrypted snapshots stored in same jurisdiction.
- CDN/static assets: non-PII only at edge; API and DB remain in-region.
- Cross-border transfer: every transfer an enabled integration performs must be disclosed, assessed, minimised, and protected with NDPC adequacy or contractual safeguards, plus consent where consent is the basis relied on.

Current dev state: local Docker on laptop, not in scope for production compliance.

Note on the transfer bullet: it previously said cross-border transfer was prohibited without consent. That did not match the product, since Meta, Telegram, and the configured AI provider all transfer data outside Nigeria today, so it has been reworded to require that a real transfer be disclosed, assessed, and safeguarded instead.

## Lawful basis and consent

- Farm staff accounts: contract or legitimate interest.
- Customer phones on orders: legitimate interest or consent.
- Analytics/AI summaries: consent where non-essential.
- Marketing: separate opt-in consent, never bundled.

Consent records should capture userId, purpose, version, timestamp, and ipHash.

## Data subject rights

Support requests within 30 days:

- Access: owner can export audit and entity JSON per farm.
- Rectification: in-app edits with audit trail.
- Erasure: tenant offboarding and anonymization where needed.
- Portability: JSON export of operational records.
- Restrict processing: feature flags for non-essential processing.

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

## Third-party analytics

Trovara OS loads no third-party analytics, advertising, or tracking script. Nothing you do in this app is reported to an analytics vendor, and no analytics identifier is stored in your browser. This covers the whole app, including the public traceability lot pages served from the same address. How the product is used is understood from the internal audit trail instead.

The app carries its own Content Security Policy of script-src 'self' and connect-src 'self', built into the page itself, so your browser refuses any external script no matter how the server is configured. The live server was also checked on 26 July 2026 and sends no Content Security Policy header of its own, which would be a second layer on top; adding it is an open item.

A WebMetrix analytics tag was briefly added to this app and was removed. Analytics here would measure identified employees rather than anonymous visitors, and route-level data would show which staff member used which screen and when. That is employee monitoring, and it would need a lawful basis, a monitoring notice, a DPIA, a signed agreement with the vendor, and a working opt-out before it could ever be switched on.

The separate Trovara Farm marketing website does use website analytics for anonymous public visitors, under its own privacy policy. That is a different property and none of it applies to this app or to your staff account.

## Sub-processors

Document before launch:

- Cloud host
- Email/notification provider
- WhatsApp Business API (Meta)
- Payment processor (future)

No analytics provider is listed because Trovara OS sends data to none.

## Pre-launch checklist

- NDPC registration filed.
- DPO appointed and published.
- Privacy policy and terms finalized.
- Data processing agreements signed.
- Nigeria-only production region verified.
- DPIA completed for AI/WhatsApp features.
- Breach notification runbook tested.
- Export/delete API tested.

References:

- https://ndpc.gov.ng/
