# Trovara OS health and uptime snapshots

Use these HTTP probes against the public API base URL (via nginx or direct
`127.0.0.1:3000` on the host).

## Endpoints

| Probe | Path | Auth | Expected | Use |
|-------|------|------|----------|-----|
| Liveness | `GET /health` | None | `200` JSON `{ "status": "ok" }` | Process is running |
| Readiness | `GET /ready` | None | `200` when DB reachable; `503` when not | Traffic routing / paging |

## Example checks

```bash
# Liveness (no DB required)
curl -sf https://os.trovara.farm/health

# Readiness (includes DB latency)
curl -sf https://os.trovara.farm/ready
```

## Suggested monitor configuration

| Setting | Liveness `/health` | Readiness `/ready` |
|---------|-------------------|-------------------|
| Interval | 60s | 60s |
| Timeout | 5s | 10s |
| Failure threshold | 3 consecutive | 2 consecutive |
| Alert | Warning | Critical (stop routing) |

Readiness failure usually means Postgres is down, migrations failed, or the API
cannot connect to `DATABASE_URL`. Liveness failure means the Node process is
not responding.

Create both monitors in an external service such as Better Stack,
UptimeRobot, Pingdom, or Grafana Cloud. Monitoring on the Trovara VM cannot
alert reliably when that VM is unavailable. Configure:

- at least two verified alert contacts;
- email plus SMS/phone escalation for `/ready`;
- recovery notifications and TLS certificate-expiry alerts;
- a deployment maintenance window;
- escalation when readiness remains unavailable for several minutes.

After setup, deliberately pause the API during an agreed maintenance window
and confirm that failure and recovery alerts reach the selected contacts.

## Daily Telegram health / uptime snapshot

In addition to external monitors, Trovara can run a once-daily probe of OS and
marketing endpoints and post a compact point-in-time health summary to **owners and supervisors**
who have linked Telegram chats:

```bash
npm run send-health-snapshot
# POST /api/alerts/run-health-sla (CRON_SECRET + CRON_FARM_ID)
```

Default probes:

| Group | Paths |
|-------|-------|
| OS | `/health`, `/ready`, `/public/moments`, `/public/careers` |
| Marketing | `/`, `/moments`, `/careers`, `/privacy` |

The route and `HEALTH_SLA_*` environment names are retained for API
compatibility; the result is a snapshot, not a contractual SLA calculation.
Toggle off from **Settings → Daily health snapshot**, or set
`HEALTH_SLA_TELEGRAM_ENABLED=false` on the API host. This does **not** replace
farm ops proactive alerts (`send-proactive-alerts`).

## Owner dashboard

Owners and supervisors can also review backup recency via
`GET /system-status` (session auth). The endpoint honors `BACKUP_DIR` and
reports `lastBackup`, `backupCount`, `backupEvidence`, `backupReportStatus`,
`remoteDeliveryStatus`, `restoreTestStatus`, `restoreTestAgeHours`, and
`restoreTestFresh`. These are sanitized status fields; report paths and secrets
are not exposed. External monitoring should additionally alert on failed
systemd backup/restore-test units and stale reports.

## Related ops docs

- [`backup-runbook.md`](./backup-runbook.md) - backup/restore scripts
- [`security.md`](./security.md) - release checklist and log review
- [`nginx-os.trovara.farm.conf.example`](./nginx-os.trovara.farm.conf.example) - TLS and proxy headers
