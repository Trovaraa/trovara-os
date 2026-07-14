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
- Cross-border transfer: prohibited unless explicit consent plus NDPC adequacy/contractual safeguards.

Current dev state: local Docker on laptop, not in scope for production compliance.

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

## Sub-processors

Document before launch:

- Cloud host
- Email/notification provider
- WhatsApp Business API (Meta)
- Payment processor (future)

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
