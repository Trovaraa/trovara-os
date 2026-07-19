# Trovara OS Security

Reference for what is implemented, plus the release gate used before internet-facing deployment.

## Phase 1 Controls (implemented)

- Argon2 password hashing
- httpOnly session cookies (`SameSite=Strict`; `Secure` in production)
- Server-side RBAC on every protected route
- Zod input validation on API boundaries
- Drizzle ORM parameterized queries only
- Append-only audit log
- API binds to `127.0.0.1` by default
- CORS restricted to configured origins
- Security headers on all API responses
- Rate limiting on login (5 attempts / 15 min per IP)
- Rate limiting on mutations (120 writes / 15 min per user or IP)
- Rate limiting on AI endpoints (60/hour per user, configurable)
- CSRF double-submit cookie on POST/PATCH/DELETE (`trovara_csrf` + `X-CSRF-Token`)
- Session metadata: user agent + SHA-256 hashed IP stored on login
- Session revocation: `POST /auth/revoke-all-sessions`
- Password reset + forced change on first login (`mustChangePassword`) for staff accounts
- Break-glass owner login: password checked against `BREAK_GLASS_PASSWORD` in env (not DB hash); password change / forgot-password blocked for that email; use is audited as `break_glass_login`
- Owner alert subscriptions: separate opt-in for customer order alerts vs worker alerts (Telegram/WhatsApp)
- TOTP 2FA for owner accounts (setup/enable/disable in Settings)
- Butler prompt-injection hardening (sanitized inbound + anti-injection system rules)
- Data retention: `DATA_RETENTION_DAYS` + `npm run run-data-retention`
- Secrets in `.env` only - `.env.example` has placeholders
- All queries scoped by `farm_id`
- WhatsApp webhook: `X-Hub-Signature-256` HMAC verification (`META_APP_SECRET`)
- Telegram webhook: `secret_token` verification (`TELEGRAM_WEBHOOK_SECRET`)
- Request bodies capped at 12 MB (413)
- Security event log: `logs/security.log` (failed logins, CSRF, 403s, invalid webhooks)
- API error log: `logs/api.log` (5xx responses, unhandled errors)
- Encrypted backups: `scripts/backup-db-encrypted.sh` (GPG symmetric)
- Negative security tests: RBAC deny, CSRF, rate limits (29 tests in CI)

## Role Matrix

| Resource | owner | supervisor | sales | field_worker |
|----------|-------|------------|-------|--------------|
| Dashboard | read | read | read | read (limited) |
| Tasks - assign | yes | yes | no | no |
| Tasks - log completion | yes | yes | no | own only |
| Tasks - approve | yes | yes | no | no |
| Inventory | read/write | read/write | read | read |
| Products (add/rename) | yes | yes | yes | no |
| Products (remove) | yes | no | no | no |
| Sales / order status | yes | yes | yes | no |
| Customer order alerts | opt-in | always | always | never |
| Worker alerts | opt-in | always | never | never |
| Reports / finance | yes | zone only | no | no |
| Audit / CSV export | yes | no | no | no |
| User management | yes | no | no | no |
| Go-live / demo reset | yes | no | no | no |

### Break-glass notes

- Email: `BREAK_GLASS_EMAIL` (default `owner@trovara.farm`) — reserved; do not use it for Founder self-registration.
- Emergency password: `BREAK_GLASS_PASSWORD` in server `.env` (restart API after changing).
- If that user also has a DB password (e.g. registered before the reserve rule), either the env password or the DB password can sign in; only the env path is audited as `break_glass_login`.
- Failed logins do not reveal env values.

## Laptop Dev

- Postgres published to `127.0.0.1:5432` for host API access (dev only)
- Do not expose `0.0.0.0` without explicit need
- Use ngrok/Tailscale for temporary remote demos only
- `logs/` directory is gitignored - review locally before sharing

## Still manual / ops (production is live)

- Confirm all secrets rotated on the server (OpenAI, Telegram, SESSION_SECRET, POSTGRES_PASSWORD)
- Confirm HTTPS is enabled for `os.trovara.farm`
- Configure off-server encrypted backups + logrotate for `logs/*.log`
- Set `META_APP_SECRET` when WhatsApp goes live
- **Set `CRON_SECRET` in production** — cron scripts (`run-data-retention`, proactive alerts, evening digest) must authenticate with `X-CRON-SECRET`; do not rely on owner password fallbacks in production

---

## Release Checklist

Use this as a release gate before internet-facing deployment (or each production push).

### V1. Authentication & Session

- [ ] Default/dev passwords rotated; no shared credentials remain.
- [ ] `SESSION_SECRET` and DB credentials rotated from any previously exposed values.
- [ ] Disabled users cannot keep active sessions.
- [ ] Login failures are rate-limited and recorded in `logs/security.log`.

### V2. Access Control

- [ ] Owner-only endpoints return 403 for supervisor/field worker access attempts.
- [ ] Cross-farm resource access is denied (404/403) across key routes.
- [ ] Sensitive routes use explicit role checks (`requireRole`, `canAccessFinance`, etc.).
- [ ] Forbidden access attempts are logged for review.

### V3. Request Integrity & Input Safety

- [ ] CSRF token is required for mutating browser-session requests.
- [ ] CSRF failures are logged and monitored.
- [ ] Mutating API routes have rate limiting (120 writes per 15 min per user/IP).
- [ ] Request body size limits are enforced at app and reverse-proxy levels.

### V4. Webhook Trust Boundary

- [ ] WhatsApp webhook signature verification is active (`META_APP_SECRET` set in production).
- [ ] Telegram webhook secret verification is active for webhook mode.
- [ ] Invalid webhook signatures/secrets are logged in `logs/security.log`.

### V5. Cryptography & Data Protection

- [ ] Backup encryption is enabled (`backup-db-encrypted.sh` with GPG passphrase).
- [ ] Backup files are stored off-machine securely and not committed to git.
- [ ] TLS termination (HTTPS) is enabled in deployed environments.

### V6. Monitoring, Audit & Response

- [ ] Security logs are reviewed before each release.
- [ ] Audit events export is available and validated for owner role.
- [ ] Proactive alerting and evening digest jobs are configured and tested.
- [ ] Incident response contacts/runbook are documented for pilot operations.

### V7. Verification & Hygiene

- [ ] Negative security tests pass in CI (RBAC, CSRF, rate limits, urgent triggers).
- [ ] `npm audit` reviewed; unresolved findings documented with risk acceptance.
- [ ] Secrets are not present in docs, scripts, or repository history.
