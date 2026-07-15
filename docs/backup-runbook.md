# Trovara OS - Backup & Restore Runbook (Laptop Dev)

This runbook covers local PostgreSQL backup and restore for Trovara OS development on a laptop.

## Prerequisites

- Docker running with Trovara Postgres (`docker compose up -d` from `trovara-os/`)
- `.env` configured from `.env.example` with strong local-only passwords
- `pg_dump` and `psql` installed (Postgres client tools)

## Environment variables

From `.env`:

| Variable | Example | Purpose |
|----------|---------|---------|
| `POSTGRES_USER` | `trovara` | Database user |
| `POSTGRES_PASSWORD` | strong random | Database password |
| `POSTGRES_DB` | `trovara_os` | Database name |
| `DATABASE_URL` | `postgresql://…@127.0.0.1:5432/trovara_os` | App connection string |

Optional for the backup script:

| Variable | Default | Purpose |
|----------|---------|---------|
| `ENV_FILE` | `trovara-os/.env` | Path to env file |
| `BACKUP_DIR` | `trovara-os/backups` | Output directory |
| `PGHOST` | `127.0.0.1` | Postgres host |
| `PGPORT` | `5432` | Postgres port |
| `BACKUP_GPG_PASSPHRASE` | _(required for encrypted script)_ | Symmetric encryption passphrase |

## Backup

```bash
cd trovara-os
./scripts/backup-db.sh
```

Output: `backups/trovara_os_YYYYMMDD_HHMMSS.sql`

## Encrypted backup (recommended)

Use this for NDPA-sensitive dumps (staff phones, operations logs):

```bash
cd trovara-os
./scripts/backup-db-encrypted.sh
```

Output: `backups/trovara_os_YYYYMMDD_HHMMSS.sql.gpg` (raw `.sql` is removed after encryption).

Verify the file is non-empty:

```bash
ls -lh backups/
head -5 backups/trovara_os_*.sql
```

## Restore (full replace)

**Warning:** This drops and recreates the public schema. All current data is lost.

```bash
cd trovara-os
source .env

export PGPASSWORD="$POSTGRES_PASSWORD"
BACKUP_FILE="backups/trovara_os_YYYYMMDD_HHMMSS.sql"  # pick your file

psql -h 127.0.0.1 -p 5432 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"

psql -h 127.0.0.1 -p 5432 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -f "$BACKUP_FILE"
```

After restore, restart the API and verify:

```bash
curl -s http://127.0.0.1:3000/health
```

## Restore demo seed (alternative)

If you only need fresh demo data (not a prior backup):

```bash
cd trovara-os/api
npm run seed
```

Or as owner via API: `POST /api/onboarding/reset-demo` (requires active session).

## Recommended cadence (laptop dev)

| When | Action |
|------|--------|
| Before schema migrations | Run backup |
| Before demo reset / seed | Run backup |
| Weekly during active dev | Run backup |
| Before OS upgrade / Docker volume wipe | Run backup + copy `backups/` off-machine |

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `connection refused` | Start Docker: `docker compose up -d` |
| `pg_dump: command not found` | Install Postgres client (`brew install libpq`) |
| Empty backup file | Check credentials in `.env` match `docker-compose.yml` |
| Restore fails on extensions | Use `--no-owner --no-acl` dumps (script default) |

## Production note

This runbook is for **local laptop dev only**. Future SaaS deployments will use managed Postgres with automated snapshots, point-in-time recovery, and Nigeria data residency per [`ndpa-compliance.md`](./ndpa-compliance.md).
