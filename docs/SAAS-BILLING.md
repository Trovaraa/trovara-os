# SaaS Billing - Placeholder Roadmap

Trovara OS currently runs as a **single-farm deployment** on your laptop for Trovara Farm. This document describes what is needed to **sell Trovara OS to other farms** as a SaaS product.

## Current state

| Item | Status |
|------|--------|
| Multi-tenant schema (`farm_id`) | ✅ Exists |
| Tenant isolation in API | ⚠️ Partial - single farm in practice |
| Stripe / Paystack billing | ❌ Not implemented |
| Public signup | ❌ Not implemented |
| `GET /api/billing/status` | ✅ Placeholder roadmap JSON |
| `POST /api/billing/checkout` | ❌ Returns 501 |

## What to build before selling to other farms

### 1. Product & legal
- [ ] Pick external brand name (Trovara Origin, FarmOps AI, etc.)
- [ ] Trademark search (Nigeria + target export markets)
- [ ] Nigeria NDPA compliance - see `docs/ndpa-compliance.md`
- [ ] Terms of service + farm data processing agreement
- [ ] Pricing: per-farm/month vs per-user vs per-hectare

### 2. Multi-tenant architecture
- [ ] Signup wizard: farm name, location, owner email, plan selection
- [ ] Provision new `farms` row + owner user + default zones/templates
- [ ] Strict tenant scoping audit - every query filters by `farm_id`
- [ ] Subdomain or path routing: `{farm}.trovara.app` or `/f/{slug}`
- [ ] Disable `reset-demo` in production multi-tenant mode

### 3. Billing (Stripe or Paystack for Nigeria)
- [ ] Create Stripe/Paystack account for Trovara Ltd
- [ ] Products: Starter / Growth / Enterprise
- [ ] `POST /api/billing/checkout` → Stripe Checkout Session
- [ ] Webhook: `invoice.paid`, `customer.subscription.deleted`
- [ ] Store `stripe_customer_id`, `subscription_status` on `farms` table
- [ ] Grace period + read-only mode when subscription lapses

### 4. Operations
- [ ] Managed Postgres (or per-tenant DB for enterprise)
- [ ] HTTPS + custom domain
- [ ] Automated backups per tenant
- [ ] Support channel (WhatsApp Business, email)
- [ ] Onboarding call / demo for first 10 farms

### 5. Go-to-market
- [ ] Landing page separate from Trovara marketing site
- [ ] 14-day trial with seed data (like current demo)
- [ ] Case study: Trovara Farm Abeokuta as customer zero
- [ ] Partner with agric extension agents in Ogun / SW Nigeria

## Environment variables (future)

```bash
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_STARTER=price_...
BILLING_ENABLED=true
```

## API placeholder

```http
GET /api/billing/status   → roadmap + enabled: false
POST /api/billing/checkout → 501 until Stripe wired
```

## Recommended pricing sketch (Nigeria)

| Plan | Farms | Users | Price (NGN/mo) |
|------|-------|-------|----------------|
| Starter | 1 | 10 | ₦25,000 |
| Growth | 3 | 30 | ₦65,000 |
| Enterprise | Unlimited | Custom | Contact |

Adjust after first 5 paying farms.
