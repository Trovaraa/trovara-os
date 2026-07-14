# Trovara Roadmap

Covers two tracks:

1. **Trovara OS** — the software (this repo), soon at `os.trovara.farm`.
2. **Trovara Farm ("the plant")** — the physical Abeokuta operation that the OS must run day to day.

> Production: `https://os.trovara.farm` (deployed).
> Release gate: [`SECURITY-RELEASE-CHECKLIST.md`](./SECURITY-RELEASE-CHECKLIST.md).
> Ops runbooks: [`backup-runbook.md`](./backup-runbook.md), [`security.md`](./security.md).

---

## Where we actually are (July 2026)

**Built and working:**

- Core ops: auth/RBAC, tasks (assign → complete → approve/reject with reasons), inventory + movements + opening-stock count, crops, livestock, sales, finance/P&L, harvest lots + public lot page, reports (digest, action list, burn rate, plot profitability), audit log, Farm Day Close, Go-Live checklist, system status/health endpoints.
- Mobile/PWA: installable app shell, offline task queue + sync health UI, worker task flow with GPS/voice/photo capture.
- AI: Farm Copilot chat (grounded in live farm data, gpt-5-mini), photo diagnosis, voice-note transcription, incident summarizer, confirm-before-write task drafting.
- Channels: **Telegram butler live** (text, photo, voice in + **TTS voice replies out**); WhatsApp butler code-complete (Meta account blocked).
- Pilot hardening: live mode, CSV exports, password reset, session revoke, QR traceability, proactive alerts + evening digest, NDPA consent/export/retention.
- Owner 2FA (TOTP), butler TTS voice replies, task→inventory consumption, offline photo queue, lot certificate export.
- Ops: backup/restore/verify/encrypted scripts, docker-compose Postgres, API + security file logging.

**Not proven yet:** real-farm data (still demo until go-live), WhatsApp Meta approval, payments/billing, multi-tenant SaaS, 30 days of real daily use.

---

## Roadmap by feature

Same work as the phased tracks below, organised by feature area. **Now** = built and working. **Next** = pilot-blocking or high value. **Later** = after the 30-day pilot.

