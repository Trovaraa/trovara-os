# Trovara OS production deployment

Use Node 22 for every npm/npx command.

**Live production:** `https://os.trovara.farm` runs with **real farm data and no seed**.
Do **not** rebuild, truncate, or reset the production database unless you have an
explicit disaster-recovery plan and verified encrypted backups. Treat every
`deploy.sh` as a migrate-forward + restart on the existing DB.

## 1. Generate production secrets

Run each command independently and paste its output into the corresponding
production environment variable. Do not commit the generated values. Skip any
secret that is already set and in use on the live host (especially
`TOTP_ENCRYPTION_KEY` and `BACKUP_GPG_PASSPHRASE`).

```bash
# 32-byte AES key; keep permanently or encrypted owner TOTP secrets become unreadable
openssl rand -hex 32
# -> TOTP_ENCRYPTION_KEY

# Separate 32-byte AES key for the portal credential vault
openssl rand -hex 32
# -> VAULT_ENCRYPTION_KEY

# Internal scheduled-job authentication
openssl rand -hex 32
# -> CRON_SECRET

# Telegram webhook verification (only required in webhook mode)
openssl rand -hex 24
# -> TELEGRAM_WEBHOOK_SECRET

# Separate customer Telegram webhook verification
openssl rand -hex 24
# -> TELEGRAM_CUSTOMER_WEBHOOK_SECRET

# Meta webhook verification token (also enter this exact value in Meta)
openssl rand -hex 32
# -> WHATSAPP_VERIFY_TOKEN

# Founder registration: do not generate a shared OWNER_REGISTRATION_SECRET.
# Leave it empty. Mint a single-use token on the server after the API can reach
# the database (see "Owner registration token" below and GO-LIVE.md step 7).

# Break-glass emergency login (env-only; not stored as the DB password hash)
openssl rand -base64 32
# -> BREAK_GLASS_PASSWORD

# Encrypted database + evidence backup passphrase
openssl rand -base64 48
# -> BACKUP_GPG_PASSPHRASE

# URL-safe PostgreSQL password if rotating the database password
openssl rand -hex 32
# -> POSTGRES_PASSWORD (also update DATABASE_URL)
```

`META_APP_SECRET`, Telegram bot tokens, WhatsApp access tokens, Paystack keys,
email provider credentials, and LLM API keys must come from their provider
dashboards; do not generate replacements locally.

### Owner registration token (server)

Founder signup uses a **single-use DB token**, not a reusable env secret. After
the API can talk to Postgres, mint one on the production host:

```bash
cd /home/ubuntu/trovara-os   # or your deploy path
source "$HOME/.nvm/nvm.sh" && nvm use 22
npm run reg-token -w api -- --ttl=2 --label="initial founder"
```

| Flag | Meaning |
|------|---------|
| `--ttl=2` | Expires in 2 hours (omit for default 24h) |
| `--label="initial founder"` | Audit note only |

The CLI prints the token **once**. Paste it into the registration-secret field
at `/register`. It is consumed on first successful owner create and cannot be
reused. After the first owner exists, mint further tokens with
`POST /auth/registration-tokens` (owner session) or Settings → registration
tokens. Leave `OWNER_REGISTRATION_SECRET` empty in production (legacy reusable
fallback only). Full go-live flow: [GO-LIVE.md](../../GO-LIVE.md) step 7.

## 2. Required production configuration

### Core (always)

