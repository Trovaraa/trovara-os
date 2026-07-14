# Trovara OS — NDPA Compliance Plan (Future SaaS)

Brief compliance roadmap for Trovara OS when offered as multi-tenant SaaS in Nigeria. This is a planning document, not legal advice.

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
| Cross-border transfer | Prohibited unless explicit consent + NDPC adequacy/contractual safeguards |

**Current dev state:** Local Docker on laptop — not in scope for production compliance.

---

## Lawful basis & consent

| Processing | Basis | Implementation |
|------------|-------|----------------|
| Farm staff accounts | Contract / legitimate interest | Terms of service + role assignment by farm owner |
| Customer phone on orders | Legitimate interest / consent | Field-level notice at order entry; retention policy |
| Analytics / AI summaries | Consent (where non-essential) | Opt-in per farm; no training on tenant data without agreement |
| Marketing | Consent | Separate opt-in; not bundled with product signup |

Consent records: store `{ userId, purpose, version, timestamp, ipHash }` in audit log.

---

## Data subject rights

Support requests within 30 days (NDPA-aligned):

| Right | Trovara OS approach |
|-------|---------------------|
| Access | Owner exports audit + entity JSON per farm |
| Rectification | In-app edit + audit trail |
| Erasure | Tenant offboarding workflow; anonymize where legal retention applies |
| Portability | JSON export (orders, tasks, inventory snapshots) |
| Object / restrict | Feature flags to pause non-essential processing |

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
| DPO appointment | **Placeholder** — appoint before public SaaS launch |
| Contact | `dpo@trovara.farm` (reserved; not active in dev) |
| NDPC registration | Required when processing at scale; track employee count + annual turnover thresholds |

DPO responsibilities: privacy impact assessments, staff training, NDPC liaison, breach notifications.

---

## Retention

| Data type | Retention |
|-----------|-----------|
| Active farm operational data | Duration of subscription + 90 days export window |
| Audit events | 7 years (finance/compliance) or as required by customer contract |
| Session records | 7 days after expiry |
| Backups | 30 days rolling; encrypted |

---

## Sub-processors

Document before launch:

- Cloud host (Postgres, compute)
- Email / notification provider
- WhatsApp Business API (Meta) — data processing agreement required
- Payment processor (future)

Maintain sub-processor list in customer-facing privacy policy.

---

## Pre-launch checklist

- [ ] NDPC registration filed
- [ ] DPO appointed and published contact
- [ ] Privacy policy + terms (jurisdiction: Nigeria)
- [ ] Data processing agreements with sub-processors
- [ ] Nigeria-only production region verified
- [ ] DPIA for AI/WhatsApp features
- [ ] Breach notification runbook tested
- [ ] Customer data export/delete API tested

---

## References

- [NDPC Nigeria](https://ndpc.gov.ng/)
- Trovara internal: [`security.md`](./security.md), [`backup-runbook.md`](./backup-runbook.md), [`operating-model.md`](./operating-model.md)
