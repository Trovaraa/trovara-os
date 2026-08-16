# Trovara OS application rollback

Trovara OS supports a guarded **application rollback** by rebuilding and
redeploying an exact Git commit or tag. The database remains at its current,
forward-only migration level. This is deliberate: automatically reversing a
production schema can discard farm records created after the release.

Use a forward fix when it can be prepared safely. Use rollback when the active
application is unhealthy or has a serious regression and a known compatible
release is available.

## What is versioned

Every successful deployment records:

- the immutable Git SHA and optional exact tag;
- release and completion timestamps;
- whether the operation was a deployment or rollback;
- the previous SHA and explicit rollback source, when applicable;
- the operator;
- the migration count and migration tip bundled with the release;
- the verified backup report and artifact names.

Public deployment identity is available at `/RELEASE.json`. The API `/health`
and `/ready` responses report the same SHA. Deployment fails if the frontend and
API do not both report the selected release.

The private server ledger is stored outside the rsync-managed source at:

```text
/home/ubuntu/trovara-os/.release-history/current.json
/home/ubuntu/trovara-os/.release-history/history.jsonl
```

Override that location with `RELEASE_HISTORY_DIR` in `.env.deploy`. Do not put
the ledger in the public web root.

View recent successful releases from the deployment computer:

```bash
npm run release:history -- 20
```

## Before rolling back

1. Identify the current release:

   ```bash
   curl -fsS https://os.trovara.farm/RELEASE.json
   curl -fsS https://os.trovara.farm/health
   ```

2. Select an exact older SHA or release tag. Review its date and changes:

   ```bash
   git show --stat <sha-or-tag>
   ```

3. Run the compatibility check without changing production:

   ```bash
   ./rollback.sh <sha-or-tag> --dry-run
   ```

The command refuses an unverified live release, a non-ancestor target, and a
target that predates deployed migrations unless the relevant override is
explicitly supplied.

## Perform an application rollback

If no newer migrations are listed:

```bash
./rollback.sh <sha-or-tag> --confirm-rollback
```

If the target predates migrations, first review those migrations against
[`EXPAND-CONTRACT-MIGRATIONS.md`](./EXPAND-CONTRACT-MIGRATIONS.md). Only when the
old application is confirmed compatible with the current schema:

```bash
./rollback.sh <sha-or-tag> \
  --allow-forward-database \
  --confirm-rollback
```

`rollback.sh` calls `deploy.sh` with an immutable `RELEASE_REF`, marks the
operation as a rollback, and forces `--skip-migrate`. It still runs tests,
dependency audit, production build, encrypted backup, service restart, release
identity checks, and the normal off-server backup pull.

Do not use `--skip-backup` for a live rollback. The rollback command does not
offer that flag.

## Verification

The command verifies the public SHA after deployment. Also smoke-test the
affected user journey and inspect the private ledger:

```bash
ssh <production-host> \
  'tail -n 5 /home/ubuntu/trovara-os/.release-history/history.jsonl'

curl -fsS https://os.trovara.farm/health
curl -fsS https://os.trovara.farm/ready
curl -fsS https://os.trovara.farm/RELEASE.json
```

The three public responses must identify a healthy service and the selected
SHA. Review `journalctl -u trovara-api` and complete the release smoke tests.

## Database recovery is different

Application rollback never restores or downgrades PostgreSQL. Database/evidence
restore is an incident-recovery operation using a verified backup and the
procedure in [`backup-runbook.md`](./backup-runbook.md). `restore-db.sh` replaces
the live schema and can discard data written after the selected backup, so it
requires a maintenance window, an incident decision, and a fresh safety backup.

Older application releases may also be unable to read newer encrypted TOTP,
vault, evidence, or order data. Keep migrations expand-contract compatible for
the agreed rollback window, and retain required older environment variables
until that window closes.

## Release tags

Use human-readable annotated tags for production milestones while retaining the
SHA as the authoritative identity:

```bash
git tag -a os-v2026.08.15.1 <sha> -m "Trovara OS production release 2026.08.15.1"
git push origin os-v2026.08.15.1
RELEASE_REF=os-v2026.08.15.1 ./deploy.sh
```

Tag creation remains an explicit release-manager action; deployment does not
silently create or push Git tags.
