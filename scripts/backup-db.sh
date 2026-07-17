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

: "${POSTGRES_USER:?Set POSTGRES_USER in .env}"
: "${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD in .env}"
: "${POSTGRES_DB:?Set POSTGRES_DB in .env}"

BACKUP_DIR="${BACKUP_DIR:-$ROOT_DIR/backups}"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
OUTPUT_FILE="$BACKUP_DIR/${POSTGRES_DB}_${TIMESTAMP}.sql"
if [[ -e "$OUTPUT_FILE" ]]; then
  OUTPUT_FILE="$BACKUP_DIR/${POSTGRES_DB}_${TIMESTAMP}_$$.sql"
fi
PARTIAL_FILE="${OUTPUT_FILE}.partial.$$"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR" 2>/dev/null || true

PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-5432}"

export PGPASSWORD="$POSTGRES_PASSWORD"

cleanup_partial() {
  rm -f "$PARTIAL_FILE"
}
trap cleanup_partial EXIT

echo "Backing up database '$POSTGRES_DB' to $OUTPUT_FILE"
if [[ "${USE_DOCKER_PG_TOOLS:-0}" == "1" ]]; then
  docker compose -f "$ROOT_DIR/docker-compose.yml" exec -T db \
    pg_dump \
    --username="$POSTGRES_USER" \
    --dbname="$POSTGRES_DB" \
    --no-owner \
    --no-acl > "$PARTIAL_FILE"
else
  PG_DUMP_BIN="${PG_DUMP_BIN:-pg_dump}"
  "$PG_DUMP_BIN" \
    --host="$PGHOST" \
    --port="$PGPORT" \
    --username="$POSTGRES_USER" \
    --dbname="$POSTGRES_DB" \
    --no-owner \
    --no-acl \
    --file="$PARTIAL_FILE"
fi

if [[ ! -s "$PARTIAL_FILE" ]]; then
  echo "Backup output is empty; refusing to publish it" >&2
  exit 1
fi

chmod 600 "$PARTIAL_FILE" 2>/dev/null || true
mv "$PARTIAL_FILE" "$OUTPUT_FILE"
trap - EXIT
echo "Backup complete: $OUTPUT_FILE"
