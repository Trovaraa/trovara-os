# Production logs, request IDs, and drains

## Current production default (disk-first)

Until an off-host drain is chosen, production relies on local logs only:

- Structured application events append to `logs/api.log` on the API host
  (see `api/src/lib/api-log.ts`).
- The systemd unit should send API stdout/stderr to journald
  (`journalctl -u trovara-api`).
- Keep `logrotate` (or equivalent) on `logs/api.log` so disk cannot fill
  unbounded; retain enough history for incident review (target ~30 days).

`API_LOG_DRAIN_URL` / `API_LOG_DRAIN_TOKEN` are **optional**. When unset, the
API does not attempt an HTTPS drain. Production preflight does **not** require
them. Enabling a drain later is tracked in
[`next-steps-trovara-os.md`](../../next-steps-trovara-os.md).

## Future: optional HTTPS log drain

When ready, set:

```dotenv
API_LOG_DRAIN_URL=https://<ingest-host>/...
API_LOG_DRAIN_TOKEN=<restricted-ingest-token>
```

The API POSTs each structured JSON log line with
`Authorization: Bearer <token>`. Failures are logged to stderr and must never
block requests. Prefer a provider-neutral collector path (Vector, Fluent Bit,
Promtail, or the provider's agent) in front of the sink when possible, and keep
provider credentials outside this repository.

### Suggested options (pick one later)

| Option | Fit | Notes |
|---|---|---|
| **Better Stack / Logtail** | Fastest hosted start | HTTPS ingest URL + source token; free tier often enough for a single farm API. |
| **Axiom** | Cheap searchable JSON | Simple HTTP ingest; good for structured `api.log` events. |
| **Grafana Cloud Loki** | If you already use Grafana | Ship via Promtail/Alloy from journald + `api.log`; keep long-term search off the VM. |
| **Self-hosted Vector → object storage** | Max control, more ops | Tail `api.log` / journald on the VM, ship to S3/Backblaze; no SaaS dependency. |
| **Papertrail / similar syslog HTTPS** | Simple ops familiarity | Fine for short retention; confirm NDPA/processor list before enabling. |

Whichever you choose: restricted ingest token, TLS only, no secrets in Git, and
confirm the processor is listed in the privacy notice if personal data can
appear in error context (prefer redaction over shipping PII).

## Required fields and handling

- UTC timestamp, level, service, environment, release SHA, HTTP method, route
  template, status, duration, and request ID;
- structured JSON at the API boundary; never log cookies, authorization/CSRF
  headers, passwords, tokens, request bodies, evidence, or database URLs;
- 30-day searchable retention by default once a drain exists, restricted
  operator access, and alerts for error-rate/readiness changes;
- drain queue/backpressure monitoring so a provider outage cannot block API
  requests or exhaust local disk;
- include the deployed SHA from `RELEASE.json` in collector metadata.

Nginx should accept a syntactically safe inbound `X-Request-ID` or generate one,
log it, pass it upstream, and return it to the client. The API must bind that ID
to each structured application/error log.
