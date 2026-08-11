#!/usr/bin/env bash
# Runs the daily OS + marketing point-in-time health/uptime snapshot.
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
OWNER_PASSWORD="${CRON_OWNER_PASSWORD:-${BREAK_GLASS_PASSWORD:-$SEED_OWNER_PASSWORD}}"
FARM_ID="${CRON_FARM_ID:-}"

if [ -n "${CRON_SECRET:-}" ]; then
  if [ -z "$FARM_ID" ]; then
    echo "Set CRON_FARM_ID in .env when using CRON_SECRET" >&2
    exit 1
  fi
  curl -sf -X POST "$API_URL/api/alerts/run-health-sla" \
    -H "Content-Type: application/json" \
    -H "X-CRON-SECRET: $CRON_SECRET" \
    -d "$(jq -n --arg farmId "$FARM_ID" '{farmId: $farmId}')"
  echo
  exit 0
fi

if [ -z "$OWNER_PASSWORD" ]; then
  echo "Set CRON_OWNER_PASSWORD (or BREAK_GLASS_PASSWORD) or CRON_SECRET in .env" >&2
  exit 1
fi

COOKIE_JAR=$(mktemp)
trap 'rm -f "$COOKIE_JAR"' EXIT

curl -sf -c "$COOKIE_JAR" -b "$COOKIE_JAR" -X POST "$API_URL/auth/login" \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --arg email "$OWNER_EMAIL" --arg password "$OWNER_PASSWORD" '{email: $email, password: $password}')" \
  > /dev/null

CSRF=$(grep trovara_csrf "$COOKIE_JAR" | awk '{print $NF}')

curl -sf -b "$COOKIE_JAR" -X POST "$API_URL/api/alerts/run-health-sla" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: $CSRF" \
  -d '{}'

echo