```dotenv
NODE_ENV=production
API_HOST=127.0.0.1
API_PORT=3000
TRUSTED_PROXY_HOPS=1
CORS_ORIGIN=https://os.trovara.farm,https://shop.trovara.farm,https://trovara.farm,https://www.trovara.farm

PUBLIC_APP_URL=https://os.trovara.farm
VITE_API_URL=https://os.trovara.farm
VITE_PUBLIC_APP_URL=https://os.trovara.farm
VITE_PUBLIC_MARKETING_URL=https://trovara.farm
PUBLIC_MARKETING_URL=https://trovara.farm
PUBLIC_SHOP_URL=https://shop.trovara.farm

TOTP_ENCRYPTION_KEY=<openssl output>
VAULT_ENCRYPTION_KEY=<separate openssl output>
CRON_SECRET=<openssl output>
BREAK_GLASS_PASSWORD=<openssl output>
# BREAK_GLASS_EMAIL=owner@trovara.farm
# Leave BREAK_GLASS_ENABLED unset in production. Arm only for emergency recovery:
# BREAK_GLASS_ENABLED=true
# ALLOW_CUSTOMER_CHANNELS_WITHOUT_TOTP=true  # temporary only; remove after owner TOTP is on

EVIDENCE_STORAGE_ROOT=/var/lib/trovara-os/evidence
BACKUP_DIR=/var/backups/trovara-os
BACKUP_GPG_PASSPHRASE=<openssl output>
REQUIRE_EVIDENCE_BACKUP=1
# Optional rclone cloud offsite (skip if using ./deploy.sh --pull-backups):
# BACKUP_REMOTE_ENABLED=1
# BACKUP_REMOTE_REQUIRED=1
# BACKUP_RCLONE_DESTINATION=<configured-rclone-remote>:trovara/production
BACKUP_MAX_AGE_HOURS=26
# USE_DOCKER_PG_TOOLS=1  # enable only when using this repo's Docker Postgres
# Brand Kit photo/video (optional overrides; defaults 100 MB / 10 min, 2 GB/farm)
# BRAND_UPLOAD_MAX_BYTES=104857600
# BRAND_MAX_FARM_STORAGE_BYTES=2147483648
# BRAND_UPLOAD_MAX_DURATION_SEC=600

LLM_DAILY_BUDGET_PER_FARM=500
# Uses the same OPENAI_API_KEY / LLM_BASE_URL as Copilot. The current vector
# schema is fixed at 1,536 dimensions.
EMBEDDING_MODEL=text-embedding-3-small
MAX_CUSTOMER_ORDER_VALUE_KOBO=50000000
MAX_CUSTOMER_ORDERS_PER_DAY=5
CUSTOMER_FARM_ID=<Trovara production farm UUID>
# Optional alias — must resolve to the SAME farm as CUSTOMER_FARM_ID
# TELEGRAM_CUSTOMER_FARM_SLUG=trovara-farm
NETLIFY_JOURNAL_BUILD_HOOK=<private Netlify build-hook URL>

DATA_RETENTION_DAYS=365
SESSION_RETENTION_DAYS=7
CUSTOMER_CONTACT_RETENTION_DAYS=365
```

### Channels, payments, email (activate when ready)

```dotenv
# Staff Telegram butler
TELEGRAM_BOT_TOKEN=<from BotFather>
TELEGRAM_WEBHOOK_SECRET=<openssl output>

# Customer Telegram order bot (separate token)
TELEGRAM_CUSTOMER_BOT_TOKEN=<from BotFather>
TELEGRAM_CUSTOMER_WEBHOOK_SECRET=<openssl output>

# Paystack (in progress — set when ready; test keys first, then live)
# PAYSTACK_SECRET_KEY=sk_test_...
# PAYSTACK_PUBLIC_KEY=pk_test_...

# WhatsApp Meta (in progress — set when Business approval + tokens are ready)
# WHATSAPP_ACCESS_TOKEN=...
# WHATSAPP_PHONE_NUMBER_ID=...
# WHATSAPP_CUSTOMER_PHONE_NUMBER_ID=...
# WHATSAPP_VERIFY_TOKEN=...
# META_APP_SECRET=...

# Resend — newsletter + transactional (password reset / critical alerts)
RESEND_API_KEY=<full-access Resend API key>
RESEND_FROM="Trovara <newsletter@trovara.farm>"
# Optional ops From; falls back to RESEND_FROM for password reset
# EMAIL_FROM="Trovara OS <no-reply@trovara.farm>"
# EMAIL_DELIVERY_REQUIRED=true   # fail closed if email is misconfigured
RESEND_NEWSLETTER_SEGMENT_ID=<Resend Segment ID>
RESEND_WEBHOOK_SECRET=<Resend newsletter webhook signing secret>
# Second webhook for finance inbound (email.received) — different whsec_
RESEND_INBOUND_WEBHOOK_SECRET=<Resend inbound finance webhook signing secret>
NEWSLETTER_CONSENT_VERSION=1.0
```

Trovara OS stores website contact and product-waitlist submissions in
PostgreSQL first, then uses the same transactional `RESEND_API_KEY` and
`EMAIL_FROM` (falling back to `RESEND_FROM`) for staff alerts. Set
`MARKETING_LEAD_NOTIFICATION_EMAILS=info@trovara.farm` to target known
deliverable mailboxes; comma-separate additional addresses. When unset, active
owners and Sales staff are used and the configured break-glass owner is
excluded. If mail is disabled or delivery fails, the public submission still
succeeds and the failed state is
retained for an authenticated retry. These submissions are not newsletter
consent and must not be synced to Resend Contacts or the newsletter Segment.

