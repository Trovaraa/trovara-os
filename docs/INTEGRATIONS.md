# Trovara OS - Integrations Guide

Index of integration setup. Channel- and payment-specific runbooks live in
dedicated docs. This file keeps the shared env map and topics not covered
elsewhere (AI, cron, public QR, offline queue, seed to real data).

| Topic | Canonical doc |
|-------|----------------|
| Telegram staff + customer bots | [`TELEGRAM-COPILOT.md`](./TELEGRAM-COPILOT.md) |
| WhatsApp Meta setup, curl sim, go-live | [`WHATSAPP-COPILOT.md`](./WHATSAPP-COPILOT.md) |
| Customer order Paystack | [`PAYSTACK.md`](./PAYSTACK.md) |
| Production deploy / secrets | [`PRODUCTION-DEPLOYMENT.md`](./PRODUCTION-DEPLOYMENT.md) |
| One-time clean go-live (wipe demo) | [`../../GO-LIVE.md`](../../GO-LIVE.md) |
| Encrypted backup / restore | [`backup-runbook.md`](./backup-runbook.md) |
| Health probes and uptime snapshots | [`uptime-monitoring.md`](./uptime-monitoring.md) |
| API contracts | [`API.md`](./API.md) |
| Product RBAC | [`ROLE-PERMISSION-MATRIX.md`](./ROLE-PERMISSION-MATRIX.md) |
| Security controls + release gate | [`security.md`](./security.md) |

---

## Environment variables overview

Copy `.env.example` to `.env` and uncomment the sections you need. Never commit `.env`. Full production secret generation: [`PRODUCTION-DEPLOYMENT.md`](./PRODUCTION-DEPLOYMENT.md).

| Section | Required for | Key variables |
|---------|--------------|---------------|
| Postgres | Always | `POSTGRES_*`, `DATABASE_URL` |
| API core | Always | `API_HOST`, `API_PORT`, `NODE_ENV` |
| CORS / frontend | Production | `CORS_ORIGIN`, `VITE_API_URL`, `VITE_PUBLIC_APP_URL`, `PUBLIC_APP_URL` |
| Break-glass | Emergency owner login (arm with `BREAK_GLASS_ENABLED`) | `BREAK_GLASS_PASSWORD`, optional `BREAK_GLASS_EMAIL`; `BREAK_GLASS_ENABLED=true` only while recovering |
| Seed users | Local demo seed | `SEED_SUPERVISOR_PASSWORD`, `SEED_WORKER_PASSWORD`, `SEED_SALES_PASSWORD` |
| WhatsApp | Staff + customer bots | `WHATSAPP_*`, `WHATSAPP_CUSTOMER_PHONE_NUMBER_ID`, `META_APP_SECRET` — see [`WHATSAPP-COPILOT.md`](./WHATSAPP-COPILOT.md) |
| Telegram | Staff + customer bots | `TELEGRAM_*` — see [`TELEGRAM-COPILOT.md`](./TELEGRAM-COPILOT.md) |
| Paystack | Customer order payments | `PAYSTACK_SECRET_KEY`, `PAYSTACK_PUBLIC_KEY` — see [`PAYSTACK.md`](./PAYSTACK.md) |
| Email + public forms | Newsletter, password reset, contact/waitlist alerts | `RESEND_*`, `EMAIL_FROM`, optional `MARKETING_LEAD_NOTIFICATION_EMAILS` — see [`PRODUCTION-DEPLOYMENT.md`](./PRODUCTION-DEPLOYMENT.md) and [`API.md`](./API.md) |
| Finance invoice inbound | Resend Receiving → draft expenses | `RESEND_API_KEY`, `RESEND_INBOUND_WEBHOOK_SECRET`, optional `FINANCE_INBOUND_RECIPIENTS` |
| LLM | AI briefing / incidents / Advisory fallback | `OPENAI_API_KEY` or `LLM_*` |
| Marketplace search | Trovara OS Advisory product links | `MARKETPLACE_SEARCH_API_KEY`, `MARKETPLACE_SEARCH_PROVIDER` |
| Cron | Scheduled jobs | `CRON_SECRET` (prod), `CRON_OWNER_*` / `CRON_FARM_ID`, `API_URL` |
| Backup | `scripts/backup-db.sh` | `BACKUP_DIR`, `BACKUP_GPG_PASSPHRASE`, `PGHOST`, `PGPORT` (optional) |

