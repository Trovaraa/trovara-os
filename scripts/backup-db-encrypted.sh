#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
else
  echo "Missing .env at $ENV_FILE — copy from .env.example" >&2
  exit 1
fi

: "${BACKUP_GPG_PASSPHRASE:?Set BACKUP_GPG_PASSPHRASE in .env}"

BACKUP_DIR="${BACKUP_DIR:-$ROOT_DIR/backups}"
mkdir -p "$BACKUP_DIR"

before_latest="$(ls -1t "$BACKUP_DIR"/*.sql 2>/dev/null | awk 'NR==1 {print $0}')"

"$ROOT_DIR/scripts/backup-db.sh" >/dev/null

latest_sql="$(ls -1t "$BACKUP_DIR"/*.sql 2>/dev/null | awk 'NR==1 {print $0}')"
if [[ -z "$latest_sql" || "$latest_sql" == "$before_latest" ]]; then
  echo "Could not detect freshly generated .sql backup file" >&2
  exit 1
fi

encrypted_file="${latest_sql}.gpg"

echo "$BACKUP_GPG_PASSPHRASE" | gpg --batch --yes --pinentry-mode loopback --passphrase-fd 0 \
  --symmetric \
  --cipher-algo AES256 \
  --output "$encrypted_file" \
  "$latest_sql"

rm -f "$latest_sql"
echo "Encrypted backup complete: $encrypted_file"