`VITE_API_URL` is the SPA’s API base (baked in at `npm run build`).  
`VITE_PUBLIC_APP_URL` / `PUBLIC_APP_URL` are the public OS URL for emails, certificates, labels, and the OS lot SPA fallback.  
`PUBLIC_MARKETING_URL` (and build-time `VITE_PUBLIC_MARKETING_URL`) is the brand site. When set, QR codes and buyer lot links prefer `${PUBLIC_MARKETING_URL}/lot/:farmSlug/:token` so scanners open the marketing-branded page; OS still serves `/lot/...` and `GET /public/lots/...`. Customer account email links use `PUBLIC_SHOP_URL` (`https://shop.trovara.farm`). Ensure `CORS_ORIGIN` includes `https://shop.trovara.farm` and `https://trovara.farm` if those hosts ever call the API cross-origin (same-origin `/shop` on the shop host and `/lot-api` on marketing do not need CORS).

`BREAK_GLASS_PASSWORD` is the emergency owner secret (env only, not the DB hash).
Env login also requires `BREAK_GLASS_ENABLED=true` — leave it **unset** in production
and arm only for recovery (1-hour session; disarm and restart after). `./deploy.sh`
requires `CRON_SECRET` in the **VM** production `.env` (not the laptop copy).
`CUSTOMER_FARM_ID` selects the farm exposed by the public shop and Journal APIs.
If you also set `TELEGRAM_CUSTOMER_FARM_SLUG`, it **must** be that same farm’s slug —
mismatched ID vs slug can point shop/bot/Journal at different farms.
Keep `NETLIFY_JOURNAL_BUILD_HOOK` secret; publishing or unpublishing a Journal
post calls it to rebuild the static marketing site, RSS feed, and sitemap.
Set `TRUSTED_PROXY_HOPS` to the real topology: `1` for nginx directly in front
of the API, `2` when another trusted proxy/CDN is also in the forwarding chain.
Do not expose port 3000 directly to the internet.

`SESSION_SECRET` is no longer used by the current release. Keep it only while an
older release remains a rollback option.

### Find `CUSTOMER_FARM_ID` from the production database

`CUSTOMER_FARM_ID` is the UUID of an existing row in the `farms` table. Do not
generate it with OpenSSL or `uuidgen`: a generated value will not reference a
farm, so the public shop and Journal APIs will not resolve correctly.

On the production host, load the deployed environment and list the farms:

```bash
cd /home/ubuntu/trovara-os   # or your deploy path
set -a
source .env
set +a

psql "$DATABASE_URL" -P pager=off \
  -c "SELECT id, name, slug FROM farms ORDER BY created_at;"
```

If PostgreSQL runs in this repository's Docker Compose service and `psql` is not
installed on the host, run the query inside the database container:

```bash
cd /home/ubuntu/trovara-os
set -a
source .env
set +a

docker compose exec -T db \
  psql -U "${POSTGRES_USER:-trovara}" -d "${POSTGRES_DB:-trovara_os}" -P pager=off \
  -c "SELECT id, name, slug FROM farms ORDER BY created_at;"
```

Choose the row whose slug is `trovara-farm` (or the confirmed production farm
name), copy its `id`, and add it to the production `.env`:

```dotenv
CUSTOMER_FARM_ID=<existing farms.id UUID>
```

Restart the API service after changing `.env`. Never print or copy
`DATABASE_URL`; only the selected farm UUID is needed.

### Configure the Resend newsletter

Trovara OS PostgreSQL is the newsletter source of truth. Resend is the delivery
and contact-segmentation provider; failed provider syncs remain visible and can
be retried from the owner API.

1. In Resend, add and verify the sending domain used by `RESEND_FROM`. Complete
   its SPF and DKIM DNS records and wait for **Verified** status before opening
   public signup.
2. Create an API key with **Full access**. A sending-only key cannot update
   Contacts or Segment membership. Store it only as `RESEND_API_KEY` in the
   server `.env`.
3. In **Contacts → Segments**, create the newsletter Segment and copy its ID to
   `RESEND_NEWSLETTER_SEGMENT_ID`. Do not create a Resend Audience; Audiences
   are deprecated.
4. Set `PUBLIC_MARKETING_URL` to the browser-facing marketing origin. The API
   creates confirmation and unsubscribe links below that origin at
   `/newsletter/confirm?token=...` and `/newsletter/unsubscribe?token=...`.
