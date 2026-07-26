# Trovara OS - NDPA Compliance Plan

Internal compliance roadmap for the current Trovara Farm deployment and any
future multi-tenant SaaS offering in Nigeria. This is a planning document, not
legal advice. The customer-facing draft is
[`PRIVACY-NOTICE.md`](./PRIVACY-NOTICE.md).

**Regulation:** Nigeria Data Protection Act (NDPA) 2023 and Nigeria Data Protection Commission (NDPC) guidance.

---

## Scope

Trovara OS processes farm operational data: user accounts, task logs, inventory, livestock records, financial summaries, audit trails, and optional WhatsApp integration metadata.

Personal data includes: names, email addresses, phone numbers (customers/workers), session metadata (hashed IP, user agent), and third-party analytics data collected in the browser (route views, device/browser details, connecting IP, persistent visitor identifier) - see [Third-party analytics](#third-party-analytics).

---

## Data residency

| Control | Plan |
|---------|------|
| Primary database | Host Postgres in Nigeria (e.g. AWS `af-south-1` Lagos or local provider with NDPC registration) |
| Backups | Encrypted snapshots stored in same jurisdiction |
| CDN / static assets | Non-PII only at edge; API and DB remain in-region |
| Third-party browser tags | Each tag sends data direct from the browser to the vendor, bypassing the in-region API. Inventory every tag, its destination, and its lawful basis |
| Cross-border transfer | Disclose, assess, minimise, and protect each transfer an enabled integration performs; require NDPC adequacy/contractual safeguards, and consent where that is the basis relied on |

**Current state:** Local development uses Docker; the production deployment is
internet-facing and must be assessed against the controls in this document.

**Open issue - analytics contradicts this table.** The WebMetrix tag now on both
the marketing site and the staff app transmits browser data, including the
connecting IP, to `analytics.webmetrix.ai` on every page load. This is a
cross-border transfer unless the vendor is shown to process in Nigeria, it is
running without consent, and no adequacy or contractual safeguard has been
documented. The "Cross-border transfer" row previously read "Prohibited unless
explicit consent + NDPC adequacy/contractual safeguards" and was already
inaccurate for Meta, Telegram, and the AI provider; it has been reworded to
match the [`PRIVACY-NOTICE.md`](./PRIVACY-NOTICE.md) position that an actual
transfer must be disclosed and safeguarded rather than described as prohibited.

---

## Lawful basis & consent

| Processing | Basis | Implementation |
|------------|-------|----------------|
| Farm staff accounts | Contract / legitimate interest | Terms of service + role assignment by farm owner |
| Customer phone on orders | Legitimate interest / consent | Field-level notice at order entry; retention policy |
| AI summaries | Consent (where non-essential) | Opt-in per farm; no training on tenant data without agreement |
| Product analytics (WebMetrix) | **Undecided** - consent or legitimate interest | **Not implemented.** Tag is live on both properties with no opt-in, no opt-out, and no balancing assessment on file |
| Staff-app analytics (WebMetrix) | **Undecided** - employees as data subjects | Employee consent is rarely freely given; needs a monitoring notice + DPIA, or removal of the tag from the authenticated app |
| Marketing | Consent | Separate opt-in; not bundled with product signup |

Consent records: store `{ userId, purpose, version, timestamp, ipHash }` in audit log.

---

## Data subject rights

Support requests within 30 days (NDPA-aligned):

| Right | Trovara OS approach |
|-------|---------------------|
| Access | Owner exports audit + entity JSON per farm |
| Rectification | In-app edit + audit trail |
| Erasure | Tenant offboarding workflow; **pseudonymize** (not hard-delete) workers, customer contacts, and chat text where legal retention applies; audit log rows are never deleted |
| Portability | JSON export (orders, tasks, inventory snapshots) |
| Object / restrict | Feature flags to pause non-essential processing. **Gap:** no flag or preference control exists for the WebMetrix tag; users can only block cookies/site data, browse privately, or block `analytics.webmetrix.ai` in the browser |

---

## Security measures (technical)

Already aligned in Phase 1 (see [`security.md`](./security.md)):

- Argon2 passwords, httpOnly sessions, CSRF on mutations
- RBAC, farm_id scoping, append-only audit
- Rate limiting, secure headers, secrets in env

SaaS additions:

- Encryption at rest (Postgres TDE or volume encryption)
- TLS 1.2+ everywhere
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

| Data type | Retention |
|-----------|-----------|
| Active farm operational data | Duration of subscription + 90 days export window |
| Audit events | 7 years (finance/compliance) or as required by customer contract |
| Session records | Purged `SESSION_RETENTION_DAYS` after expiry (default 7) |
| Butler chat text (`farm_events`) | Redacted to `[redacted]` after `DATA_RETENTION_DAYS`; event row kept |
| Customer contact phones | Nulled after `CUSTOMER_CONTACT_RETENTION_DAYS` (defaults to `DATA_RETENTION_DAYS`) |
| Worker/customer erasure requests | Pseudonymize name/email/phone via owner API; retain orders and audit trail |
| Backups | 30 days rolling; encrypted |
| WebMetrix analytics records | **Unknown** - vendor-controlled; confirm the retention period and whether deletion by visitor identifier is supported |
| WebMetrix browser identifiers | Expire per the lifetimes set by the SDK; **confirm the values that apply on the staff app** |

---

## Third-party analytics

A third-party analytics SDK, **WebMetrix**, is loaded from
`https://analytics.webmetrix.ai/sdk/webmetrix.analytics.min.js` in the `<head>`
of both properties and initialised with the Trovara tenant identifier:

| Property | Audience | Status |
|----------|----------|--------|
| Marketing site (`trovara.farm`) | Anonymous public visitors | Live; disclosed in the site's own privacy policy |
| Trovara OS app (`os.trovara.farm`) | Authenticated farm staff | Live; **was undisclosed** until this revision |

Because the SDK executes in the page, it is a recipient of personal data in its
own right and must be registered as a sub-processor. What a general web
analytics SDK of this kind collects: route/page views and titles, referrer,
browser and device metadata, the connecting IP address (sent by the browser on
every request), a persistent visitor identifier plus a session identifier held
in browser storage, and on-page interaction events.

Risks specific to the staff app:

- Data subjects are **identified employees**, not anonymous visitors. The
  analytics identifier sits in the same browser session used to sign in, so
  route-level analytics can reveal which staff member used which screen and
  when. Treat as employee monitoring unless demonstrated otherwise.
- No consent, opt-out, or preference control exists in either property.
- The tag was added without a DPIA, a sub-processor entry, or a DPA.
- The example production CSP in
  [`nginx-os.trovara.farm.conf.example`](./nginx-os.trovara.farm.conf.example)
  is `script-src 'self'` / `connect-src 'self'`, which would block the SDK and
  its beacons. Confirm what the live deployment actually sends before relying
  on either the analytics data or the assumption that no data leaves.

Required before this is compliant: decide the lawful basis, obtain a DPA and
the vendor's processing locations, complete a DPIA for the staff-app
deployment, and either implement a control or remove the tag from the
authenticated app. See [`PRIVACY-NOTICE.md`](./PRIVACY-NOTICE.md) section 14.

---

## Sub-processors

Document and verify for the current production configuration:

- Cloud host (Postgres, compute)
- Email / notification provider
- Telegram (staff and customer bots)
- WhatsApp Business API (Meta) - data processing agreement required
- Configured AI provider (text, images, transcription, and TTS)
- WebMetrix analytics (`analytics.webmetrix.ai`) - marketing site and staff app;
  **data processing agreement, processing location, and retention all unconfirmed**
- Payment processor (future)

Maintain the provider, purpose, data categories, processing location, and
transfer safeguards in a sub-processor register. Summarise enabled providers in
the customer-facing privacy notice.

---

## Pre-launch checklist

- [ ] NDPC registration filed
- [ ] DPO appointed and published contact
- [x] Draft privacy notice created (`PRIVACY-NOTICE.md`)
- [ ] Draft privacy notice legally reviewed, operational details completed, and published
- [ ] Terms of service completed (jurisdiction: Nigeria)
- [ ] Data processing agreements with sub-processors
- [ ] Nigeria-only production region verified
- [ ] DPIA for AI/WhatsApp features
- [ ] DPIA for WebMetrix analytics on the authenticated staff app (employee monitoring)
- [ ] WebMetrix DPA signed, processing location and retention confirmed, sub-processor register updated
- [ ] Lawful basis for analytics decided and a consent or opt-out control implemented, or the tag removed from the staff app
- [ ] DPIA for any public-ledger/tokenization feature before implementation
- [ ] Breach notification runbook tested
- [ ] Customer data export/delete API tested

---

## References

- [NDPC Nigeria](https://ndpc.gov.ng/)
- Trovara internal: [`PRIVACY-NOTICE.md`](./PRIVACY-NOTICE.md), [`security.md`](./security.md), [`backup-runbook.md`](./backup-runbook.md), [`operating-model.md`](./operating-model.md)
