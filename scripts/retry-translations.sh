#!/usr/bin/env bash
# Retranslates rows still holding the author's own words because the LLM was
# unavailable on write. Run via cron, e.g. every 15 minutes:
#   */15 * * * * cd /path/to/trovara-os && npm run retry-translations
#
# Unlike the alert/digest crons this job has no API endpoint: it talks to the
# database directly through the api workspace, so it needs DATABASE_URL rather
# than CRON_SECRET or an owner login.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

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

: "${DATABASE_URL:?Set DATABASE_URL in .env - this job connects to the database directly}"

# Extra flags pass straight through, e.g. bash scripts/retry-translations.sh --limit=50
npm run --silent retry-translations -w api -- "$@"