5. In Resend **Webhooks**, create this production endpoint:

   ```text
   https://os.trovara.farm/public/newsletter/webhook
   ```

   Subscribe it to exactly these events. The delivery events drive the
   per-campaign delivered, delayed, and failed counts shown in Trovara OS:

   ```text
   contact.updated
   email.sent
   email.scheduled
   email.delivered
   email.delivery_delayed
   email.failed
   email.suppressed
   email.bounced
   email.complained
   ```

   Copy its `whsec_...` signing secret to `RESEND_WEBHOOK_SECRET`. Trovara
   rejects missing or invalid Svix signatures; never use an unsigned production
   webhook adapter.

### Configure Resend inbound invoices (`finance@`)

Invoice intake uses Resend **Receiving** plus an `email.received` webhook.

Because Zoho Mail owns the MX records for `trovara.farm`, **do not replace or
mix the root-domain Zoho MX records with Resend MX records**. Use a dedicated
receiving subdomain so normal Zoho delivery remains deterministic:

1. In Resend, enable Receiving for a subdomain such as
   **`inbound.trovara.farm`**. Add only the MX record Resend shows for that
   subdomain in DNS, then wait for Resend to mark Receiving as verified.
2. In Zoho Mail Admin Console, open the `finance@trovara.farm` user:
   **Users → finance user → Mailbox Settings → Email Forwarding**. Add
   **`finance@inbound.trovara.farm`** as an external forwarding address and
   complete Zoho's verification using the message received by Resend. Keep
   Zoho's copy so `finance@trovara.farm` remains a normal human mailbox.
   External forwarding requires a paid Zoho Mail plan and may need to be
   allowed by the user's Email Policy.
3. Send a test invoice to `finance@trovara.farm` and confirm both outcomes:
   it remains visible in Zoho and appears under Resend Receiving for
   `finance@inbound.trovara.farm`.
4. Create a **second** Resend webhook (leave the newsletter webhook unchanged):

   ```text
   https://os.trovara.farm/public/finance/inbound
   ```

   Subscribe it to:

   ```text
   email.received
   ```

   Copy that webhook’s `whsec_...` signing secret to
   `RESEND_INBOUND_WEBHOOK_SECRET` (not `RESEND_WEBHOOK_SECRET`).
   Set `FINANCE_INBOUND_RECIPIENTS=finance@trovara.farm`; the recipient guard
   also accepts the same local part on the receiving subdomain, including
   `finance@inbound.trovara.farm`.

5. Keep `RESEND_API_KEY` as a full-access key so the API can call
   `emails.receiving.get` and `emails.receiving.attachments.list` after the
   webhook. Attachments (PDF/JPEG/PNG/WebP) are stored under evidence storage;
   a **pending** draft expense is created for Finance staff to label and approve.
   The sender name/email are stored on the draft. `receipt_ref` keeps the email
   Message-ID (audit/threading), not the sender address.
   Amount/vendor/date/currency are prefilled with hybrid extraction (PDF text
   first, then LLM text/vision when configured via `OPENAI_API_KEY` /
   `LLM_API_KEY`). Staff should still review drafts before approval. Approving
   an inbound draft sends a one-shot acknowledgment to the sender via Resend
   (skipped for noreply / `@trovara.farm` addresses).

---

Continue with remaining production checklist sections below.
6. Keep `NEWSLETTER_CONSENT_VERSION=1.0` until the consent language changes,
   then increment it so new consent evidence records the correct version.

Restart `trovara-api.service` after updating the environment. Check startup logs
for the newsletter configuration warning. If confirmation delivery is
unavailable, signup retains the pending row but intentionally returns 503.

## 3. Prepare persistent directories

Use the account that runs `trovara-api.service`. Check it with:

```bash
sudo systemctl show -p User --value trovara-api
```

If that prints `ubuntu`, or prints nothing and you intentionally deploy/run the
application as `ubuntu`, these commands are correct:

```bash
sudo install -d -m 0750 -o ubuntu -g ubuntu /var/lib/trovara-os/evidence
sudo install -d -m 0750 -o ubuntu -g ubuntu /var/backups/trovara-os
sudo install -d -m 0750 -o ubuntu -g ubuntu /home/ubuntu/trovara-os/logs
```

The evidence path must be outside versioned release directories. Nginx must not
serve it directly; evidence is retrieved only through the authenticated API.

