#!/usr/bin/env bash
# Restore a PostgreSQL backup (.sql or .sql.gpg). Drops and recreates public schema.
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

: "${POSTGRES_USER:?Set POSTGRES_USER in .env}"
: "${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD in .env}"
: "${POSTGRES_DB:?Set POSTGRES_DB in .env}"

BACKUP_FILE="${1:-}"
if [[ -z "$BACKUP_FILE" ]]; then
  echo "Usage: $0 <backup.sql|backup.sql.gpg>" >&2
  echo "  Latest backup: ls -1t ${BACKUP_DIR:-$ROOT_DIR/backups}/*.{sql,sql.gpg} 2>/dev/null | head -1" >&2
  exit 1
fi

BACKUP_DIR="${BACKUP_DIR:-$ROOT_DIR/backups}"
EVIDENCE_STORAGE_ROOT="${EVIDENCE_STORAGE_ROOT:-$ROOT_DIR/api/data/evidence}"
if [[ ! -f "$BACKUP_FILE" && -f "$BACKUP_DIR/$BACKUP_FILE" ]]; then
  BACKUP_FILE="$BACKUP_DIR/$BACKUP_FILE"
fi

if [[ ! -f "$BACKUP_FILE" ]]; then
  echo "Backup file not found: $BACKUP_FILE" >&2
  exit 1
fi

PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-5432}"
export PGPASSWORD="$POSTGRES_PASSWORD"

SQL_FILE=""
TEMP_SQL=""
TEMP_EVIDENCE=""

resolve_gpg_passphrase() {
  if [[ -n "${BACKUP_GPG_PASSPHRASE:-}" ]]; then
    printf '%s' "$BACKUP_GPG_PASSPHRASE"
    return
  fi
  if [[ -n "${GPG_PASSPHRASE:-}" ]]; then
    printf '%s' "$GPG_PASSPHRASE"
    return
  fi
  echo "Set BACKUP_GPG_PASSPHRASE or GPG_PASSPHRASE in .env for .sql.gpg restore" >&2
  exit 1
}

if [[ "$BACKUP_FILE" == *.sql.gpg ]]; then
  TEMP_SQL="$(mktemp "${TMPDIR:-/tmp}/trovara-restore.XXXXXX.sql")"
  SQL_FILE="$TEMP_SQL"
  GPG_PASS="$(resolve_gpg_passphrase)"
  echo "Decrypting $BACKUP_FILE ..."
  printf '%s' "$GPG_PASS" | gpg --batch --yes --pinentry-mode loopback --passphrase-fd 0 \
    --decrypt --output "$SQL_FILE" "$BACKUP_FILE"
elif [[ "$BACKUP_FILE" == *.sql ]]; then
  SQL_FILE="$BACKUP_FILE"
else
  echo "Expected a .sql or .sql.gpg backup file" >&2
  exit 1
fi

if [[ "$BACKUP_FILE" == *.sql.gpg ]]; then
  BACKUP_BASE="${BACKUP_FILE%.sql.gpg}"
else
  BACKUP_BASE="${BACKUP_FILE%.sql}"
fi
EVIDENCE_BACKUP="${BACKUP_BASE}.evidence.tar.gpg"

if [[ -f "$EVIDENCE_BACKUP" ]]; then
  TEMP_EVIDENCE="$(mktemp "${TMPDIR:-/tmp}/trovara-evidence-restore.XXXXXX.tar")"
  GPG_PASS="$(resolve_gpg_passphrase)"
  echo "Decrypting $EVIDENCE_BACKUP ..."
  printf '%s' "$GPG_PASS" | gpg --batch --yes --pinentry-mode loopback --passphrase-fd 0 \
    --decrypt --output "$TEMP_EVIDENCE" "$EVIDENCE_BACKUP"
  tar -tf "$TEMP_EVIDENCE" >/dev/null
elif [[ "${REQUIRE_EVIDENCE_BACKUP:-0}" == "1" ]]; then
  echo "Matching evidence backup not found: $EVIDENCE_BACKUP" >&2
  exit 1
else
  echo "WARNING: matching evidence backup not found; database-only restore will continue." >&2
fi

cleanup() {
  if [[ -n "$TEMP_SQL" && -f "$TEMP_SQL" ]]; then
    rm -f "$TEMP_SQL"
  fi
  if [[ -n "$TEMP_EVIDENCE" && -f "$TEMP_EVIDENCE" ]]; then
    rm -f "$TEMP_EVIDENCE"
  fi
}
trap cleanup EXIT

if [[ ! -s "$SQL_FILE" ]]; then
  echo "Backup SQL is empty after decrypt/read" >&2
  exit 1
fi

if ! grep -q '^-- PostgreSQL database dump' "$SQL_FILE"; then
  echo "File does not look like a pg_dump SQL backup" >&2
  exit 1
fi

if [[ "${FORCE_RESTORE:-}" != "1" ]]; then
  echo "WARNING: This drops and recreates the public schema. All current data is lost."
  read -r -p "Type RESTORE to continue: " confirm
  if [[ "$confirm" != "RESTORE" ]]; then
    echo "Aborted." >&2
    exit 1
  fi
fi

echo "Restoring database '$POSTGRES_DB' from $BACKUP_FILE ..."
psql \
  --host="$PGHOST" \
  --port="$PGPORT" \
  --username="$POSTGRES_USER" \
  --dbname="$POSTGRES_DB" \
  -v ON_ERROR_STOP=1 \
  -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"

psql \
  --host="$PGHOST" \
  --port="$PGPORT" \
  --username="$POSTGRES_USER" \
  --dbname="$POSTGRES_DB" \
  -v ON_ERROR_STOP=1 \
  --file="$SQL_FILE"

if [[ -n "$TEMP_EVIDENCE" ]]; then
  if [[ -z "$EVIDENCE_STORAGE_ROOT" || "$EVIDENCE_STORAGE_ROOT" == "/" ]]; then
    echo "Unsafe EVIDENCE_STORAGE_ROOT: '$EVIDENCE_STORAGE_ROOT'" >&2
    exit 1
  fi

  previous_evidence="${EVIDENCE_STORAGE_ROOT}.pre-restore.$(date +%s)"
  mkdir -p "$(dirname "$EVIDENCE_STORAGE_ROOT")"
  if [[ -e "$EVIDENCE_STORAGE_ROOT" ]]; then
    mv "$EVIDENCE_STORAGE_ROOT" "$previous_evidence"
  fi
  mkdir -p "$EVIDENCE_STORAGE_ROOT"

  if ! tar -C "$EVIDENCE_STORAGE_ROOT" -xf "$TEMP_EVIDENCE"; then
    rm -rf "$EVIDENCE_STORAGE_ROOT"
    if [[ -e "$previous_evidence" ]]; then
      mv "$previous_evidence" "$EVIDENCE_STORAGE_ROOT"
    fi
    echo "Evidence restore failed; previous evidence directory restored." >&2
    exit 1
  fi
  rm -rf "$previous_evidence"
  echo "Evidence restore complete: $EVIDENCE_STORAGE_ROOT"
fi

echo "Restore complete."
