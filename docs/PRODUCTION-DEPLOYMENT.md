# Trovara OS production deployment

Use Node 22 for every npm/npx command. The production database currently has no
real farm data, so a clean rebuild is acceptable if reconciling old migration
history is harder than preserving demo records.

## 1. Generate production secrets

Run each command independently and paste its output into the corresponding
production environment variable. Do not commit the generated values.

```bash
# 32-byte AES key; keep permanently or encrypted owner TOTP secrets become unreadable
openssl rand -hex 32
# -> TOTP_ENCRYPTION_KEY

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

# URL-safe PostgreSQL password if rotating the demo database
openssl rand -hex 32
# -> POSTGRES_PASSWORD (also update DATABASE_URL)
```

`META_APP_SECRET`, Telegram bot tokens, WhatsApp access tokens, and LLM API keys
must come from their provider dashboards; do not generate replacements locally.

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
`POST /auth/registration-tokens` (owner session) instead of the CLI. Leave
`OWNER_REGISTRATION_SECRET` empty in production (legacy reusable fallback only).
Full go-live flow: [GO-LIVE.md](../../GO-LIVE.md) step 7.

## 2. Required production configuration

```dotenv
NODE_ENV=production
API_HOST=127.0.0.1
API_PORT=3000
TRUSTED_PROXY_HOPS=1
CORS_ORIGIN=https://os.trovara.farm

PUBLIC_APP_URL=https://os.trovara.farm
VITE_API_URL=https://os.trovara.farm
VITE_PUBLIC_APP_URL=https://os.trovara.farm

TOTP_ENCRYPTION_KEY=<openssl output>
CRON_SECRET=<openssl output>
BREAK_GLASS_PASSWORD=<openssl output>
# BREAK_GLASS_EMAIL=owner@trovara.farm

EVIDENCE_STORAGE_ROOT=/var/lib/trovara-os/evidence
BACKUP_DIR=/var/backups/trovara-os
BACKUP_GPG_PASSPHRASE=<openssl output>
REQUIRE_EVIDENCE_BACKUP=1
# USE_DOCKER_PG_TOOLS=1  # enable only when using this repo's Docker Postgres

LLM_DAILY_BUDGET_PER_FARM=500
MAX_CUSTOMER_ORDER_VALUE_KOBO=50000000
MAX_CUSTOMER_ORDERS_PER_DAY=5

DATA_RETENTION_DAYS=365
SESSION_RETENTION_DAYS=7
CUSTOMER_CONTACT_RETENTION_DAYS=365
```

`VITE_API_URL` is the SPA’s API base (baked in at `npm run build`).  
`VITE_PUBLIC_APP_URL` / `PUBLIC_APP_URL` are the public site URL for lot links, emails, and certificates. On `os.trovara.farm` all three are usually the same origin.

`BREAK_GLASS_PASSWORD` authenticates the break-glass owner email at login time from env (not the DB hash). `./deploy.sh` requires `CRON_SECRET` in the **VM** production `.env` (not the laptop copy).
Set `TRUSTED_PROXY_HOPS` to the real topology: `1` for nginx directly in front
of the API, `2` when another trusted proxy/CDN is also in the forwarding chain.
Do not expose port 3000 directly to the internet.

`SESSION_SECRET` is no longer used by the current release. Keep it only while an
older release remains a rollback option.

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
user, falling back to the SSH user. To explicitly use Ubuntu, add this to the
local `.env.deploy`:

```dotenv
APP_USER=ubuntu
```

## 4. Install, verify, migrate, and build

The normal local command is now simply:

```bash
cd trovara-os
./deploy.sh
```

The deploy script selects Node 22 and runs `npm ci --include=dev` (the VM has
`NODE_ENV=production`, but test/build tools are dev dependencies), tests, the blocking
high-severity audit, production build, encrypted database/evidence backup,
backup verification, migrations, frontend release, service restart, and
health/readiness checks on the VM.

For a brand-new disposable demo database only, `./deploy.sh --skip-backup` is
available. Do not use that option after real data is entered.

Migration folders through `0025_worker_alerts_subscribe` must apply cleanly.
If the demo database has inconsistent migration history, take one final backup and
rebuild rather than manually marking migrations as applied.

## 5. Restart and smoke-test

```bash
sudo systemctl restart trovara-api

curl -sf https://os.trovara.farm/health
curl -sf https://os.trovara.farm/ready
```

(`./deploy.sh` restarts `trovara-api` for you; the commands above are for manual ops.)
Then verify:

- owner / break-glass login (`BREAK_GLASS_PASSWORD`) and TOTP;
- session list/revoke and forced password change (non–break-glass accounts);
- Settings → Alert subscriptions (customer order alerts vs worker alerts);
- task photo upload and authenticated evidence retrieval;
- public lot lookup/QR using `publicToken`, printable box label, certificate HTML;
- Telegram and WhatsApp webhook verification;
- customer order caps and known-recipient WhatsApp sends;
- staff TG/WA ops: `/done` → worker alert; order confirm/dispatch/delivered;
- privacy export reason/watermark, anonymization preview, and retention preview;
- encrypted database/evidence backup copied off-server.

## 6. Rollback warning

After an owner successfully verifies TOTP, legacy plaintext secrets are
re-encrypted. New task evidence is also stored as authenticated file URLs.
Older application releases cannot read those values. Prefer rolling forward; a
rollback may require resetting owner TOTP and retaining the new evidence route.