`deploy.sh` now performs this setup automatically. It reads the systemd service
User, falling back to the SSH user. To explicitly use Ubuntu, add this to the
local `.env.deploy`:

```dotenv
APP_USER=ubuntu
```

## 4. Install, verify, migrate, and build

The normal local command selects a clean immutable commit or tag:

```bash
cd trovara-os
RELEASE_REF=<full-commit-sha-or-tag> ./deploy.sh
```

The deploy script selects Node 22 and runs `npm ci --include=dev` (the VM has
`NODE_ENV=production`, but test/build tools are dev dependencies), tests, the blocking
high-severity audit, production build, encrypted database/evidence backup,
freshness verification (remote rclone delivery optional when Mac pulls are the
second copy), migrations, frontend
release, service restart, and health/readiness checks on the VM. It embeds
`RELEASE.json` at the release root and web root and includes `docs/` in the
deployed artifact. A systemd drop-in pins the same SHA for the API process, and
the deploy fails unless the API and frontend both report it. Successful deploys
append to the private `.release-history/history.jsonl` ledger. It refuses
uncommitted or untracked source.

**Never use `./deploy.sh --skip-backup` on the live farm database.** That flag is
only for disposable demo databases.

### Migrations

Drizzle applies folders under `api/drizzle/` in **timestamp** order (not only by
the `00NN` label). Current tip is
`20260816140000_0074_knowledge_pipeline_hardening`.

Migration `0072` requires pgvector. When production uses this repository's
Docker database, set `USE_DOCKER_PG_TOOLS=1`; the deploy script starts that
container (and recreates it on the existing named volume when the image or
published port changed) before the verified backup and migrate. It pulls
`pgvector/pgvector:0.8.6-pg17`. This is
a same-major PostgreSQL 17 image change, but the verified backup remains
mandatory.

The Docker database binds to `127.0.0.1:${PGPORT:-5432}`. If a host-managed
PostgreSQL cluster already owns port 5432, set `PGPORT` to an unused localhost
port (for example `5433`) and use the same port in `DATABASE_URL`. Do not stop or
replace an unrelated host database to free port 5432.

For a host-managed PostgreSQL 17 database, install the pgvector server package
for that exact PostgreSQL major before deploying. Confirm availability without
changing data:

```bash
psql "$DATABASE_URL" -P pager=off \
  -c "SELECT name, default_version FROM pg_available_extensions WHERE name = 'vector';"
```

Do not run migration `0072` until that query returns `vector`; otherwise
`CREATE EXTENSION vector` will fail and the deployment will stop before restart.

Migration `0074` adds the durable document/index queue, immutable approved
versions, side-by-side vector generations, and retrieval evaluation records.
After migration, deploy the `knowledge-worker` with ClamAV, OCRmyPDF/Tesseract,
and private S3-compatible storage. The API may accept an upload while the worker
is offline, but the document remains quarantined and cannot become guidance.

For the repository Docker stack, generate independent values and add them to
the production `.env` before `docker compose up -d --build`:

```bash
openssl rand -hex 24   # KNOWLEDGE_STORAGE_ACCESS_KEY
openssl rand -hex 32   # KNOWLEDGE_STORAGE_SECRET_KEY
openssl rand -hex 32   # KNOWLEDGE_STORAGE_ENCRYPTION_KEY
```

Do not rotate `KNOWLEDGE_STORAGE_ENCRYPTION_KEY` until every existing object has
been decrypted and re-encrypted under a documented key-rotation procedure.
With `USE_DOCKER_KNOWLEDGE_SERVICES=1`, `deploy.sh` starts SeaweedFS and ClamAV
before the encrypted backup, applies migrations, and only then starts the
worker. This prevents a first deployment from processing jobs against an old
schema.

Note: there are two folders whose label contains `0027`
(`…_0027_trovara_os_advisory` and `…_0027_registration_tokens`). Both are
intentional; timestamps decide apply order. Do not manually mark migrations as
applied. Do not rebuild the DB to “fix” history on production.

After deploy, confirm:

```bash
psql "$DATABASE_URL" -P pager=off -c "SELECT id FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 5;"
psql "$DATABASE_URL" -P pager=off -c "SELECT extname, extversion FROM pg_extension WHERE extname = 'vector';"
```

(Exact journal table name may vary with Drizzle version; if that query fails,
use your usual migrate success log from `deploy.sh`.)

## 5. Scheduled jobs (cron)

With `CRON_SECRET` and `CRON_FARM_ID` (or equivalent farm targeting) set on the
VM, schedule at least:

