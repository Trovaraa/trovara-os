#!/usr/bin/env bash
# Generate tasks from due recurring schedules. Run via cron, e.g. daily at 05:00:
#   0 5 * * * cd /path/to/trovara-os && npm run generate-tasks
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
OWNER_PASSWORD="${CRON_OWNER_PASSWORD:-$SEED_OWNER_PASSWORD}"

if [ -n "${CRON_SECRET:-}" ]; then
  echo "generate-recurring-tasks requires owner session login (no CRON endpoint yet)" >&2
  exit 1
fi

if [ -z "$OWNER_PASSWORD" ]; then
  echo "Set CRON_OWNER_PASSWORD or SEED_OWNER_PASSWORD in .env" >&2
  exit 1
fi

COOKIE_JAR=$(mktemp)
trap 'rm -f "$COOKIE_JAR"' EXIT

curl -sf -c "$COOKIE_JAR" -b "$COOKIE_JAR" -X POST "$API_URL/auth/login" \
  -H 'Content-Type: application/json' \
  -d @- <<EOF > /dev/null
{"email":"$OWNER_EMAIL","password":"$OWNER_PASSWORD"}
EOF

CSRF=$(grep trovara_csrf "$COOKIE_JAR" | awk '{print $NF}')

curl -sf -b "$COOKIE_JAR" -X POST "$API_URL/api/templates/generate-tasks" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: $CSRF" \
  -d '{}' | cat

echo
