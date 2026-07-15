#!/usr/bin/env bash
#
# Deploy the local trovara-os/ folder to the production VM.
#
# What it does (safe + idempotent):
#   1. rsync the source tree to the VM  (NEVER overwrites prod .env, node_modules, or builds)
#   2. on the VM: npm install → db:migrate → build (with VITE_* set) → [sync-catalog]
#   3. rsync the built frontend into the nginx web root
#   4. restart the systemd API service
#   5. health-check the API
#
# Usage:
#   ./deploy.sh                 # full deploy (install, migrate, build, restart)
#   ./deploy.sh --catalog       # also run sync-catalog (when farm-knowledge changed)
#   ./deploy.sh --skip-install  # skip npm install (no lockfile change)
#   ./deploy.sh --skip-migrate  # skip db:migrate (no new migrations)
#
# Config: create a gitignored .env.deploy next to this script:
#   VM_HOST=ubuntu@your.vm.ip            # required (ssh target or ~/.ssh/config alias)
#   SSH_PORT=22                          # optional (e.g. 22022)
#   SSH_KEY=/path/to/private_key         # optional (ssh -i identity file)
#   REMOTE_DIR=/home/ubuntu/trovara-os   # optional (default shown)
#   WEB_ROOT=/home/trovara-os/htdocs/os.trovara.farm  # optional
#   SERVICE=trovara-api                  # optional
#   VITE_API_URL=https://os.trovara.farm # optional
#   VITE_PUBLIC_APP_URL=https://os.trovara.farm  # optional

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# --- Load config -------------------------------------------------------------
if [[ -f "$SCRIPT_DIR/.env.deploy" ]]; then
  # shellcheck disable=SC1091
  set -a; source "$SCRIPT_DIR/.env.deploy"; set +a
fi

REMOTE_DIR="${REMOTE_DIR:-/home/ubuntu/trovara-os}"
WEB_ROOT="${WEB_ROOT:-/home/trovara-os/htdocs/os.trovara.farm}"
SERVICE="${SERVICE:-trovara-api}"
VITE_API_URL="${VITE_API_URL:-https://os.trovara.farm}"
VITE_PUBLIC_APP_URL="${VITE_PUBLIC_APP_URL:-https://os.trovara.farm}"
SSH_PORT="${SSH_PORT:-22}"
SSH_KEY="${SSH_KEY:-}"

if [[ -z "${VM_HOST:-}" ]]; then
  cat >&2 <<'MSG'
ERROR: VM_HOST is not set.

Create a gitignored .env.deploy next to deploy.sh, e.g.:

  VM_HOST=ubuntu@203.0.113.10
  # REMOTE_DIR=/home/ubuntu/trovara-os
  # WEB_ROOT=/home/trovara-os/htdocs/os.trovara.farm
  # SERVICE=trovara-api
  # VITE_API_URL=https://os.trovara.farm
  # VITE_PUBLIC_APP_URL=https://os.trovara.farm

...or run once inline:  VM_HOST=ubuntu@your.vm.ip ./deploy.sh
MSG
  exit 1
fi

# --- Flags -------------------------------------------------------------------
RUN_CATALOG=0
SKIP_INSTALL=0
SKIP_MIGRATE=0
for arg in "$@"; do
  case "$arg" in
    --catalog) RUN_CATALOG=1 ;;
    --skip-install) SKIP_INSTALL=1 ;;
    --skip-migrate) SKIP_MIGRATE=1 ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

SSH="ssh -p $SSH_PORT"
SCP="scp -P $SSH_PORT"
if [[ -n "$SSH_KEY" ]]; then
  SSH_KEY="${SSH_KEY/#\~/$HOME}"
  if [[ ! -f "$SSH_KEY" ]]; then
    echo "ERROR: SSH_KEY not found: $SSH_KEY" >&2
    exit 1
  fi
  SSH="$SSH -i $SSH_KEY"
  SCP="$SCP -i $SSH_KEY"
fi

echo "==> Deploying to $VM_HOST:$REMOTE_DIR"

# --- 1. Sync source (excludes protect prod state) ----------------------------
echo "==> Syncing source (prod .env is never touched)…"
rsync -az --delete \
  -e "$SSH" \
  --exclude '.git/' \
  --exclude 'node_modules/' \
  --exclude '**/node_modules/' \
  --exclude 'dist/' \
  --exclude '**/dist/' \
  --exclude '.env' \
  --exclude '.env.*' \
  --exclude '*.tsbuildinfo' \
  --exclude 'backups/' \
  --exclude 'uploads/' \
  --exclude 'logs/' \
  --exclude '*.log' \
  --exclude '.DS_Store' \
  "$SCRIPT_DIR/" "$VM_HOST:$REMOTE_DIR/"

# --- 2-4. Remote build + release --------------------------------------------
# Generate the remote runner, copy it over, then execute with a TTY so sudo can
# prompt if the VM requires a password.
REMOTE_RUNNER="$(mktemp -t trovara-deploy.XXXXXX.sh)"
trap 'rm -f "$REMOTE_RUNNER"' EXIT

cat >"$REMOTE_RUNNER" <<REMOTE
#!/usr/bin/env bash
set -euo pipefail
cd "$REMOTE_DIR"

echo "==> [vm] node \$(node -v)"

if [[ "$SKIP_INSTALL" -eq 0 ]]; then
  echo "==> [vm] npm install"
  npm install
else
  echo "==> [vm] skipping npm install"
fi

if [[ "$SKIP_MIGRATE" -eq 0 ]]; then
  echo "==> [vm] db:migrate"
  npm run db:migrate
else
  echo "==> [vm] skipping db:migrate"
fi

echo "==> [vm] build frontend (VITE_API_URL=$VITE_API_URL)"
VITE_API_URL="$VITE_API_URL" VITE_PUBLIC_APP_URL="$VITE_PUBLIC_APP_URL" npm run build

if [[ "$RUN_CATALOG" -eq 1 ]]; then
  echo "==> [vm] sync-catalog"
  npm run sync-catalog -w api
fi

echo "==> [vm] releasing frontend to $WEB_ROOT"
sudo rsync -a --delete "$REMOTE_DIR/app/dist/" "$WEB_ROOT/"

echo "==> [vm] restarting $SERVICE"
sudo systemctl restart "$SERVICE"

echo "==> [vm] health check"
sleep 2
curl -fsS http://127.0.0.1:3000/health && echo "  OK" || { echo "  API health check FAILED"; exit 1; }
REMOTE

$SCP -q "$REMOTE_RUNNER" "$VM_HOST:/tmp/trovara-deploy-remote.sh"
$SSH -t "$VM_HOST" 'bash /tmp/trovara-deploy-remote.sh; rc=$?; rm -f /tmp/trovara-deploy-remote.sh; exit $rc'

echo ""
echo "==> Done. Live at $VITE_PUBLIC_APP_URL"
echo "    (If the browser shows an old build, hard-refresh / clear the PWA cache.)"
