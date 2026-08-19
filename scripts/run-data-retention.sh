#!/usr/bin/env bash
# Purges task photo/voice evidence older than DATA_RETENTION_DAYS (default 365).
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

API_URL="${API_URL:-http://127.0.0.1:3000}"
OWNER_EMAIL="${CRON_OWNER_EMAIL:-owner@trovara.farm}"
OWNER_PASSWORD="${CRON_OWNER_PASSWORD:-}"
FARM_ID="${CRON_FARM_ID:-}"

if [ -n "${CRON_SECRET:-}" ]; then
  if [ -z "$FARM_ID" ]; then
    echo "Set CRON_FARM_ID in .env when using CRON_SECRET" >&2
    exit 1
  fi
  curl -sf -X POST "$API_URL/api/system/run-retention" \
    -H "Content-Type: application/json" \
    -H "X-CRON-SECRET: $CRON_SECRET" \
    -d "$(jq -n --arg farmId "$FARM_ID" '{farmId: $farmId}')"
  echo
  exit 0
fi

if [ -z "$OWNER_PASSWORD" ]; then
  echo "Set CRON_SECRET+CRON_FARM_ID or CRON_OWNER_PASSWORD in .env" >&2
  exit 1
fi

PAYLOAD='{}'
if [ -n "$FARM_ID" ]; then
  PAYLOAD="$(jq -n --arg farmId "$FARM_ID" '{farmId: $farmId}')"
fi

COOKIE_JAR=$(mktemp)
trap 'rm -f "$COOKIE_JAR"' EXIT

curl -sf -c "$COOKIE_JAR" -b "$COOKIE_JAR" -X POST "$API_URL/auth/login" \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --arg email "$OWNER_EMAIL" --arg password "$OWNER_PASSWORD" '{email: $email, password: $password}')" \
  > /dev/null

CSRF=$(grep trovara_csrf "$COOKIE_JAR" | awk '{print $NF}')

curl -sf -b "$COOKIE_JAR" -X POST "$API_URL/api/system/run-retention" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: $CSRF" \
  -d "$PAYLOAD"

echo