### Finance invoice inbound (Resend Receiving)

1. Configure Resend Receiving and its MX records on the chosen inbound domain.
2. Subscribe a dedicated webhook to `email.received` at
   `POST https://<api-host>/public/finance/inbound`.
3. Set its signing secret as `RESEND_INBOUND_WEBHOOK_SECRET`; do not reuse the
   newsletter `RESEND_WEBHOOK_SECRET`.
4. Draft expenses prefill amount/vendor/date/currency from the attachment when
   possible (PDF text layer first; LLM text/vision fallback when the farm LLM
   budget allows). Foreign amounts are converted to NGN using open.er-api.com;
   configure `FX_FALLBACK_RATES` (for example `USD:1550,EUR:1700`) for an
   offline fallback. The original amount, currency, rate, and conversion time
   remain attached to the expense. Staff still review pending drafts before
   approval, and only approved NGN expenses count in P&L.
5. Keep `FINANCE_INBOUND_RECIPIENTS=finance@trovara.farm`, or comma-separate
   additional intended finance aliases. When unset, it defaults to
   `finance@trovara.farm`.

Recipient matching is case-insensitive and exact, with one forwarding-safe
exception: the same local part is accepted on subdomains of an allowed domain.
Thus `finance@inbound.trovara.farm` is accepted for the default address, while
`orders@inbound.trovara.farm` and `finance@unrelated.example` are ignored.

Verified events are idempotent by Svix event ID and Resend email ID. The first
PDF, JPEG, PNG, or WebP attachment up to 25 MB is stored below
`EVIDENCE_STORAGE_ROOT/finance-inbound/`; a pending draft expense is created for
an intended recipient only.

### Alert subscriptions

Staff alerts fan out on Telegram and WhatsApp. Ownership of the subscription table and command menus: [`TELEGRAM-COPILOT.md`](./TELEGRAM-COPILOT.md) (same behaviour on WhatsApp).

| Stream | Always | Owner opt-in (Settings) |
|--------|--------|-------------------------|
| Customer order alerts | Supervisor + sales | `order_alerts_subscribed` |
| Worker alerts (task awaiting approval, urgent field messages) | Supervisor | `worker_alerts_subscribed` |

### Trovara OS Advisory

Stage/weather rules create recommendations (now → next → safe inputs → notify roles). Product links use SerpAPI when `MARKETPLACE_SEARCH_API_KEY` is set; otherwise the LLM suggests local product types (no invented URLs). Cron `POST /api/alerts/run-proactive` also runs the advisory engine; or call `POST /api/advisory/run`.

Daily **health/uptime snapshots** (`POST /api/alerts/run-health-sla`,
`npm run send-health-snapshot`) are separate: they probe OS + marketing
endpoints and notify linked **owners and supervisors**. The legacy route/env
identifier remains for compatibility. Toggle in Settings or via
`HEALTH_SLA_TELEGRAM_ENABLED`. See [`uptime-monitoring.md`](./uptime-monitoring.md).

---

## 1. Messaging channels

- **WhatsApp (Meta Cloud API):** account, webhook, verify token, dual phone numbers, and go-live — [`WHATSAPP-COPILOT.md`](./WHATSAPP-COPILOT.md).
- **Telegram:** BotFather, polling/webhook, link codes, ops commands — [`TELEGRAM-COPILOT.md`](./TELEGRAM-COPILOT.md).
- **Staff clock-in/out:** `/clockin` and `/clockout` work on both Telegram and WhatsApp for every staff role (owner, supervisor, sales, field worker).
- **Deferred:** WhatsApp customer shop account-linking UX stays documentation-only; Telegram remains the primary customer commerce messenger.

Quick status checks (session cookie may be required for some routes):

```bash
curl http://127.0.0.1:3000/api/whatsapp/status
curl -b cookies.txt http://127.0.0.1:3000/api/telegram/status
```

---

## 2. AI / LLM

Trovara OS uses an OpenAI-compatible chat completions API for the daily briefing and incident classification.

### Configuration

**Option A - OpenAI (simplest):**

