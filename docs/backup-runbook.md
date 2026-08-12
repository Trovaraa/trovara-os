# Trovara OS - Backup & Restore Runbook

This runbook covers PostgreSQL and private evidence backup/restore. Production
uses encrypted, checksummed artifacts. Delivery can use any rclone-supported
storage. Remote delivery is optional in development and mandatory when
`NODE_ENV=production`.

## Prerequisites

- Docker running with Trovara Postgres (`docker compose up -d` from `trovara-os/`)
- `.env` configured from `.env.example` with strong local-only passwords
- `pg_dump` and `psql` installed (Postgres client tools)
- `gpg` installed for encrypted backups (`brew install gnupg` on macOS or
  `sudo apt-get install gnupg` on Debian/Ubuntu)
- `rclone` installed and configured for off-server production delivery
- Docker available to the service account for isolated restore tests

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
| `USE_DOCKER_PG_TOOLS` | `0` | Set to `1` for the repo's Docker database so `pg_dump` runs at the server version |
| `BACKUP_GPG_PASSPHRASE` | _(required for encrypted script)_ | Symmetric encryption passphrase |
| `EVIDENCE_STORAGE_ROOT` | `api/data/evidence` | Private evidence directory |
| `REQUIRE_EVIDENCE_BACKUP` | `0` | Set to `1` in production so verify/restore fails when the evidence archive is missing |
| `BACKUP_REPORT_DIR` | `$BACKUP_DIR/reports` | Atomic machine-readable backup and restore-test reports |
| `BACKUP_REMOTE_ENABLED` | `0` | Set to `1` to deliver production artifacts with rclone |
| `BACKUP_REMOTE_REQUIRED` | `0` | Set to `1` to require remote delivery; this also enables it |
| `BACKUP_RCLONE_DESTINATION` | _(none)_ | rclone destination such as `offsite:trovara/production` |
| `RESTORE_TEST_POSTGRES_IMAGE` | `postgres:16-alpine` | Ephemeral restore-test image; pin to the production PostgreSQL major version |

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

Outputs:

- `backups/trovara_os_YYYYMMDD_HHMMSS.sql.gpg`
- `backups/trovara_os_YYYYMMDD_HHMMSS.evidence.tar.gpg`

The raw SQL and tar files are removed after encryption. Keep both encrypted
files together when copying backups off-server.

Verify the file is non-empty:

```bash
ls -lh backups/
head -5 backups/trovara_os_*.sql
```

## Production backup orchestration

```bash
cd trovara-os
npm run backup:production
```

This command preserves the encrypted backup workflow, verifies the encrypted
database and evidence archive, writes a SHA-256 manifest, and atomically
publishes `reports/latest-backup.json`. Partial local files use `.partial`
names and are never treated as completed backups. The report contains artifact
names and delivery state only; it never contains database, GPG, or rclone
credentials.

With the safe defaults, the command stops after creating local artifacts. To
enable off-server delivery:

```dotenv
BACKUP_REMOTE_ENABLED=1
BACKUP_REMOTE_REQUIRED=1
BACKUP_RCLONE_DESTINATION=offsite:trovara/production
```

Configure the `offsite` remote with `rclone config` under the same operating
system account that runs the backup. Keep provider credentials in rclone's
restricted config or its supported external secret mechanism, not in the
Trovara environment file. The script uploads each artifact under a temporary
remote name and moves it to its final name only after upload succeeds.

`BACKUP_REMOTE_REQUIRED=1` is optional. When set, rclone delivery is enabled
and fail-closed: if rclone, its destination, or delivery fails, the command
exits non-zero and does not publish a new success report. Leaving remote flags
unset is fine when deploy Mac pulls are the off-VM copy
(`./deploy.sh --pull-backups`).

## Pull encrypted backups to the deployment Mac

The deployment computer can also act as a second off-server location. A full
deployment can create the production backup and then pull encrypted artifacts:

```bash
cd trovara-os
./deploy.sh --pull-backups
```

The deploy now runs `backup:production`, so the copied set contains the
encrypted database, encrypted evidence archive, checksum manifest, and reports.
Configure the locations in the gitignored `.env.deploy`:

```dotenv
REMOTE_BACKUP_DIR=/var/backups/trovara-os
LOCAL_BACKUP_DIR="/Users/your-user/Trovara Backups/production"
```

To pull without deploying:

```bash
./scripts/pull-production-backups.sh
```

Only `.gpg`, `.manifest.sha256`, and report `.json` files are copied. Plain SQL
and partial files are excluded. The local directory is restricted to the local
user.

This protects each deployment, but deployment frequency is not a backup
schedule. For daily copies, keep the VM's systemd backup timer enabled and
install the macOS launchd example:

```bash
cp docs/launchd/com.trovara.pull-production-backups.plist.example \
  "$HOME/Library/LaunchAgents/com.trovara.pull-production-backups.plist"
plutil -lint "$HOME/Library/LaunchAgents/com.trovara.pull-production-backups.plist"
launchctl bootstrap "gui/$(id -u)" \
  "$HOME/Library/LaunchAgents/com.trovara.pull-production-backups.plist"
launchctl kickstart -k "gui/$(id -u)/com.trovara.pull-production-backups"
```

The Mac must be powered on or wake later, have network access, and be able to
authenticate to the VM. A laptop copy is useful redundancy but should not be
the only off-server destination; a restricted object-storage remote remains
the stronger always-online production target.

## Restore (full replace)

**Warning:** This drops and recreates the public schema. All current data is lost.

