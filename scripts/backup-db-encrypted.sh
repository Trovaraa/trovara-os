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
  echo "Missing .env at $ENV_FILE - copy from .env.example" >&2
  exit 1
fi

: "${BACKUP_GPG_PASSPHRASE:?Set BACKUP_GPG_PASSPHRASE in .env}"

if ! command -v gpg >/dev/null 2>&1; then
  echo "gpg is required for encrypted backups (install package: gnupg)" >&2
  exit 1
fi

BACKUP_DIR="${BACKUP_DIR:-$ROOT_DIR/backups}"
EVIDENCE_STORAGE_ROOT="${EVIDENCE_STORAGE_ROOT:-$ROOT_DIR/api/data/evidence}"
mkdir -p "$BACKUP_DIR"
mkdir -p "$EVIDENCE_STORAGE_ROOT"

shopt -s nullglob
before_candidates=("$BACKUP_DIR"/*.sql)
shopt -u nullglob

"$ROOT_DIR/scripts/backup-db.sh" >/dev/null

latest_sql=""
shopt -s nullglob
after_candidates=("$BACKUP_DIR"/*.sql)
shopt -u nullglob
for candidate in "${after_candidates[@]}"; do
  existed=0
  for previous in "${before_candidates[@]}"; do
    if [[ "$candidate" == "$previous" ]]; then
      existed=1
      break
    fi
  done
  if [[ "$existed" == "0" ]]; then
    latest_sql="$candidate"
    break
  fi
done
if [[ -z "$latest_sql" ]]; then
  echo "Could not detect freshly generated .sql backup file" >&2
  exit 1
fi

encrypted_file="${latest_sql}.gpg"
timestamp_base="${latest_sql%.sql}"
evidence_tar="${timestamp_base}.evidence.tar"
evidence_encrypted="${evidence_tar}.gpg"
encrypted_partial="${encrypted_file}.partial.$$"
evidence_encrypted_partial="${evidence_encrypted}.partial.$$"

cleanup_plaintext() {
  rm -f "$latest_sql" "$evidence_tar" "$encrypted_partial" "$evidence_encrypted_partial"
}
trap cleanup_plaintext EXIT

printf '%s' "$BACKUP_GPG_PASSPHRASE" | gpg --batch --yes --pinentry-mode loopback --passphrase-fd 0 \
  --symmetric \
  --cipher-algo AES256 \
  --output "$encrypted_partial" \
  "$latest_sql"

tar -C "$EVIDENCE_STORAGE_ROOT" -cf "$evidence_tar" .
printf '%s' "$BACKUP_GPG_PASSPHRASE" | gpg --batch --yes --pinentry-mode loopback --passphrase-fd 0 \
  --symmetric \
  --cipher-algo AES256 \
  --output "$evidence_encrypted_partial" \
  "$evidence_tar"

if [[ ! -s "$encrypted_partial" || ! -s "$evidence_encrypted_partial" ]]; then
  echo "Encrypted backup output is empty; refusing to publish it" >&2
  exit 1
fi

chmod 600 "$encrypted_partial" "$evidence_encrypted_partial" 2>/dev/null || true
mv "$encrypted_partial" "$encrypted_file"
mv "$evidence_encrypted_partial" "$evidence_encrypted"
rm -f "$latest_sql" "$evidence_tar"
trap - EXIT
echo "Encrypted database backup complete: $encrypted_file"
echo "Encrypted evidence backup complete: $evidence_encrypted"
