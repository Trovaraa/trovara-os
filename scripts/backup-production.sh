#!/usr/bin/env bash
# Create, verify, describe, and optionally deliver an encrypted production backup.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
else
  echo "Missing environment file: $ENV_FILE" >&2
  exit 1
fi

BACKUP_DIR="${BACKUP_DIR:-$ROOT_DIR/backups}"
REPORT_DIR="${BACKUP_REPORT_DIR:-$BACKUP_DIR/reports}"
REMOTE_ENABLED="${BACKUP_REMOTE_ENABLED:-0}"
REMOTE_REQUIRED="${BACKUP_REMOTE_REQUIRED:-0}"
RCLONE_DESTINATION="${BACKUP_RCLONE_DESTINATION:-}"
LOCK_DIR="$BACKUP_DIR/.production-backup.lock"

if [[ "$REMOTE_REQUIRED" == "1" ]]; then
  REMOTE_ENABLED=1
fi

mkdir -p "$BACKUP_DIR" "$REPORT_DIR"
chmod 700 "$BACKUP_DIR" "$REPORT_DIR" 2>/dev/null || true
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "Another production backup appears to be running: $LOCK_DIR" >&2
  exit 1
fi

cleanup() {
  rm -rf "$LOCK_DIR"
}
trap cleanup EXIT

shopt -s nullglob
before_candidates=("$BACKUP_DIR"/*.sql.gpg)
shopt -u nullglob

"$ROOT_DIR/scripts/backup-db-encrypted.sh"

shopt -s nullglob
after_candidates=("$BACKUP_DIR"/*.sql.gpg)
shopt -u nullglob
if [[ "${#after_candidates[@]}" -eq 0 ]]; then
  echo "Encrypted backup did not produce a database artifact" >&2
  exit 1
fi
database_backup=""
for candidate in "${after_candidates[@]}"; do
  existed=0
  for previous in "${before_candidates[@]}"; do
    if [[ "$candidate" == "$previous" ]]; then
      existed=1
      break
    fi
  done
  if [[ "$existed" == "0" ]]; then
    database_backup="$candidate"
    break
  fi
done
if [[ -z "$database_backup" ]]; then
  echo "Encrypted backup did not produce a new database artifact" >&2
  exit 1
fi

backup_base="${database_backup%.sql.gpg}"
evidence_backup="${backup_base}.evidence.tar.gpg"
if [[ ! -s "$evidence_backup" ]]; then
  echo "Matching encrypted evidence artifact is missing or empty" >&2
  exit 1
fi

REQUIRE_EVIDENCE_BACKUP=1 "$ROOT_DIR/scripts/verify-backup.sh" "$database_backup"

database_name="$(basename "$database_backup")"
evidence_name="$(basename "$evidence_backup")"
manifest="${backup_base}.manifest.sha256"
manifest_name="$(basename "$manifest")"
for name in "$database_name" "$evidence_name" "$manifest_name"; do
  if [[ ! "$name" =~ ^[A-Za-z0-9._-]+$ ]]; then
    echo "Unsafe backup artifact name: $name" >&2
    exit 1
  fi
done

if command -v sha256sum >/dev/null 2>&1; then
  database_sha="$(sha256sum "$database_backup" | awk '{print $1}')"
  evidence_sha="$(sha256sum "$evidence_backup" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
  database_sha="$(shasum -a 256 "$database_backup" | awk '{print $1}')"
  evidence_sha="$(shasum -a 256 "$evidence_backup" | awk '{print $1}')"
else
  echo "sha256sum or shasum is required" >&2
  exit 1
fi

manifest_partial="${manifest}.partial.$$"
printf '%s  %s\n%s  %s\n' \
  "$database_sha" "$database_name" \
  "$evidence_sha" "$evidence_name" > "$manifest_partial"
chmod 600 "$manifest_partial" 2>/dev/null || true
mv "$manifest_partial" "$manifest"

remote_status="disabled"
if [[ "$REMOTE_ENABLED" == "1" ]]; then
  if [[ -z "$RCLONE_DESTINATION" ]]; then
    echo "BACKUP_RCLONE_DESTINATION is required when remote delivery is enabled" >&2
    exit 1
  fi
  if ! command -v rclone >/dev/null 2>&1; then
    echo "rclone is required when remote delivery is enabled" >&2
    exit 1
  fi

  remote_status="delivered"
  remote_prefix="${RCLONE_DESTINATION%/}"
  for artifact in "$database_backup" "$evidence_backup" "$manifest"; do
    artifact_name="$(basename "$artifact")"
    partial_remote="$remote_prefix/.partial-${artifact_name}-$$"
    final_remote="$remote_prefix/$artifact_name"
    if ! rclone copyto "$artifact" "$partial_remote" --no-traverse ||
       ! rclone moveto "$partial_remote" "$final_remote" --no-traverse; then
      rclone deletefile "$partial_remote" >/dev/null 2>&1 || true
      echo "Off-server delivery failed for $artifact_name" >&2
      exit 1
    fi
  done
fi

completed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
report="$REPORT_DIR/latest-backup.json"
report_partial="${report}.partial.$$"
remote_enabled_json=false
if [[ "$REMOTE_ENABLED" == "1" ]]; then
  remote_enabled_json=true
fi
printf '%s\n' \
  '{' \
  '  "schemaVersion": 1,' \
  '  "status": "success",' \
  "  \"completedAt\": \"$completed_at\"," \
  "  \"databaseBackup\": \"$database_name\"," \
  "  \"evidenceBackup\": \"$evidence_name\"," \
  "  \"manifest\": \"$manifest_name\"," \
  "  \"remoteDelivery\": { \"enabled\": $remote_enabled_json, \"status\": \"$remote_status\" }" \
  '}' > "$report_partial"
chmod 600 "$report_partial" 2>/dev/null || true
mv "$report_partial" "$report"

echo "Production backup complete: $database_name"
echo "Evidence backup complete: $evidence_name"
echo "Checksum manifest complete: $manifest_name"
echo "Remote delivery: $remote_status"