```bash
OPENAI_API_KEY=sk-...
LLM_MODEL=gpt-4o-mini   # optional, this is the default
```

**Option B - OpenAI-compatible proxy (Anthropic, Azure, etc.):**

```bash
LLM_API_KEY=your_proxy_key
LLM_BASE_URL=https://your-proxy.example.com/v1
LLM_MODEL=claude-3-5-haiku-20241022
```

**Option C - Ollama (local, no cloud cost):**

```bash
LLM_API_KEY=ollama          # Ollama ignores the key but one must be set
LLM_BASE_URL=http://127.0.0.1:11434/v1
LLM_MODEL=llama3.2
```

Install and run Ollama, pull a model, then set the vars above. The API calls `POST {LLM_BASE_URL}/chat/completions`.

```bash
curl -b cookies.txt http://127.0.0.1:3000/api/ai/status
```

### Endpoints

Both require session auth as **owner** or **supervisor**.

#### GET `/api/ai/briefing`

Aggregates live farm data (tasks, plots, low stock, pending approvals) and returns a briefing.

**With LLM configured:** `source: "llm"`, `placeholder: false`, AI-written `summaryText`.

**Without LLM (or on LLM error):** `source: "dashboard_aggregate"`, `placeholder: true`, deterministic `summaryText` built from the same data.

#### POST `/api/ai/summarize-incident`

```bash
curl -b cookies.txt -X POST http://127.0.0.1:3000/api/ai/summarize-incident \
  -H 'Content-Type: application/json' \
  -H 'X-CSRF-Token: YOUR_CSRF' \
  -d '{
    "incidentText": "Irrigation pump stopped in north paddock during morning shift.",
    "plotId": "optional-uuid",
    "batchId": "optional-uuid"
  }'
```

Returns JSON: `{ severity, category, recommendedActions }`. Without LLM: placeholder severity `medium`, category `unclassified`, generic actions.

### Fallback behavior

| Condition | Briefing | Incident summarize |
|-----------|----------|-------------------|
| No API key | Deterministic text from DB aggregates | Placeholder summary + hint to configure key |
| LLM HTTP error | Same fallback + `llmError` field | Placeholder + `llmError` |
| Invalid JSON from model (incidents) | N/A | Falls back to placeholder |

The app works without LLM credentials; AI features fall back as in the table above.

### Estimated costs (daily briefing)

Using **gpt-4o-mini** (~500–800 input tokens + ~150 output tokens per briefing):

| Usage | Approx. cost (USD) |
|-------|-------------------|
| 1 briefing/day | ~$0.01–0.03/month |
| 5 supervisors × 1/day | ~$0.05–0.15/month |
| + 10 incident summaries/day | add ~$0.10–0.30/month |

