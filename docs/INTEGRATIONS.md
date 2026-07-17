# Trovara OS - Integrations Guide

Step-by-step setup for WhatsApp, AI, cron jobs, public traceability, offline mode, and production deployment.

See also: [`API.md`](./API.md), [`TELEGRAM-COPILOT.md`](./TELEGRAM-COPILOT.md), [`WHATSAPP-COPILOT.md`](./WHATSAPP-COPILOT.md), [`security.md`](./security.md), [`backup-runbook.md`](./backup-runbook.md).

---

## Environment variables overview

Copy `.env.example` to `.env` and uncomment the sections you need. Never commit `.env`.

| Section | Required for | Key variables |
|---------|--------------|---------------|
| Postgres | Always | `POSTGRES_*`, `DATABASE_URL` |
| API core | Always | `API_HOST`, `API_PORT`, `SESSION_SECRET`, `NODE_ENV` |
| CORS / frontend | Production | `CORS_ORIGIN`, `VITE_API_URL` |
| Seed users | Local dev only | `SEED_*_PASSWORD` |
| WhatsApp | Outbound + webhook | `WHATSAPP_*` |
| LLM | AI briefing / incidents | `OPENAI_API_KEY` or `LLM_*` |
| Cron | Recurring tasks | `CRON_OWNER_*`, `API_URL` |
| Backup | `scripts/backup-db.sh` | `BACKUP_DIR`, `PGHOST`, `PGPORT` (optional) |

---

## 1. Meta WhatsApp Cloud API

Trovara OS sends farm notifications via the [WhatsApp Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api). Templates live in `whatsapp/templates.json`; the API renders them and sends plain text messages.

### Step 1 - Meta Business account