| Feature area | Now ✅ | Next 🔜 | Later 🔭 |
|---|---|---|---|
| **Tasks & workforce** | Assign → complete → approve flow; templates; recurring schedules; GPS + voice + photo; worker mobile queue; rejection reasons; post-approval audit; **task→inventory consumption** | Attendance/contractor tracking | Payroll-linked labour costs |
| **Inventory** | Items, movements, reorder levels, low-stock alerts, burn rate; opening-stock count; **consumption tied to tasks** | Supplier catalogue; purchase orders | Barcode scanning |
| **Crops** | Cycles with stage machine; plot management; zones; **stage-change proactive reminders** | Expected-vs-actual yield review | Season planning |
| **Livestock** | Batches, logs (feed/vaccine/mortality/incident), headcount tracking; **mortality-spike proactive alert** | Weight sampling; feed conversion ratio dashboards | Automated vaccination reminders |
| **Sales & finance** | Orders, P&L, expenses by category, plot profitability with **real daily wages**; **owner evening digest** via butler | Invoicing/receipts; Paystack payments | Buyer portal |
| **Traceability** | Harvest lots; public lot page; QR codes; public/private notes; lot timeline; **exportable lot certificate (HTML)** | Tokenization-ready data | — |
| **Reports & Day Close** | Digest, action list, burn rate, plot profitability, Farm Day Close, Go-Live checklist; **scheduled evening digest** (cron + Telegram) | Configurable report templates | Trend analytics |
| **AI Copilot (web)** | Grounded chat; photo diagnosis; incident summarizer; gpt-5-mini; **confirm-before-write task drafting** | Anomaly detection; task suggestions | Autonomous write actions (never without confirm) |
| **Butler channels** | **Telegram live** with **TTS voice replies**; WhatsApp code-complete; proactive alerts; Settings self-link + TTS mode | WhatsApp go-live when Meta clears | Automated check-in calls; group chat |
| **Mobile & offline** | Installable PWA; offline task queue; sync health UI; **offline photo capture queue** | Background sync | Native wrapper |
| **Security** | argon2, sessions, CSRF, RBAC + tests, tenant scoping, mutation rate limits, webhooks, AI limits, password reset, session revoke, security log, backup encryption, **2FA (owner TOTP + recovery codes)**, **prompt-injection hardening**, **butler link codes**, **owner security dashboard**, **42 tests** | **Rotate exposed secrets** (manual) | Redis rate limits; pen test; secrets manager; TOTP secret encryption |
| **Compliance (NDPA)** | Consent at login; privacy notice; **farm data export**; **worker anonymization**; **retention cron** | — | Full entity deletion UI |
| **Platform & ops** | **Production deploy** (`os.trovara.farm`); Docker Postgres; backup/restore/verify/**encrypted** scripts; health endpoints; system status panel; **file error logging** | Nightly off-server backups; uptime monitoring | CI/CD; staging env; multi-node |
| **SaaS** | Billing placeholder docs | — (frozen until pilot proves the loop) | Tenant provisioning; onboarding wizard; feature flags; billing; pricing page |

## Track 1 — Trovara OS (software)

### Phase A — Ship it: production deploy ✅

- [ ] **Rotate all exposed secrets** (OpenAI key, Telegram bot token, DB password, session secret) — they appeared in plaintext during development. Non-negotiable for public pilot. *(Manual — confirm done on the server.)*
- [x] Delete `docs/telegram.txt` (contains the bot token; not covered by `.gitignore`).
- [x] Complete P0 security items in code (see Security section below).
- [x] Deploy production at `os.trovara.farm` (HTTPS, reverse proxy, systemd/app process, firewall). Deploy guide removed — live.
- [ ] Nightly `pg_dump` cron + **off-server** backup copy. Script ready: `npm run backup:encrypted`.
- [ ] Uptime monitoring on `/health` and `/ready` (e.g. UptimeRobot free tier).

### Phase B — Pilot hardening (weeks 1–4 after deploy)

- [x] **Demo → live switch:** `POST /api/onboarding/go-live` sets `liveMode`; reset-demo blocked when live; opening-stock count workflow; users have phone + `dailyWageNgn`.
- [x] **Photo evidence on task completion** (proof of work — stored on task record).
- [x] Rejection reasons required on task rejection; "changes after approval" audit view (`/tasks/post-approval`).
- [x] CSV exports (tasks, inventory, expenses, audit) — `GET /api/exports/*.csv`.
- [x] Password reset flow + forced password change on first login (`mustChangePassword` on seed users).
- [x] Error tracking: unhandled errors + 5xx requests logged to `logs/api.log` (add logrotate on server).
- [ ] Fix remaining `npm audit` moderates (4 inside drizzle-kit dev toolchain — dev-only exposure).

### Phase C — Butler & channels (weeks 4–8)

- [ ] WhatsApp go-live once the Meta account appeal clears (webhook + signature verification ready; templates approval; permanent token).
- [x] Butler text-to-speech replies (OpenAI TTS — `voice_replies` default when user sends voice; `/voice off|voice|always` on Telegram; Settings TTS mode for owner).
- [x] Proactive alerts: low stock, overdue tasks, mortality spikes → owner Telegram (`POST /api/alerts/run-proactive`, `scripts/send-proactive-alerts.sh`).
- [x] Butler confirm-before-write: `POST /api/ai/draft-task` → user confirms → `POST /api/ai/confirm-task`.
- [x] Settings panel: "Connect Telegram" self-link flow (link code from Settings → `/link CODE` on bot; revoke in Settings). July 2026 security update.

### Phase D — Traceability & commercial (months 2–3)

- [x] QR code generation for harvest lots (`GET /api/traceability/:id/qr`); public/private field split on lot pages.
- [x] Lot event timeline (`GET /api/traceability/:id/timeline`).
- [x] Report scheduling: owner evening digest auto-sent via Telegram (`POST /api/alerts/evening-digest`, `scripts/send-evening-digest.sh`).
- [x] Plot profitability: uses assigned workers' `dailyWageNgn/8` per task (fallback ₦5,000 if unset).

### Phase E — SaaS (only after 30 days of real internal use)

- [ ] Tenant provisioning + onboarding wizard; per-tenant demo reset.
- [ ] Tenant isolation **negative tests** (cross-farm read/write attempts must fail) as a CI gate — unit RBAC + tenant-scope tests exist (34 tests); full HTTP integration tests pending.
- [ ] Feature flags, role templates per farm, tenant-level backup/export.
- [ ] Paystack/Stripe billing (docs/SAAS-BILLING.md), pricing page on trovara.farm.
- [x] NDPA product surfaces: consent at login, privacy notice, farm JSON export, worker anonymization, retention cron (`npm run run-data-retention`). Full entity deletion UI still pending.

---

## Track 2 — Trovara Farm, Abeokuta ("the plant")

The OS only matters if the farm runs on it daily. Milestone: **30 consecutive days of real use with no developer intervention.**

### Go-live prerequisites (week 1)

- [ ] Owner + supervisors + workers created with real phone numbers (with consent — NDPA).
- [ ] Zones, plots, crop cycles, livestock batches entered as they exist on the ground.
- [ ] Physical inventory count → opening stock in the system; reorder levels agreed with supervisor.
- [ ] Task templates + recurring schedules reviewed against the actual weekly rhythm.
- [ ] Every staff phone: `os.trovara.farm` installed as PWA + linked to the Telegram butler.
- [ ] One printed cheat-sheet per role (worker: pick task → do → submit proof; supervisor: morning assign, evening approve).

### Daily operating ritual (the product loop)

- **Morning (supervisor):** open Today → review generated tasks → assign → check low stock/incidents.
- **During day (workers):** task queue on phone; complete with GPS/photo/voice; offline queue absorbs bad connectivity; butler answers questions.
- **Evening (supervisor):** approve/reject with reasons. **(Owner):** Farm Day Close + digest.

### Pilot measurements (weeks 2–5)

- [ ] ≥80% of field tasks recorded in-app (not on paper/WhatsApp groups).
- [ ] Morning review under 5 minutes; evening close under 10.
- [ ] Inventory variance at week 4 recount < 10%.
- [ ] Every mortality/incident logged same day.
- [ ] Butler usage: which questions get asked → informs what to build next.
- [ ] Weekly: verify backup restore actually works (scripts/verify-backup.sh).

### Farm infrastructure (as budget allows)

- [ ] Reliable farm Wi-Fi/router placement (offline mode covers gaps, but sync needs windows of connectivity).
- [ ] Shared or subsidised Android phones for workers without one.
- [ ] Later: solar/power backup for the router; CCTV and sensors are **deferred** — they add data, not adoption.

---

## Security assessment (honest answer to "is this app secured at all?")

**Verdict: yes — unusually good for an MVP; production is live at `os.trovara.farm`.** Confirm secrets are rotated and off-server backups/uptime monitoring are on.

### Already implemented (verified in code)

| Control | Status |
|---|---|
| Password hashing | ✅ argon2id, proper cost params |
| Sessions | ✅ httpOnly, `SameSite=Strict`, `Secure` in prod, hashed tokens, 7-day expiry |
| CSRF | ✅ double-submit cookie on POST/PATCH/DELETE |
| RBAC | ✅ server-side on every route, with tests |
| Tenant scoping | ✅ `farm_id` on every query |
| SQL injection | ✅ Drizzle parameterized queries only |
| Input validation | ✅ Zod on API boundaries |
| Login rate limit | ✅ 5 attempts / 15 min / IP |
| Mutation rate limit | ✅ 120 writes / 15 min / user or IP |
| Security headers | ✅ hono secure-headers |
| CORS | ✅ allowlist via env |
| Audit log | ✅ append-only |
| DB exposure | ✅ Postgres bound to 127.0.0.1 only |
| Password reset | ✅ token-based flow with security logging |
| Session revoke | ✅ `POST /auth/revoke-all-sessions` |
| Security log | ✅ `logs/security.log` |
| API error log | ✅ `logs/api.log` |

### P0 — fix before/at internet deployment

- [ ] **Rotate exposed secrets.** *(Manual at deploy time.)*
- [x] **Delete `docs/telegram.txt`** ✅ deleted; `.gitignore` now covers `backups/` and `docs/telegram.txt`.
- [x] **WhatsApp webhook signature verification** ✅ `X-Hub-Signature-256` HMAC verified (timing-safe) whenever `META_APP_SECRET` is set; startup warning if WhatsApp is configured in production without it.
- [x] **Telegram webhook secret** ✅ `secret_token` sent on `setWebhook`, `X-Telegram-Bot-Api-Secret-Token` verified on the webhook route (`TELEGRAM_WEBHOOK_SECRET`); polling mode unaffected. Also fixed: the Telegram webhook was missing from the CSRF exempt list and would have been 403-blocked in webhook mode.
- [x] **Rate-limit AI endpoints** ✅ per-user limit on all LLM-invoking POSTs (`AI_RATE_LIMIT_PER_HOUR`, default 60/hour) returning 429 + Retry-After.
- [x] **Request body size limit** ✅ 12 MB cap in the API middleware (413 for oversized payloads); mirror at the reverse proxy.
- [x] **HTTPS everywhere** ✅ production at `os.trovara.farm`.
- [x] **`npm audit` high fixed** ✅ drizzle-orm upgraded. 4 moderates remain in drizzle-kit dev toolchain.

### P1 — during the pilot

- [x] Password reset + forced password change on first login.
- [x] Rate limiting for all mutations (in-memory; resets on restart).
- [x] Session revocation UI ("log out all devices").
- [x] Backup encryption (`scripts/backup-db-encrypted.sh` with GPG passphrase).
- [ ] `npm audit` cleanup for remaining moderates; monthly dependency cadence.
- [x] Structured security log → `logs/security.log`.
- [x] Negative tests: RBAC deny, CSRF, rate limits, urgent triggers, tenant-scope, mustChangePassword gate (**42 tests pass**). Full cross-farm HTTP integration tests pending.

### P2 — before SaaS / external users

- [x] 2FA for owner accounts (TOTP — Google Authenticator).
- [ ] Redis-backed rate limiting (multi-instance safe).
- [x] LLM prompt-injection hardening: inbound butler text sanitized + explicit anti-injection rules in system prompt.
- [ ] Secrets manager instead of `.env` on servers.
- [x] OWASP ASVS self-assessment checklist → `SECURITY-RELEASE-CHECKLIST.md`.
- [x] Data retention automation (`DATA_RETENTION_DAYS`, `scripts/run-data-retention.sh`).

---

## Deep security scan — July 2026 (findings to remediate)

A full code-level audit (auth/session, API surface, AI/butler pipeline, frontend, ops) was run on the pilot build. The controls in the assessment table above hold up — these are the **new gaps** found. Production is deployed; Critical/High items were fixed in code. Remaining items are mostly operational. File references are for the fixer.

### Critical

- [x] **Telegram account takeover via `/link <email>`** — replaced with in-app link codes (`butler-link-codes.ts`, Settings UI, `/link CODE` only). July 2026 fix.

### High

- [x] **Telegram phone linking trusts any shared contact card** — requires `contact.user_id === msg.from.id`. July 2026 fix.
- [x] **Webhooks fail open when the secret is unset** — production returns 503/401 when `TELEGRAM_WEBHOOK_SECRET` / `META_APP_SECRET` missing. July 2026 fix.
- [x] **CRON retention can purge every farm** — cron callers must pass `farmId`. July 2026 fix.
- [x] **Task evidence URLs accept arbitrary strings (stored XSS)** — `evidence-url.ts` allowlist on PATCH. July 2026 fix.
- [x] **TOTP completion endpoint has no rate limit** — 5 failures/challenge+IP; challenge invalidated. July 2026 fix.
- [x] **`mustChangePassword` enforced only in the UI** — `authMiddleware` + Vue router guard + `ChangePasswordView`. July 2026 fix.
- [x] **Password reset/change does not revoke existing sessions** — `revokeOtherSessions` on reset/change. July 2026 fix.
- [x] **CSRF blocks pre-auth flows** — exempt paths added; cron routes exempt. July 2026 fix.
- [x] **No LLM rate limits on butler channels (cost DoS)** — `butler-rate-limit.ts` (60/hr user, 20/hr unlinked chat). July 2026 fix.
- [x] **No size limit on inbound audio/images** — 10 MB cap in `telegram.ts` / `whatsapp-meta.ts`. July 2026 fix.
- [x] **Sanitization gaps + indirect prompt injection** — `sanitizeFarmDataField`, snapshot delimiters, history/caption sanitization. July 2026 fix.
- [x] **LLM provider error bodies echoed to clients** — generic client message; full errors server-logged. July 2026 fix.
- [x] **Shared-device data exposure (frontend)** — logout clears offline queues + SW caches; `/auth` removed from Workbox cache. July 2026 fix.
- [x] **Secrets exposed via process command line (ops scripts)** — GPG stdin; cron JSON via heredoc; CRON_SECRET preferred. July 2026 fix.

### Medium

- [ ] **TOTP secrets stored in plaintext** — recovery codes added; encrypt `totpSecret` at rest with `SESSION_SECRET` still pending.
- [x] **No TOTP replay protection / no recovery codes** — replay step tracking + 8 one-time recovery codes on enable. July 2026 fix.
- [x] **Other `/auth/*` mutators unthrottled** — `authMutationRateLimit` on `/auth/*` + per-route limits. July 2026 fix.
- [ ] **Rate limiting is in-memory + trusts raw `X-Forwarded-For`** — documented; Redis + trusted proxy hop deferred to post-pilot.
- [ ] **Password reset tokens are never delivered** — prior tokens invalidated on new request; email/SMS delivery still pending (see Features).
- [x] **CSV formula injection in exports** — risky cells prefixed with `'`. July 2026 fix.
- [ ] **Public lot codes are guessable + unscoped** — deferred; use opaque UUID tokens in a future migration.
- [ ] **Base64 evidence stored in Postgres text columns** — validation added; disk/S3 offload deferred.
- [x] **`reset-demo` wipes the entire database, not just the farm** — scoped to `user.farmId`; full wipe needs `ALLOW_FULL_DB_RESET=true`. July 2026 fix.
- [x] **Loose phone suffix matching binds the wrong user** — exact normalized digits only. July 2026 fix.
- [x] **Confirm-before-write is not server-bound** — `task-drafts.ts` + `draftId` on confirm; AiView updated. July 2026 fix.
- [ ] **Live Telegram bot token sits in local `.env`** — rotate manually at deploy (non-code).

### Low

- [x] **Timing-unsafe comparisons** — `secure-compare.ts` used for CSRF + cron secrets. July 2026 fix.
- [x] **Login timing side-channel** — dummy Argon2 verify on unknown emails. July 2026 fix.
- [x] **`SESSION_SECRET` unused + no env validation** — production startup checks added in `env.ts`. July 2026 fix.
- [x] **Info-disclosure endpoints** — minimal `{ ok: true }` in production unless owner-authenticated. July 2026 fix.
- [ ] **Body size limit trusts `Content-Length` only** — streaming cap deferred.
- [x] **`billing/checkout` lacks finance RBAC** — `canAccessFinance` added. July 2026 fix.
- [x] **Housekeeping** — `uploads/` in `.gitignore`; QR as blob `<img>`; offline queue caps + quota handling; GPG stdin in backup script. July 2026 fix.

**Remediation status (July 2026):** Critical + all High items fixed in code. Remaining Medium/Low are operational (secret rotation, email delivery, Redis rate limits, public lot tokens, evidence file storage) — safe to pilot once secrets rotated and HTTPS live.

---

## Candidate new features (July 2026)

Ideas surfaced during the scan, beyond what the feature table already tracks. Ordered roughly by pilot value.

**Security/compliance-driven (also close audit gaps):**

- [x] **In-app Telegram/WhatsApp link codes** — Settings generates a one-time code; bot accepts `/link CODE` only. July 2026.
- [x] **2FA recovery codes** — 8 one-time codes on TOTP enable; use/regenerate endpoints. July 2026.
- [ ] **Email/SMS delivery for password reset & alerts** — wire an SMTP or Africa's Talking / Twilio provider so reset tokens (currently created but undelivered) and critical alerts reach users off-channel.
- [x] **Owner security dashboard** — `/settings/security` + `GET /api/system/security-events` + revoke-all sessions. July 2026.

**Field operations:**

- [ ] **GPS geofence verification** — check task-completion GPS against the assigned plot's boundary and flag off-site submissions (builds on evidence already captured).
- [ ] **Attendance / clock-in-out** — workers check in/out from the PWA; feeds real labour hours into plot profitability (currently a flat `dailyWageNgn/8` estimate).
- [ ] **Equipment & asset register** — track tools/vehicles/irrigation with service schedules and maintenance-due proactive alerts.
- [ ] **AI expense-receipt capture (OCR)** — photograph a receipt → vision model extracts vendor/amount/date → drafts an expense (confirm-before-write). Reuses the existing photo-diagnosis pipeline.
- [ ] **Web Push notifications** — task assignment / approval / low-stock pushes to the installed PWA, reducing dependence on the Telegram butler.

**Planning & commercial:**

- [ ] **Weather integration** — daily forecast on the Today view + weather-aware task/irrigation suggestions and frost/heavy-rain alerts.
- [ ] **Supplier catalogue + purchase orders** — turn low-stock alerts into POs with expected delivery, closing the inventory loop.
- [ ] **Invoicing / receipts** — generate a PDF/HTML invoice from a sale (mirrors the existing lot-certificate generator) ahead of Paystack billing.
- [ ] **Season / crop-cycle planning** — plan next cycle per plot with expected-vs-actual yield review.

**AI/butler:**

- [ ] **Anomaly detection & task suggestions** — flag unusual burn rate, mortality, or inventory variance and propose corrective tasks.
- [ ] **SMS-fallback butler** — a text-only butler for workers on feature phones / no data, via an SMS gateway.

---

## What we deliberately do NOT build yet

Cloud multi-region, Redis queues, Kubernetes, CCTV/sensor integrations, tokenization mechanics, advanced AI agents that write data autonomously, push notifications. Revisit only after the 30-day pilot proves the daily loop.

---

## Gap closure (from earlier product reviews)

| Gap | Status |
|---|---|
| State machines not enforced | ✅ Enforced + tested |
| Mobile PWA / bilingual | ✅ Built |
| AI = stubs only | ✅ Live LLM + butler + diagnosis |
| No CSRF / RBAC tests / backups | ✅ All implemented |
| No password reset | ✅ Reset + change-password + user phone/wage fields |
| Traceability / QR / public pages | ✅ QR + public lot page + timeline |
| Operating model not in app | ⚠️ Today view + Day Close + cron digests; rituals not fully enforced |
| SaaS / multi-tenant | ❌ Still frozen until pilot |
| NDPA compliance | ✅ Consent + export + retention; full deletion UI pending |
