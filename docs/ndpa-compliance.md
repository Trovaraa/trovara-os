# Trovara OS - NDPA Compliance Plan

Internal compliance roadmap for the current Trovara Farm deployment and any
future multi-tenant SaaS offering in Nigeria. This is a planning document, not
legal advice. The customer-facing draft is
[`PRIVACY-NOTICE.md`](./PRIVACY-NOTICE.md).

**Regulation:** Nigeria Data Protection Act (NDPA) 2023 and Nigeria Data Protection Commission (NDPC) guidance.

---

## Scope

Trovara OS processes farm operational data: user accounts, task logs, inventory, livestock records, financial summaries, audit trails, and optional WhatsApp integration metadata.

Personal data includes: names, email addresses, phone numbers (customers/workers), session metadata (hashed IP, user agent).

---

## Data residency

| Control | Plan |
|---------|------|
| Primary database | Host Postgres in Nigeria (e.g. AWS `af-south-1` Lagos or local provider with NDPC registration) |
| Backups | Encrypted snapshots stored in same jurisdiction |
| CDN / static assets | Non-PII only at edge; API and DB remain in-region |
| Cross-border transfer | Disclose, assess, minimise, and protect each transfer an enabled integration performs; require NDPC adequacy/contractual safeguards, and consent where that is the basis relied on |

**Current state:** Local development uses Docker; the production deployment is
internet-facing and must be assessed against the controls in this document.

**Note on the transfer row.** It previously read "Prohibited unless explicit
consent + NDPC adequacy/contractual safeguards", which did not match the
product: Meta, Telegram, and the configured AI provider all transfer data
outside Nigeria today. It has been reworded to match the
[`PRIVACY-NOTICE.md`](./PRIVACY-NOTICE.md) section 9 position that an actual
transfer must be disclosed, assessed, and safeguarded rather than described as
prohibited.

---

## Lawful basis & consent

Publishable wording: [`PRIVACY-NOTICE.md`](./PRIVACY-NOTICE.md) (lawful basis / consent sections).

Internal mapping:

| Processing | Basis | Implementation |
|------------|-------|----------------|
| Farm staff accounts | Contract / legitimate interest | Terms of service + role assignment by farm owner |
| Customer phone on orders | Legitimate interest / consent | Field-level notice at order entry; retention policy |
| Analytics / AI summaries | Consent (where non-essential) | Opt-in per farm; no training on tenant data without agreement |
| Marketing | Consent | Separate opt-in; not bundled with product signup |

Consent records: store `{ userId, purpose, version, timestamp, ipHash }` in audit log.

---

## Data subject rights

Publishable rights text: [`PRIVACY-NOTICE.md`](./PRIVACY-NOTICE.md). Support requests within 30 days (NDPA-aligned).

| Right | Trovara OS approach |
|-------|---------------------|
| Access | Owner exports audit + entity JSON per farm |
| Rectification | In-app edit + audit trail |
| Erasure | Tenant offboarding workflow; **pseudonymize** (not hard-delete) workers, customer contacts, and chat text where legal retention applies; audit log rows are never deleted |
| Portability | JSON export (orders, tasks, inventory snapshots) |
| Object / restrict | Feature flags to pause non-essential processing |

---

## Security measures (technical)

Implemented controls and the release gate live in [`security.md`](./security.md). Do not duplicate the Phase 1 list here.

SaaS additions beyond that inventory:

- Encryption at rest (Postgres TDE or volume encryption)
- TLS 1.2+ everywhere (terminate at reverse proxy; see [`nginx-os.trovara.farm.conf.example`](./nginx-os.trovara.farm.conf.example))
- Tenant isolation (row-level `farm_id` + optional schema-per-tenant for enterprise)
- Incident response playbook (72h breach notification draft)

---

## Data Protection Officer (DPO)

| Item | Status |
|------|--------|
| DPO appointment | **Placeholder** - appoint before public SaaS launch |
| Contact | `dpo@trovara.farm` (reserved; not active in dev) |
| NDPC registration | Required when processing at scale; track employee count + annual turnover thresholds |

DPO responsibilities: privacy impact assessments, staff training, NDPC liaison, breach notifications.

