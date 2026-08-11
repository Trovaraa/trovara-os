# Production environment inventory

`.env.example` is the canonical exhaustive variable reference. This document
classifies production values and records the deployment gate. Keep secrets in
the host secret store/environment file, never Git.

## Required deployment gate

- Runtime/database: `NODE_ENV`, `API_HOST`, `API_PORT`, `DATABASE_URL`,
  `CORS_ORIGIN`, `TRUSTED_PROXY_HOPS`.
- Public origins: `PUBLIC_APP_URL`, `PUBLIC_MARKETING_URL`; build-time
  `VITE_API_URL`, `VITE_PUBLIC_APP_URL`, `VITE_PUBLIC_MARKETING_URL`.
- Encryption/auth: `CRON_SECRET`, `BREAK_GLASS_PASSWORD`,
  `TOTP_ENCRYPTION_KEY` (or `TOTP_KEY_DERIVATION_SECRET`), and the separate
  `VAULT_ENCRYPTION_KEY`.
- Public-boundary: shared `FORM_PROXY_SIGNING_SECRET` (must match Netlify).
  Application logs write to disk (`logs/api.log` + journald); an HTTPS log
  drain is optional for now — see reminders and the ops roadmap.
- Farm/storage: `CUSTOMER_FARM_ID`, `EVIDENCE_STORAGE_ROOT`, `BACKUP_DIR`,
  `BACKUP_GPG_PASSPHRASE`, `REQUIRE_EVIDENCE_BACKUP=1`.
- Encrypted backups on the VM plus the deploy Mac pull
  (`./deploy.sh --pull-backups`) are the current off-VM copy path. Rclone
  offsite (`BACKUP_REMOTE_*` / `BACKUP_RCLONE_DESTINATION`) is optional and
  does not block deploy preflight.

Production must keep `BREAK_GLASS_ENABLED`, `ALLOW_FULL_DB_RESET`, and
`LIVE_MODE_OVERRIDE` false/unset. `scripts/check-production-env.sh` enforces
these conditions before install, backup, migration, build, or frontend release.

## Required when a feature is enabled

- WhatsApp: `WHATSAPP_ACCESS_TOKEN`, phone-number IDs,
  `WHATSAPP_VERIFY_TOKEN`, `META_APP_SECRET`; customer token may override.
- Telegram: bot token(s) and matching webhook secret(s) in webhook mode.
- Email/newsletter/inbound finance: `RESEND_API_KEY`, `EMAIL_FROM` or
  `RESEND_FROM`; set the applicable newsletter/inbound webhook secrets,
  segment, recipient, consent-version values, and `FINANCE_INBOUND_FARM_ID`.
- Paystack: secret/public keys when payments are enabled.
- AI/weather/search: provider key, model/base URL, limits, and fallback settings
  only for enabled providers.
- Brand media: ffmpeg/ffprobe paths and upload limits when overridden.
- Notifications: SMS webhook URL/token/from and required switch when enabled.

## Optional operational tuning

Retention windows, LLM budgets, customer order caps, translation retry limits,
health/uptime snapshot URLs/timeouts, backup report path, PostgreSQL tool mode,
brand-pack session secret, and storage limits retain the defaults documented in
`.env.example`. Review that file on every release that adds an environment read.

## Production reminders (not blocking until you need them)

These are **not** required by `check-production-env.sh` when the related feature
is off or a safe default already exists. Add them when you enable the feature
or want explicit ops control:

| Variable | Required? | Reminder |
|---|---|---|
| `API_LOG_DRAIN_URL` / `API_LOG_DRAIN_TOKEN` | No (disk-first for now) | Optional HTTPS POST drain. Until chosen, rely on `logs/api.log` + journald. Tracked in [`next-steps-trovara-os.md`](../../next-steps-trovara-os.md) and [`LOGGING-AND-REQUEST-IDS.md`](./LOGGING-AND-REQUEST-IDS.md). |
| `BACKUP_REMOTE_ENABLED` / `BACKUP_REMOTE_REQUIRED` / `BACKUP_RCLONE_DESTINATION` | No | Optional rclone offsite. Default ops path is encrypted VM backups + Mac pull on deploy. Enable later for cloud offsite; if either remote flag is `1`, destination must be set. See [`backup-runbook.md`](./backup-runbook.md). |
| `FX_FALLBACK_RATES` | No | Offline NGN rates when open.er-api.com is unreachable. Example: `USD:1550,EUR:1700,GBP:2000`. Without it, FX conversion fails closed until live rates return. |
| `MOMENTS_CONSENT_VERSION` | No | Defaults to `2026-08-11`. Set explicitly (and match the marketing Moments form) whenever privacy/consent wording changes. |
| `TOTP_KEY_DERIVATION_SECRET` | No if `TOTP_ENCRYPTION_KEY` is set | Alternate TOTP key path; ignore when `TOTP_ENCRYPTION_KEY` is already present. |
| `WHATSAPP_ACCESS_TOKEN` / `META_APP_SECRET` / phone IDs / verify token | Only when WhatsApp is enabled | Leave unset while Telegram-only. Enabling WhatsApp without `META_APP_SECRET` fails the production gate. |
| `BREAK_GLASS_ENABLED` | Must stay unset/`false` | Arm only for emergency recovery, then disarm and restart. |

After editing production values, run the preflight as the service account:

```bash
set -a; source .env; set +a
bash scripts/check-production-env.sh
```