```bash
cd trovara-os
./scripts/restore-db.sh backups/trovara_os_YYYYMMDD_HHMMSS.sql
# or encrypted:
./scripts/restore-db.sh backups/trovara_os_YYYYMMDD_HHMMSS.sql.gpg
```

Set `BACKUP_GPG_PASSPHRASE` (or `GPG_PASSPHRASE`) in `.env` for `.sql.gpg` files.
Non-interactive restore: `FORCE_RESTORE=1 ./scripts/restore-db.sh <file>`

## Verify backup

```bash
cd trovara-os
npm run backup:verify
# or a specific file:
./scripts/verify-backup.sh backups/trovara_os_YYYYMMDD_HHMMSS.sql.gpg
```

To validate checksums manually from the backup directory:

```bash
sha256sum -c trovara_os_YYYYMMDD_HHMMSS.manifest.sha256
```

On macOS use `shasum -a 256 -c` instead.

## Isolated restore test

```bash
cd trovara-os
npm run backup:restore-test
# or test a specific artifact:
./scripts/restore-test-isolated.sh /var/backups/trovara-os/example.sql.gpg
```

The script verifies the backup, starts an ephemeral PostgreSQL container,
restores into the fixed `trovara_restore_test` database inside that container,
checks critical tables, the complete migration journal, production farm data,
and container isolation (`--network none`, tmpfs database storage, no host
mounts), then writes
`reports/latest-restore-test.json` atomically, and removes the container and
decrypted temporary SQL. It never uses `DATABASE_URL`, `PGHOST`, or a production
database. It refuses `RESTORE_TEST_DATABASE_URL`, `RESTORE_TEST_PGHOST`, and
`RESTORE_TEST_TARGET_DB` so a scheduler cannot redirect it to production.

## Restore (manual psql)

For emergencies without the restore script, drop the public schema and replay a plain `.sql` dump with `psql -f`.

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

## systemd production scheduling

Example units are in [`docs/systemd/`](./systemd/):

- `trovara-backup.service` and `.timer`: nightly at 02:15
- `trovara-restore-test.service` and `.timer`: weekly Sunday at 04:15

The recommended installation path uses deployment configuration to generate
units with the real remote directory and service user:

```bash
./deploy.sh --install-backup-timers --pull-backups
```

This is opt-in. It validates that the service account can use Docker, installs
and enables both VM timers, creates a fresh encrypted backup during deployment,
and copies the completed encrypted artifacts to the configured Mac directory.

Review and replace the example `ubuntu` account and `/home/ubuntu/trovara-os`
paths before installation:

```bash
sudo cp docs/systemd/trovara-{backup,restore-test}.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now trovara-backup.timer trovara-restore-test.timer
sudo systemctl start trovara-backup.service
sudo systemctl status trovara-backup.service
systemctl list-timers 'trovara-*'
```

The restore-test service account needs Docker access. Test both services
manually before relying on timers. Inspect reports under
`$BACKUP_DIR/reports/` and service logs with
`journalctl -u trovara-backup.service` or
`journalctl -u trovara-restore-test.service`.

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `connection refused` | Start Docker: `docker compose up -d` |
| `pg_dump: command not found` | Install Postgres client (`brew install libpq`) |
| `server version mismatch` | Set `USE_DOCKER_PG_TOOLS=1` or install a `pg_dump` version at least as new as the server |
| Empty backup file | Check credentials in `.env` match `docker-compose.yml` |
| Restore fails on extensions | Use `--no-owner --no-acl` dumps (script default) |

## Production note

Use persistent paths outside the release directory:

```dotenv
EVIDENCE_STORAGE_ROOT=/var/lib/trovara-os/evidence
BACKUP_DIR=/var/backups/trovara-os
REQUIRE_EVIDENCE_BACKUP=1
# Optional rclone offsite (not required when using deploy Mac pulls):
# BACKUP_REMOTE_ENABLED=1
# BACKUP_REMOTE_REQUIRED=1
# BACKUP_RCLONE_DESTINATION=<configured-rclone-remote>:trovara/production
BACKUP_MAX_AGE_HOURS=26
```

Encrypted VM backups plus `./deploy.sh --pull-backups` are the current default
second copy. Rclone offsite is optional; enable only after configuring and
verifying the remote. The provider and path remain configurable through rclone
and `BACKUP_RCLONE_DESTINATION`.

The authenticated system status endpoint reads `BACKUP_DIR` and treats a
successful `reports/latest-backup.json` with all three referenced local
artifacts as stronger evidence than file modification times. Legacy backups
without a report remain visible as filesystem evidence.

See [`PRODUCTION-DEPLOYMENT.md`](./PRODUCTION-DEPLOYMENT.md) for directory
permissions, secret-generation commands, migration order, and smoke tests.
Managed database snapshots and point-in-time recovery should complement this
workflow; they do not replace tested off-server logical and evidence backups.

## External setup still required

1. Install `gpg`, PostgreSQL client tools, and Docker on the backup host.
   Install `rclone` only if you enable cloud offsite later.
2. Create persistent `BACKUP_DIR` and evidence directories owned by the service
   account with restrictive permissions.
3. Store a strong `BACKUP_GPG_PASSPHRASE` in the protected production
   environment and retain a recovery copy outside the host.
4. Keep a second copy via `./deploy.sh --pull-backups` (current default).
   Optionally choose a cloud provider, configure an rclone remote as the
   service account, set `BACKUP_RCLONE_DESTINATION` + `BACKUP_REMOTE_ENABLED=1`,
   and verify with `rclone lsd <remote>:` then `npm run backup:production`.
5. Customize/install the example units, grant the service account Docker
   access, enable both timers, and configure external monitoring for non-zero
   service exits and stale backup/restore-test reports.
