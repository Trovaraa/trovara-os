# Trovara OS Security Notes

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
- Password reset + forced change on first login (`mustChangePassword`)
- TOTP 2FA for owner accounts (setup/enable/disable in Settings)
- Butler prompt-injection hardening (sanitized inbound + anti-injection system rules)
- Data retention: `DATA_RETENTION_DAYS` + `npm run run-data-retention`
- Secrets in `.env` only — `.env.example` has placeholders
- All queries scoped by `farm_id`
- WhatsApp webhook: `X-Hub-Signature-256` HMAC verification (`META_APP_SECRET`)
- Telegram webhook: `secret_token` verification (`TELEGRAM_WEBHOOK_SECRET`)
- Request bodies capped at 12 MB (413)
- Security event log: `logs/security.log` (failed logins, CSRF, 403s, invalid webhooks)
- API error log: `logs/api.log` (5xx responses, unhandled errors)
- Encrypted backups: `scripts/backup-db-encrypted.sh` (GPG symmetric)
- Negative security tests: RBAC deny, CSRF, rate limits (29 tests in CI)

## Role Matrix

| Resource | owner | supervisor | field_worker |
|----------|-------|------------|--------------|
| Dashboard | read | read | read (limited) |
| Tasks — assign | yes | yes | no |
| Tasks — log completion | yes | yes | own only |
| Tasks — approve | yes | yes | no |
| Inventory | read/write | read/write | read |
| Reports / finance | yes | zone only | no |
| Audit / CSV export | yes | no | no |
| User management | yes | no | no |
| Go-live / demo reset | yes | no | no |

## Laptop Dev

- Postgres published to `127.0.0.1:5432` for host API access (dev only)
- Do not expose `0.0.0.0` without explicit need
- Use ngrok/Tailscale for temporary remote demos only
- `logs/` directory is gitignored — review locally before sharing

## Release Checklist

See [`SECURITY-RELEASE-CHECKLIST.md`](./SECURITY-RELEASE-CHECKLIST.md) before internet deployment.

## Still manual / ops (production is live)

- Confirm all secrets rotated on the server (OpenAI, Telegram, SESSION_SECRET, POSTGRES_PASSWORD)
- Confirm HTTPS is enabled for `os.trovara.farm`
- Configure off-server encrypted backups + logrotate for `logs/*.log`
- Set `META_APP_SECRET` when WhatsApp goes live