1. Go to [Meta Business Suite](https://business.facebook.com/) and create or verify a **Business Portfolio** for your farm or company.
2. Enable two-step verification on the Meta account that owns the app.

### Step 2 - WhatsApp Business Platform app

1. Open [Meta for Developers](https://developers.facebook.com/) → **My Apps** → **Create App** → type **Business**.
2. Add the **WhatsApp** product to the app.
3. Under **WhatsApp → API Setup**, note:
   - **Phone number ID** → `WHATSAPP_PHONE_NUMBER_ID`
   - Add and verify your business phone (Nigeria: `+234…` format).
4. Create a **System User** in Business Settings with `whatsapp_business_messaging` permission and generate a **permanent** access token (not the 24-hour test token) → `WHATSAPP_ACCESS_TOKEN`.
5. Choose a random secret string for webhook verification → `WHATSAPP_VERIFY_TOKEN` (e.g. `openssl rand -hex 32`).

Optional: set `WHATSAPP_API_VERSION` (default `v21.0`) if Meta deprecates your current version.

Add to `.env`:

```bash
WHATSAPP_ACCESS_TOKEN=EAAxxxx...
WHATSAPP_PHONE_NUMBER_ID=123456789012345
WHATSAPP_VERIFY_TOKEN=your_random_verify_secret
WHATSAPP_API_VERSION=v21.0
```

Restart the API after changing env vars.

### Step 3 - Webhook URL

Meta requires a **public HTTPS** endpoint.

| Environment | Webhook URL |
|-------------|-------------|
| Production | `https://YOUR_DOMAIN/api/whatsapp/webhook` |
| Local dev | Tunnel, e.g. `https://abc123.ngrok-free.app/api/whatsapp/webhook` |

**Local dev with ngrok:**

```bash
# Terminal 1 - API already running on :3000
ngrok http 3000

# In Meta Developer Console → WhatsApp → Configuration:
# Callback URL: https://YOUR_NGROK_HOST/api/whatsapp/webhook
# Verify token: same as WHATSAPP_VERIFY_TOKEN
# Subscribe to: messages
```

### Step 4 - Webhook verification (GET)

Meta sends a GET request before activating the webhook:

```
GET /api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=YOUR_TOKEN&hub.challenge=CHALLENGE_STRING
```

Trovara OS checks `hub.mode === 'subscribe'` and `hub.verify_token === WHATSAPP_VERIFY_TOKEN`, then returns the `hub.challenge` value as plain text. If credentials are missing, the endpoint returns `501 WhatsApp not configured`.

**Manual test:**

```bash
curl "http://127.0.0.1:3000/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=YOUR_TOKEN&hub.challenge=test123"
# Expected: test123
```

Inbound POST webhooks are acknowledged with `{ ok: true }` and logged to the server console (async processing / DB storage is future work).

### Step 5 - Check status

```bash
curl http://127.0.0.1:3000/api/whatsapp/status
# { "configured": true, "hint": "Ready to send via Meta Cloud API" }
```

### Step 6 - Send messages (POST /api/whatsapp/send)

Requires an authenticated session as **owner** or **supervisor**.

**From the app:** use the WhatsApp module (`/whatsapp`) when send UI is wired, or call the API directly.

**Example request:**

```bash
# Log in first to obtain session cookie + CSRF token, then:
curl -b cookies.txt -X POST http://127.0.0.1:3000/api/whatsapp/send \
  -H 'Content-Type: application/json' \
  -H 'X-CSRF-Token: YOUR_CSRF' \
  -d '{
    "to": "+2348012345678",
    "templateId": "task_complete",
    "lang": "en",
    "variables": {
      "taskTitle": "Weeding - Plot B",
      "workerName": "Ade",
      "plotName": "Plot B",
      "completedAt": "21 Jun 2026, 14:30"
    }
  }'
```

**Response:** `{ ok: true, messageId, preview }` or `502` with Meta error details.

**Template IDs** (from `whatsapp/templates.json`): `task_complete`, `incident_report`, `low_stock_alert`. Languages: `en`, `yo`, `pcm`, `fr`.

List templates without auth:

```bash
curl http://127.0.0.1:3000/api/whatsapp/templates
```

### Nigeria phone format

- Store and send numbers in international format: **`+234` followed by 10 digits** (no leading 0).
- Examples: `+2348012345678`, `+2348103693426`.
- The API strips non-digits before calling Meta (`2348012345678`). Always include country code `234`.

### Cost note

WhatsApp Cloud API uses **conversation-based pricing** (24-hour windows), not per-message SMS rates. Rates vary by country and conversation category (utility, marketing, authentication, service). See [Meta WhatsApp pricing](https://developers.facebook.com/docs/whatsapp/pricing). Pilot with internal numbers before messaging all field workers.

### Seed data vs production

| Feature | Without `WHATSAPP_*` env | With credentials |
|---------|--------------------------|------------------|
| `GET /api/whatsapp/templates` | Works - local JSON | Works |
| Vue `/whatsapp` page | Copy/share templates manually | Same + API send when UI calls send |
| `POST /api/whatsapp/send` | `501 Not configured` | Sends via Meta |
| Webhook GET/POST | `501 Not configured` | Verification + inbound ack |
| Seed farm phone in orders | `+2348012345678` (demo) | Use real worker/supervisor numbers |

**Production:** register and approve message templates in Meta Business Manager before high-volume sends. Local `templates.json` is for rendering only; Meta may require pre-approved templates for outbound business-initiated messages outside the 24-hour customer service window.

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

Check status:

```bash
curl -b cookies.txt http://127.0.0.1:3000/api/ai/status
```

### Endpoints

Both require session auth as **owner** or **supervisor**.

#### GET `/api/ai/briefing`

Aggregates live farm data (tasks, plots, low stock, pending approvals) and returns a briefing.

**With LLM configured:** `source: "llm"`, `placeholder: false`, AI-written `summaryText`.

**Without LLM (or on LLM error):** `source: "dashboard_aggregate"`, `placeholder: true`, deterministic `summaryText` built from the same data.

```bash
curl -b cookies.txt http://127.0.0.1:3000/api/ai/briefing
```

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

The app remains fully usable without any LLM credentials.

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
2. Logs in as the cron owner (`POST /auth/login`)
3. Calls `POST /api/templates/generate-tasks` with CSRF header

### Environment variables

```bash
# Account used for cron login (must exist and have owner role)
CRON_OWNER_EMAIL=owner@trovara.farm
CRON_OWNER_PASSWORD=strong_production_password

# API base URL (default http://127.0.0.1:3000)
API_URL=https://your-domain.com
```

If `CRON_OWNER_PASSWORD` is unset, the script falls back to `SEED_OWNER_PASSWORD` (local dev only - **set explicit production credentials**).

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
https://YOUR_DOMAIN/lot/:lotCode
```

Example: `https://farm.trovara.ng/lot/TRV-COC-2026-001`

This is the URL to encode in QR codes. Implement a minimal public Vue route that fetches lot data from the API below (no session cookie required).

### Public API (implemented)

```
GET /public/lots/:lotCode
```

No authentication. Returns:

```json
{
  "lot": {
    "lotCode": "TRV-COC-2026-001",
    "productName": "Young coconut (sample harvest)",
    "quantityKg": 120,
    "harvestedAt": "2026-06-14T…",
    "plotName": "Coconut Grove",
    "cropType": "coconut",
    "farm": { "name": "Trovara Demo Farm", "location": "Ogun State, Nigeria" }
  },
  "verified": true,
  "scannedAt": "2026-06-21T…"
}
```

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

**Free online tools:** [qr-code-generator.com](https://www.qr-code-generator.com/), [goqr.me](https://goqr.me/)

**CLI (optional):**

```bash
npm install -g qrcode
qrcode -o lot-TRV-COC-2026-001.png "https://YOUR_DOMAIN/lot/TRV-COC-2026-001"
```

**Node (optional):** the [`qrcode`](https://www.npmjs.com/package/qrcode) npm package can generate PNG/SVG in a build script or traceability export - not bundled in Trovara OS by default.

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

## 6. Production deployment (brief)

### Stack

- **Postgres 17** - `docker compose up -d` (or managed Postgres)
- **API** - Node 20.17+ / 22 LTS, `npm run build -w api`, run compiled server
- **Frontend** - `npm run build -w app`, serve `app/dist` via nginx/Caddy or static host

### Critical env vars

```bash
NODE_ENV=production
SESSION_SECRET=<long random string, min 32 chars>
DATABASE_URL=postgresql://user:pass@db-host:5432/trovara_os
API_HOST=0.0.0.0          # or bind behind reverse proxy only
API_PORT=3000
CORS_ORIGIN=https://app.your-domain.com
VITE_API_URL=https://api.your-domain.com   # set at build time for SPA
```

**HTTPS:** Session cookies use `Secure` flag when `NODE_ENV=production`. Terminate TLS at your reverse proxy; do not expose plain HTTP to the internet.

**CORS:** Must match the exact frontend origin (scheme + host + port). Missing `CORS_ORIGIN` logs a startup warning.

### Docker

`docker-compose.yml` ships Postgres only. Run API and app on the host or extend compose with your own service definitions. Keep Postgres port bound to localhost unless firewalled.

### Database backup

```bash
./scripts/backup-db.sh
```

Creates `backups/{POSTGRES_DB}_YYYYMMDD_HHMMSS.sql`. Schedule daily in production. See [`backup-runbook.md`](./backup-runbook.md) for restore steps.

Optional: `BACKUP_DIR`, `PGHOST`, `PGPORT`, `ENV_FILE`.

---

## 7. Moving from seed data to real data

Seed data (`npm run seed`) creates **Trovara Demo Farm** with zones, plots, tasks, inventory, sample lots (`TRV-COC-2026-001`, `TRV-PLT-2026-002`), and demo users. Use it for training and integration testing only.

### Do not use reset-demo in production

`POST /api/onboarding/reset-demo` (owner only) **truncates and re-seeds** the entire database. It exists for local demos. Never expose or run it in production.

### Gradual module adoption checklist

Adopt modules in order so each layer has master data before downstream features:

1. **Users & roles** - Create real owner, supervisors, field workers; disable or change demo passwords.
2. **Zones & plots** - Replace demo zones/plots with your farm layout (`/api/zones`).
3. **Task templates & schedules** - Define recurring work; enable cron (`npm run generate-tasks`).
4. **Today / Tasks** - Workers use `/today`; supervisors approve on `/tasks`.
5. **Inventory** - Stock counts and reorder levels; log movements after field work.
6. **Crops & livestock** - Active cycles and batches tied to real plots.
7. **Harvest lots & traceability** - Create real lot codes; print QR linking to `/lot/:lotCode`.
8. **Sales & finance** - Orders linked to lots; owner reviews P&L on `/finance` and `/reports`.
9. **WhatsApp** - Pilot supervisors first; add worker phone numbers with consent.
10. **AI briefing** - Enable after real data exists so summaries are meaningful.

Check readiness anytime:

```bash
curl -b cookies.txt http://127.0.0.1:3000/api/onboarding/status
# { checklist: { hasZones, hasTemplates, hasUsers, … }, ready: boolean }
```

When migrating from demo: export anything you need (`/api/traceability/export`, `./scripts/backup-db.sh`), then either edit records in place or start a fresh DB without running `reset-demo` on production.

---

## Quick reference - integration endpoints

| Integration | Method | Path | Auth |
|-------------|--------|------|------|
| WhatsApp webhook verify | GET | `/api/whatsapp/webhook` | No |
| WhatsApp inbound | POST | `/api/whatsapp/webhook` | No |
| WhatsApp send | POST | `/api/whatsapp/send` | owner, supervisor |
| WhatsApp templates | GET | `/api/whatsapp/templates` | No |
| WhatsApp status | GET | `/api/whatsapp/status` | No |
| AI briefing | GET | `/api/ai/briefing` | owner, supervisor |
| AI incident | POST | `/api/ai/summarize-incident` | owner, supervisor |
| AI status | GET | `/api/ai/status` | session |
| Generate tasks | POST | `/api/templates/generate-tasks` | owner (via cron script) |
| Public lot | GET | `/public/lots/:lotCode` | No |
