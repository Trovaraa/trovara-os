#!/usr/bin/env bash
# Verify a PostgreSQL backup (.sql or .sql.gpg) without restoring it.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

BACKUP_DIR="${BACKUP_DIR:-$ROOT_DIR/backups}"
BACKUP_FILE="${1:-}"

if [[ -z "$BACKUP_FILE" ]]; then
  shopt -s nullglob
  BACKUP_CANDIDATES=("$BACKUP_DIR"/*.sql "$BACKUP_DIR"/*.sql.gpg)
  shopt -u nullglob
  if [[ "${#BACKUP_CANDIDATES[@]}" -eq 0 ]]; then
    echo "No backup files found in $BACKUP_DIR" >&2
    exit 1
  fi
  BACKUP_FILE="$(ls -1t "${BACKUP_CANDIDATES[@]}" | awk 'NR==1 {print $0}')"
  echo "Using latest backup: $BACKUP_FILE"
elif [[ ! -f "$BACKUP_FILE" && -f "$BACKUP_DIR/$BACKUP_FILE" ]]; then
  BACKUP_FILE="$BACKUP_DIR/$BACKUP_FILE"
fi

if [[ ! -f "$BACKUP_FILE" ]]; then
  echo "Backup file not found: $BACKUP_FILE" >&2
  exit 1
fi

if [[ "$BACKUP_FILE" == *.sql.gpg ]]; then
  BACKUP_BASE="${BACKUP_FILE%.sql.gpg}"
else
  BACKUP_BASE="${BACKUP_FILE%.sql}"
fi
CHECKSUM_MANIFEST="${BACKUP_BASE}.manifest.sha256"
if [[ -f "$CHECKSUM_MANIFEST" ]]; then
  manifest_dir="$(cd "$(dirname "$CHECKSUM_MANIFEST")" && pwd)"
  manifest_name="$(basename "$CHECKSUM_MANIFEST")"
  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$manifest_dir" && sha256sum -c "$manifest_name")
  elif command -v shasum >/dev/null 2>&1; then
    (cd "$manifest_dir" && shasum -a 256 -c "$manifest_name")
  else
    echo "FAIL: sha256sum or shasum is required to validate $CHECKSUM_MANIFEST" >&2
    exit 1
  fi
  echo "OK: checksum manifest"
fi

resolve_gpg_passphrase() {
  if [[ -n "${BACKUP_GPG_PASSPHRASE:-}" ]]; then
    printf '%s' "$BACKUP_GPG_PASSPHRASE"
    return
  fi
  if [[ -n "${GPG_PASSPHRASE:-}" ]]; then
    printf '%s' "$GPG_PASSPHRASE"
    return
  fi
  echo "Set BACKUP_GPG_PASSPHRASE or GPG_PASSPHRASE in .env to verify .sql.gpg backups" >&2
  exit 1
}

verify_sql_file() {
  local file="$1"
  if [[ ! -s "$file" ]]; then
    echo "FAIL: backup is empty" >&2
    return 1
  fi
  if ! grep -q '^-- PostgreSQL database dump' "$file"; then
    echo "FAIL: missing pg_dump header" >&2
    return 1
  fi
  if ! grep -q 'CREATE TABLE' "$file"; then
    echo "FAIL: no CREATE TABLE statements found" >&2
    return 1
  fi
  local size
  size="$(wc -c < "$file" | tr -d ' ')"
  echo "OK: valid SQL dump ($size bytes)"
}

TEMP_SQL=""
TEMP_EVIDENCE=""
cleanup() {
  if [[ -n "$TEMP_SQL" && -f "$TEMP_SQL" ]]; then
    rm -f "$TEMP_SQL"
  fi
  if [[ -n "$TEMP_EVIDENCE" && -f "$TEMP_EVIDENCE" ]]; then
    rm -f "$TEMP_EVIDENCE"
  fi
}
trap cleanup EXIT

if [[ "$BACKUP_FILE" == *.sql.gpg ]]; then
  GPG_PASS="$(resolve_gpg_passphrase)"
  TEMP_SQL="$(mktemp "${TMPDIR:-/tmp}/trovara-verify.XXXXXX.sql")"
  printf '%s' "$GPG_PASS" | gpg --batch --yes --pinentry-mode loopback --passphrase-fd 0 \
    --decrypt --output "$TEMP_SQL" "$BACKUP_FILE"
  verify_sql_file "$TEMP_SQL"
elif [[ "$BACKUP_FILE" == *.sql ]]; then
  verify_sql_file "$BACKUP_FILE"
else
  echo "Expected a .sql or .sql.gpg backup file" >&2
  exit 1
fi

EVIDENCE_BACKUP="${BACKUP_BASE}.evidence.tar.gpg"

if [[ -f "$EVIDENCE_BACKUP" ]]; then
  GPG_PASS="$(resolve_gpg_passphrase)"
  TEMP_EVIDENCE="$(mktemp "${TMPDIR:-/tmp}/trovara-evidence-verify.XXXXXX.tar")"
  printf '%s' "$GPG_PASS" | gpg --batch --yes --pinentry-mode loopback --passphrase-fd 0 \
    --decrypt --output "$TEMP_EVIDENCE" "$EVIDENCE_BACKUP"
  tar -tf "$TEMP_EVIDENCE" >/dev/null
  echo "OK: valid evidence archive ($(wc -c < "$TEMP_EVIDENCE" | tr -d ' ') bytes)"
elif [[ "${REQUIRE_EVIDENCE_BACKUP:-0}" == "1" ]]; then
  echo "FAIL: matching evidence backup not found: $EVIDENCE_BACKUP" >&2
  exit 1
else
  echo "WARNING: matching evidence backup not found: $EVIDENCE_BACKUP" >&2
fi

echo "Verified: $BACKUP_FILE"