```bash
# Example — daily 05:30 Africa/Lagos; adjust path/user
30 5 * * * cd /home/ubuntu/trovara-os && /home/ubuntu/.nvm/nvm-exec npm run send-proactive-alerts >> /var/log/trovara-proactive.log 2>&1

# Daily OS + marketing health/uptime snapshot (owners + supervisors)
0 6 * * * cd /home/ubuntu/trovara-os && /home/ubuntu/.nvm/nvm-exec npm run send-health-snapshot >> /var/log/trovara-health-snapshot.log 2>&1
```

Also schedule as needed (see [`INTEGRATIONS.md`](./INTEGRATIONS.md) / scripts):

- `npm run generate-tasks` (recurring templates)
- `npm run run-data-retention`
- `npm run send-evening-digest` (if used)
- encrypted backup timers ([`backup-runbook.md`](./backup-runbook.md))

Advisory + proactive alerts cron is expected to already be installed on the
live host; verify with `crontab -l` after any VM rebuild. The health snapshot job
is separate from farm ops proactive alerts and can be silenced from Settings
(`healthSlaAlertsEnabled`) or with `HEALTH_SLA_TELEGRAM_ENABLED=false`.

## 6. Restart and smoke-test

```bash
sudo systemctl restart trovara-api

curl -sf https://os.trovara.farm/health
curl -sf https://os.trovara.farm/ready
```

(`./deploy.sh` restarts `trovara-api` for you; the commands above are for manual ops.)  
External monitor intervals and escalation: [`uptime-monitoring.md`](./uptime-monitoring.md).  
Encrypted backup procedure: [`backup-runbook.md`](./backup-runbook.md).
Complete environment inventory: [`PRODUCTION-ENVIRONMENT.md`](./PRODUCTION-ENVIRONMENT.md).
Migration policy: [`EXPAND-CONTRACT-MIGRATIONS.md`](./EXPAND-CONTRACT-MIGRATIONS.md).
Coordinated OS-first release: [`RELEASE-CHECKLIST.md`](./RELEASE-CHECKLIST.md).

**nginx CSP:** apply the `Content-Security-Policy` (and related) headers from
[`nginx-os.trovara.farm.conf.example`](./nginx-os.trovara.farm.conf.example) on the
OS vhost. Customer Accounts (`shop.trovara.farm`) is a **separate** CloudPanel
site and repo (`trovara-shop`); nginx lives in that repo’s
`docs/nginx-shop.trovara.farm.conf.example`. The SPA also ships a matching meta CSP; `frame-ancestors` only works
as a response header. For Brand Kit video uploads, also apply the
`/api/brand/assets/upload` locations (120m body, `proxy_request_buffering off`,
900s timeouts) from that example.

**ffmpeg (Brand Kit):** install system packages before enabling photo/video packs:

```bash
sudo apt install ffmpeg
ffmpeg -version && ffprobe -version
ffmpeg -hide_banner -encoders | grep libx264
```

Then verify:

- owner / break-glass login (armed `BREAK_GLASS_ENABLED` + `BREAK_GLASS_PASSWORD`) and day-to-day owner TOTP;
- session list/revoke and forced password change (non–break-glass accounts);
- Settings → Alert subscriptions (customer order alerts vs worker alerts);
- task photo upload and authenticated evidence retrieval;
- public lot lookup/QR using `publicToken` and path `/lot/:farmSlug/:lotCode`;
- printable box label, certificate HTML;
- Telegram and WhatsApp webhook verification (when configured);
- customer order caps and known-recipient WhatsApp sends;
- staff TG/WA ops: `/done` → worker alert; order confirm/dispatch/delivered;
- privacy export reason/watermark, anonymization preview, and retention preview;
- encrypted database/evidence backup copied off-server;
- forgot-password email delivery (when email provider is configured);
- Paystack test charge + webhook (when keys are configured).

## 7. Application rollback

Use [`ROLLBACK.md`](./ROLLBACK.md) for the guarded exact-SHA rollback command,
release ledger, compatibility checks, and verification steps. Application
rollback redeploys an older Git object with `--skip-migrate`; it never reverses
the production database.

After an owner successfully verifies TOTP, legacy plaintext secrets are
re-encrypted. New task evidence is also stored as authenticated file URLs.
Older application releases cannot necessarily read those values. Prefer rolling
forward; a rollback may require resetting owner TOTP and retaining newer
evidence, vault, and order routes.
