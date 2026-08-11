#!/usr/bin/env bash
# Restore a backup into an ephemeral PostgreSQL container only.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

if [[ -n "${RESTORE_TEST_DATABASE_URL:-}" ||
      -n "${RESTORE_TEST_PGHOST:-}" ||
      -n "${RESTORE_TEST_TARGET_DB:-}" ]]; then
  echo "External restore-test targets are refused; this script only uses an ephemeral container" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required for an isolated restore test" >&2
  exit 1
fi

BACKUP_DIR="${BACKUP_DIR:-$ROOT_DIR/backups}"
REPORT_DIR="${BACKUP_REPORT_DIR:-$BACKUP_DIR/reports}"
BACKUP_FILE="${1:-}"
if [[ -z "$BACKUP_FILE" ]]; then
  shopt -s nullglob
  candidates=("$BACKUP_DIR"/*.sql.gpg "$BACKUP_DIR"/*.sql)
  shopt -u nullglob
  if [[ "${#candidates[@]}" -eq 0 ]]; then
    echo "No database backup found in $BACKUP_DIR" >&2
    exit 1
  fi
  BACKUP_FILE="$(ls -1t "${candidates[@]}" | awk 'NR==1 {print $0}')"
elif [[ ! -f "$BACKUP_FILE" && -f "$BACKUP_DIR/$BACKUP_FILE" ]]; then
  BACKUP_FILE="$BACKUP_DIR/$BACKUP_FILE"
fi
if [[ ! -f "$BACKUP_FILE" ]]; then
  echo "Backup file not found: $BACKUP_FILE" >&2
  exit 1
fi

REQUIRE_EVIDENCE_BACKUP="${REQUIRE_EVIDENCE_BACKUP:-1}" \
  "$ROOT_DIR/scripts/verify-backup.sh" "$BACKUP_FILE"

container="trovara-restore-test-$$"
image="${RESTORE_TEST_POSTGRES_IMAGE:-postgres:16-alpine}"
test_database="trovara_restore_test"
test_user="trovara_restore_test"
test_password="restore-test-$$-$(date +%s)"
temp_sql=""

cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  if [[ -n "$temp_sql" ]]; then
    rm -f "$temp_sql"
  fi
}
trap cleanup EXIT

if [[ "$BACKUP_FILE" == *.sql.gpg ]]; then
  : "${BACKUP_GPG_PASSPHRASE:=${GPG_PASSPHRASE:-}}"
  if [[ -z "$BACKUP_GPG_PASSPHRASE" ]]; then
    echo "Set BACKUP_GPG_PASSPHRASE or GPG_PASSPHRASE for encrypted restore testing" >&2
    exit 1
  fi
  temp_sql="$(mktemp "${TMPDIR:-/tmp}/trovara-restore-test.XXXXXX.sql")"
  printf '%s' "$BACKUP_GPG_PASSPHRASE" |
    gpg --batch --yes --pinentry-mode loopback --passphrase-fd 0 \
      --decrypt --output "$temp_sql" "$BACKUP_FILE"
  sql_file="$temp_sql"
elif [[ "$BACKUP_FILE" == *.sql ]]; then
  sql_file="$BACKUP_FILE"
else
  echo "Expected a .sql or .sql.gpg backup file" >&2
  exit 1
fi

docker run --detach --rm --name "$container" \
  --network none \
  --tmpfs /var/lib/postgresql/data:rw,noexec,nosuid,size=2g \
  --label "com.trovara.purpose=isolated-restore-test" \
  --label "com.trovara.production-target=forbidden" \
  --env "POSTGRES_USER=$test_user" \
  --env "POSTGRES_PASSWORD=$test_password" \
  --env "POSTGRES_DB=$test_database" \
  "$image" >/dev/null

network_mode="$(docker inspect --format '{{.HostConfig.NetworkMode}}' "$container")"
mount_count="$(docker inspect --format '{{len .Mounts}}' "$container")"
if [[ "$network_mode" != "none" || "$mount_count" != "0" ]]; then
  echo "Restore isolation invariant failed: network=$network_mode mounts=$mount_count" >&2
  exit 1
fi

ready=0
for _ in {1..30}; do
  if docker exec "$container" pg_isready --username "$test_user" --dbname "$test_database" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [[ "$ready" != "1" ]]; then
  echo "Isolated PostgreSQL did not become ready" >&2
  exit 1
fi

docker exec -i "$container" psql \
  --username "$test_user" \
  --dbname "$test_database" \
  -v ON_ERROR_STOP=1 < "$sql_file" >/dev/null

table_count="$(docker exec "$container" psql \
  --username "$test_user" \
  --dbname "$test_database" \
  --tuples-only --no-align \
  -c "SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname = 'public';")"
if [[ ! "$table_count" =~ ^[1-9][0-9]*$ ]]; then
  echo "Restore test failed: restored database has no public tables" >&2
  exit 1
fi

critical_tables="$(docker exec "$container" psql \
  --username "$test_user" --dbname "$test_database" --tuples-only --no-align \
  -c "SELECT count(*) FROM (VALUES ('farms'), ('users'), ('audit_events')) AS required(name)
      WHERE to_regclass('public.' || required.name) IS NOT NULL;")"
if [[ "$critical_tables" != "3" ]]; then
  echo "Restore test failed: one or more critical tables are missing" >&2
  exit 1
fi

expected_migrations="$(
  shopt -s nullglob
  migration_files=("$ROOT_DIR"/api/drizzle/*/migration.sql)
  echo "${#migration_files[@]}"
)"
restored_migrations="$(docker exec "$container" psql \
  --username "$test_user" --dbname "$test_database" --tuples-only --no-align \
  -c "SELECT count(*) FROM drizzle.__drizzle_migrations;")"
if [[ "$restored_migrations" != "$expected_migrations" ]]; then
  echo "Restore test failed: migration journal has $restored_migrations entries; expected $expected_migrations" >&2
  exit 1
fi

farm_count="$(docker exec "$container" psql \
  --username "$test_user" --dbname "$test_database" --tuples-only --no-align \
  -c "SELECT count(*) FROM farms;")"
if [[ "${RESTORE_TEST_REQUIRE_DATA:-1}" == "1" &&
      ! "$farm_count" =~ ^[1-9][0-9]*$ ]]; then
  echo "Restore test failed: production backup contains no farm rows" >&2
  exit 1
fi

mkdir -p "$REPORT_DIR"
chmod 700 "$REPORT_DIR" 2>/dev/null || true
report="$REPORT_DIR/latest-restore-test.json"
report_partial="${report}.partial.$$"
completed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
backup_name="$(basename "$BACKUP_FILE")"
printf '%s\n' \
  '{' \
  '  "schemaVersion": 1,' \
  '  "status": "success",' \
  "  \"completedAt\": \"$completed_at\"," \
  "  \"backup\": \"$backup_name\"," \
  "  \"publicTableCount\": $table_count," \
  "  \"migrationCount\": $restored_migrations," \
  "  \"farmCount\": $farm_count," \
  '  "networkMode": "none",' \
  '  "mountCount": 0,' \
  '  "target": "ephemeral-container"' \
  '}' > "$report_partial"
chmod 600 "$report_partial" 2>/dev/null || true
mv "$report_partial" "$report"

echo "Isolated restore test passed: $table_count public tables restored"
