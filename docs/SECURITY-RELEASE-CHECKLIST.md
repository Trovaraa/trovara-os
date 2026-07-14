# Trovara OS Security Release Checklist

Use this checklist as a release gate before internet-facing deployment.

## V1. Authentication & Session

- [ ] Default/dev passwords rotated; no shared credentials remain.
- [ ] `SESSION_SECRET` and DB credentials rotated from any previously exposed values.
- [ ] Disabled users cannot keep active sessions.
- [ ] Login failures are rate-limited and recorded in `logs/security.log`.

## V2. Access Control

- [ ] Owner-only endpoints return 403 for supervisor/field worker access attempts.
- [ ] Cross-farm resource access is denied (404/403) across key routes.
- [ ] Sensitive routes use explicit role checks (`requireRole`, `canAccessFinance`, etc.).
- [ ] Forbidden access attempts are logged for review.

## V3. Request Integrity & Input Safety

- [ ] CSRF token is required for mutating browser-session requests.
- [ ] CSRF failures are logged and monitored.
- [ ] Mutating API routes have rate limiting (120 writes per 15 min per user/IP).
- [ ] Request body size limits are enforced at app and reverse-proxy levels.

## V4. Webhook Trust Boundary

- [ ] WhatsApp webhook signature verification is active (`META_APP_SECRET` set in production).
- [ ] Telegram webhook secret verification is active for webhook mode.
- [ ] Invalid webhook signatures/secrets are logged in `logs/security.log`.

## V5. Cryptography & Data Protection

- [ ] Backup encryption is enabled (`backup-db-encrypted.sh` with GPG passphrase).
- [ ] Backup files are stored off-machine securely and not committed to git.
- [ ] TLS termination (HTTPS) is enabled in deployed environments.

## V6. Monitoring, Audit & Response

- [ ] Security logs are reviewed before each release.
- [ ] Audit events export is available and validated for owner role.
- [ ] Proactive alerting and evening digest jobs are configured and tested.
- [ ] Incident response contacts/runbook are documented for pilot operations.

## V7. Verification & Hygiene

- [ ] Negative security tests pass in CI (RBAC, CSRF, rate limits, urgent triggers).
- [ ] `npm audit` reviewed; unresolved findings documented with risk acceptance.
- [ ] Secrets are not present in docs, scripts, or repository history.