Ollama local: **$0** (hardware/electricity only). Actual OpenAI pricing: [openai.com/pricing](https://openai.com/pricing).

---

## 3. Recurring tasks cron

Recurring task schedules (configured under **Templates** in the app) materialize into real tasks via `POST /api/templates/generate-tasks`. For unattended daily runs, use the root script:

```bash
npm run generate-tasks
```

This runs `scripts/generate-recurring-tasks.sh`, which:

1. Loads `.env`
2. Logs in as the cron owner (`POST /auth/login`) or uses `CRON_SECRET`
3. Calls `POST /api/templates/generate-tasks` with CSRF / cron header

### Environment variables

```bash
# Preferred in production: shared cron secret (no password login)
CRON_SECRET=<long random>
CRON_FARM_ID=<farm-uuid>

# Fallback: account used for cron login (must exist and have owner role)
CRON_OWNER_EMAIL=owner@trovara.farm
CRON_OWNER_PASSWORD=strong_production_password

# API base URL (default http://127.0.0.1:3000)
API_URL=https://os.trovara.farm
```

If `CRON_OWNER_PASSWORD` is unset, scripts fall back to `BREAK_GLASS_PASSWORD`, then `SEED_OWNER_PASSWORD` (local / legacy only). **Production must set `CRON_SECRET`.** See also [`security.md`](./security.md) (Still manual / ops).

### Crontab example

Run daily at 05:00 farm local time:

```cron
0 5 * * * cd /path/to/trovara-os && /usr/bin/npm run generate-tasks >> /var/log/trovara-generate-tasks.log 2>&1
```

Ensure Node/npm paths match your server (`which npm`). The API must be reachable at `API_URL` when cron fires.

---

## 4. Public QR traceability

Buyers and auditors can verify harvest lots without logging in.

### Public page (consumer URL)

```
https://YOUR_DOMAIN/lot/:farmSlug/:lotCode
```

Example (OS SPA, always available): `https://os.trovara.farm/lot/trovara-farm/<publicToken-or-code>`

When `PUBLIC_MARKETING_URL` is set (e.g. `https://trovara.farm`), QR codes and buyer-facing share links prefer the marketing route of the same shape:

```
https://trovara.farm/lot/trovara-farm/<publicToken-or-code>
```

The marketing site fetches `GET /public/lots/:farmSlug/:lotCode` (via same-origin `/lot-api` proxy) and renders brand UI. Certificates and box labels remain on the OS origin under `/public/lots/...`.

### Brand / press packs

Owners manage assets and packs in Trovara OS (**Brand kit**). Share URLs use the marketing site:

```
https://www.trovara.farm/brand/<shareToken>
```

Marketing proxies `/brand-api/*` → OS `/public/brand/*`. Unlock sets an HttpOnly pack-session cookie; gallery media and zip download require that cookie when a pack password is set.

Photos and videos (including iPhone HEIC / MOV / HEVC) upload via streamed `POST /api/brand/assets/upload` (max 500 MB / 10 minutes). The API converts HEIC→JPEG and video→H.264 MP4 (CRF 18, original pixel dimensions) with `ffmpeg`/`ffprobe` on the host. Visually lossless is not mathematically lossless, and efficient HEVC sources may not shrink.

Production needs:

```bash
sudo apt install ffmpeg
ffmpeg -version && ffprobe -version
ffmpeg -hide_banner -encoders | grep libx264
```

Nginx must raise body size / timeouts for the upload routes (see [`nginx-os.trovara.farm.conf.example`](./nginx-os.trovara.farm.conf.example)).

QR codes and **Print QR** labels open the public lot page (certificate-style HTML). Staff can also open printable sticker HTML and the **Trovara Farm Traceability Certificate** from Traceability / Sales.

### Public API (implemented)

```
GET /public/lots/:lotCode
```

No authentication. Returns lot summary + farm name/location when the lot exists.

**Test with seed data:**

```bash
curl http://127.0.0.1:3000/public/lots/TRV-COC-2026-001
curl http://127.0.0.1:3000/public/lots/TRV-PLT-2026-002
```

404 if `lotCode` does not exist. Lot codes are unique per farm; the public endpoint searches globally by code.

### Owner management (authenticated)

| Action | Route |
|--------|-------|
| List / create / edit lots | `/traceability` (owner) |
| API | `GET/POST/PATCH/DELETE /api/traceability` |
| Export audit chain | `GET /api/traceability/export` |

### Generating QR codes

Encode the **public page URL** (not the API URL) so scanners open a human-readable page.

```bash
npm install -g qrcode
qrcode -o lot-TRV-COC-2026-001.png "https://YOUR_DOMAIN/lot/trovara-farm/<publicToken>"
```

Print QR on lot labels, invoice PDFs, or market stall signage. Use short, stable lot codes (e.g. `TRV-COC-2026-001`).

---

## 5. Offline mode (future)

`app/src/lib/offline-queue.ts` provides a **localStorage-backed FIFO queue** for field workers when connectivity is poor.

**Implemented today:**

- `enqueue()` - store `{ path, method, body }` while offline
- `dequeue()`, `queueLength()`, `clearQueue()`
- `syncOfflineQueue(send)` - replay queue on reconnect (stub wired to a generic `send` function)

**Not yet implemented (full offline):**

- Hook `navigator.onLine` / `window.online` in worker views (`/today`, `/worker`)
- Route task PATCH / completion notes through `enqueue()` when offline
- Service worker + cached read models for Today home
- Conflict resolution (server `updatedAt` vs local)
- UI badge showing pending sync count
- Cap queue size and expire stale entries

Until sync is wired, the queue module is safe to import but unused in production views.

---

## 6. Production, backup, and payments

| Need | Doc |
|------|-----|
| Secrets, `deploy.sh`, smoke-test, rollback | [`PRODUCTION-DEPLOYMENT.md`](./PRODUCTION-DEPLOYMENT.md) |
| Wipe demo DB and create the first real owner | [`../../GO-LIVE.md`](../../GO-LIVE.md) |
| Encrypted backup, rclone, restore-test | [`backup-runbook.md`](./backup-runbook.md) |
| External `/health` + `/ready` monitors | [`uptime-monitoring.md`](./uptime-monitoring.md) |
| Customer Paystack checkout | [`PAYSTACK.md`](./PAYSTACK.md) |

Local wipe + reseed for demos: `nvm use 22 && npm run seed` (never on production).

---

## 7. Moving from seed data to real data

Seed data (`npm run seed`) creates **Trovara Demo Farm** with zones, plots, tasks, inventory, sample lots (`TRV-COC-2026-001`, `TRV-PLT-2026-002`), and demo users. Use it for training and integration testing only.

For a **production** cutover (empty DB, first real owner), use [`GO-LIVE.md`](../../GO-LIVE.md), not seed, and not reset-demo.

### Do not use reset-demo in production

`POST /api/onboarding/reset-demo` (owner only) **truncates and re-seeds** the entire database. It exists for local demos. Never expose or run it in production.

### Gradual module adoption checklist

Adopt modules in order so each layer has master data before downstream features:

1. **Users & roles** - Create real owner, supervisors, sales, field workers; set `BREAK_GLASS_PASSWORD` for emergency owner access.
2. **Zones & plots** - Replace demo zones/plots with your farm layout (`/api/zones`).
3. **Task templates & schedules** - Define recurring work; enable cron (`npm run generate-tasks` + `CRON_SECRET`).
4. **Today / Tasks** - Workers use `/today` or TG/WA `/tasks`·`/done`; supervisors approve on `/tasks` or `/approve`.
5. **Inventory** - Stock counts and reorder levels; log movements after field work.
6. **Crops & livestock** - Active cycles and batches tied to real plots.
7. **Harvest lots & traceability** - Create real lots; print QR / certificate from Traceability.
8. **Products & sales** - Sync catalogue (`npm run sync-catalog -w api`); real prices; order fulfill via Sales or TG/WA.
9. **Alert subscriptions** - Owners opt into customer and/or worker alerts in Settings.
10. **WhatsApp / Telegram** - Link staff phones / Telegram; pilot supervisors first.
11. **AI briefing** - Enable after real data exists so summaries use live farm records.

Check readiness anytime:

```bash
curl -b cookies.txt http://127.0.0.1:3000/api/onboarding/status
# { checklist: { hasZones, hasTemplates, hasUsers, … }, ready: boolean }
```

When migrating from demo: export anything you need (`/api/traceability/export`, encrypted backup), then either edit records in place or follow [`GO-LIVE.md`](../../GO-LIVE.md).

---

## Quick reference - integration endpoints

| Integration | Method | Path | Auth |
|-------------|--------|------|------|
| WhatsApp webhook verify | GET | `/api/whatsapp/webhook` | No |
| WhatsApp inbound | POST | `/api/whatsapp/webhook` | No (HMAC when `META_APP_SECRET` set) |
| WhatsApp send | POST | `/api/whatsapp/send` | owner, supervisor |
| WhatsApp templates | GET | `/api/whatsapp/templates` | No |
| WhatsApp status | GET | `/api/whatsapp/status` | No |
| Paystack webhook | POST | `/api/paystack/webhook` | No (HMAC) |
| Resend finance inbound | POST | `/public/finance/inbound` | No (Svix signature) |
| Daily health/uptime snapshot | POST | `/api/alerts/run-health-sla` | Cron secret or owner/supervisor |
| Public invoice | GET | `/public/invoices/:token` | No |
| Public invoice PDF | GET | `/public/invoices/:token/pdf` | No |
| AI briefing | GET | `/api/ai/briefing` | owner, supervisor |
| AI incident | POST | `/api/ai/summarize-incident` | owner, supervisor |
| AI status | GET | `/api/ai/status` | session |
| Generate tasks | POST | `/api/templates/generate-tasks` | owner (via cron script) |
| Public lot | GET | `/public/lots/:lotCode` | No |