---

## Retention

Customer-facing wording: [`PRIVACY-NOTICE.md`](./PRIVACY-NOTICE.md) (retention section).  
Operational env vars: `DATA_RETENTION_DAYS`, `SESSION_RETENTION_DAYS`, `CUSTOMER_CONTACT_RETENTION_DAYS` in `.env.example` / [`PRODUCTION-DEPLOYMENT.md`](./PRODUCTION-DEPLOYMENT.md).  
Backup retention procedure: [`backup-runbook.md`](./backup-runbook.md).

Compliance targets (internal):

| Data type | Retention |
|-----------|-----------|
| Active farm operational data | Duration of subscription + 90 days export window |
| Audit events | 7 years (finance/compliance) or as required by customer contract |
| Session / butler / customer-contact purge | Driven by the retention env vars above |
| Worker/customer erasure | Pseudonymize via owner API; retain orders and audit trail |
| Backups | 30 days rolling; encrypted |

---

## Third-party analytics

**Trovara OS loads no third-party analytics, advertising, or tracking script.**
This covers the whole application, including the public traceability lot pages
served from the same origin. Product usage is understood from the internal
audit trail, not from a vendor SDK.

This is enforced in depth. The app ships its own Content Security Policy as a
meta tag injected at build time, setting `script-src 'self'` and
`connect-src 'self'`, so an external script origin is refused by the browser
whatever the server in front happens to send. That policy was verified against
the built app across the login screens and 21 authenticated views with no
violations.

The belt-and-braces control is still outstanding: a response from
`os.trovara.farm` on 26 July 2026 carried no `Content-Security-Policy` header,
so the deployed server does not match
[`nginx-os.trovara.farm.conf.example`](./nginx-os.trovara.farm.conf.example),
which sets the same policy plus `frame-ancestors`. Bringing the live config up
to the example is an open item.

A WebMetrix analytics tag was briefly added to the app and was removed. The
reasoning is recorded here because it governs any future proposal: staff-app
analytics measures **identified employees**, the analytics identifier would sit
in the same browser session used to sign in, and route-level data would reveal
which staff member used which screen and when. That is employee monitoring, and
it would require a lawful basis that survives the employer/employee imbalance,
a monitoring notice, a DPIA, a signed DPA, and a working opt-out before it
could be enabled.

Out of scope for this document: the separate Trovara Farm marketing site
(`trovara.farm`) does use website analytics for anonymous visitors, under its
own privacy policy, its own CSP allowlist, and its own sub-processor list.
Nothing in that arrangement extends to Trovara OS.

---

## Sub-processors

Document and verify for the current production configuration:

- Cloud host (Postgres, compute)
- Email / notification provider
- Telegram (staff and customer bots)
- WhatsApp Business API (Meta) - data processing agreement required
- Configured AI provider (text, images, transcription, and TTS)
- Payment processor (future)

No analytics provider is listed because Trovara OS sends data to none.

Maintain the provider, purpose, data categories, processing location, and
transfer safeguards in a sub-processor register. Summarise enabled providers in
the customer-facing privacy notice.

---

## Pre-launch checklist

- [ ] NDPC registration filed
- [ ] DPO appointed and published contact
- [x] Draft privacy notice created (`PRIVACY-NOTICE.md`)
- [x] Public privacy notice published at https://trovara.farm/privacy (keep OS `PRIVACY-NOTICE.md` aligned; counsel review recommended)
- [ ] Terms of service completed (jurisdiction: Nigeria)
- [ ] Data processing agreements with sub-processors
- [ ] Nigeria-only production region verified
- [ ] DPIA for AI/WhatsApp features
- [ ] DPIA for any public-ledger/tokenization feature before implementation
- [ ] Breach notification runbook tested
- [ ] Customer data export/delete API tested

---

## References

- [NDPC Nigeria](https://ndpc.gov.ng/)
- Trovara internal: [`PRIVACY-NOTICE.md`](./PRIVACY-NOTICE.md), [`security.md`](./security.md), [`backup-runbook.md`](./backup-runbook.md), [`operating-model.md`](./operating-model.md)
