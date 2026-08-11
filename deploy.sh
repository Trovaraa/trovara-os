#!/usr/bin/env bash
#
# Deploy the local trovara-os/ folder to the production VM.
#
# What it does (safe + idempotent):
#   1. rsync the source tree to the VM  (NEVER overwrites prod .env, node_modules, or builds)
#   2. on the VM: Node 22 → npm ci → api+app tests/audit/build → encrypted backup → migrate
#   3. rsync the built frontend into the nginx web root
#   4. restart the systemd API service
#   5. health-check the API
#   6. pull encrypted backups to this computer (default; --skip-pull-backups to disable)
#
# Usage:
#   ./deploy.sh                 # full deploy (install, migrate, build, restart, pull backups)
#   ./deploy.sh --catalog       # also run sync-catalog (when farm-knowledge changed)
#   ./deploy.sh --skip-install  # skip npm ci (no lockfile change)
#   ./deploy.sh --skip-migrate  # skip db:migrate (no new migrations)
#   ./deploy.sh --skip-backup   # disposable/demo DB only; never use with real data
#   ./deploy.sh --skip-pull-backups  # keep server backup only (do not copy to this computer)
#   ./deploy.sh --pull-backups  # (default) copy encrypted backups to this computer after success
#   ./deploy.sh --install-backup-timers  # enable nightly backup + weekly restore test
#
# Config: create a gitignored .env.deploy next to this script:
#   VM_HOST=ubuntu@your.vm.ip            # required (ssh target or ~/.ssh/config alias)
#   SSH_PORT=22                          # optional (e.g. 22022)
#   SSH_KEY=/path/to/private_key         # optional (ssh -i identity file)
#   REMOTE_DIR=/home/ubuntu/trovara-os   # optional (default shown)
#   WEB_ROOT=/home/trovara-os/htdocs/os.trovara.farm  # optional
#   SERVICE=trovara-api                  # optional
#   APP_USER=ubuntu                      # optional; defaults to systemd service User
#   VITE_API_URL=https://os.trovara.farm # optional
#   VITE_PUBLIC_APP_URL=https://os.trovara.farm  # optional
#   VITE_PUBLIC_MARKETING_URL=https://trovara.farm  # optional
#   REMOTE_BACKUP_DIR=/var/backups/trovara-os     # optional
#   LOCAL_BACKUP_DIR="$HOME/Trovara Backups/production"  # optional
#   RELEASE_REF=v1.2.3                  # optional immutable commit/tag; defaults HEAD

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
  echo "ERROR: local nvm is required to select Node 22" >&2
  exit 1
fi
# shellcheck disable=SC1091
source "$NVM_DIR/nvm.sh"
nvm use 22 >/dev/null

# --- Load config -------------------------------------------------------------
if [[ -f "$SCRIPT_DIR/.env.deploy" ]]; then
  # shellcheck disable=SC1091
  set -a; source "$SCRIPT_DIR/.env.deploy"; set +a
fi

REMOTE_DIR="${REMOTE_DIR:-/home/ubuntu/trovara-os}"
WEB_ROOT="${WEB_ROOT:-/home/trovara-os/htdocs/os.trovara.farm}"
SERVICE="${SERVICE:-trovara-api}"
APP_USER="${APP_USER:-}"
VITE_API_URL="${VITE_API_URL:-https://os.trovara.farm}"
VITE_PUBLIC_APP_URL="${VITE_PUBLIC_APP_URL:-https://os.trovara.farm}"
VITE_PUBLIC_MARKETING_URL="${VITE_PUBLIC_MARKETING_URL:-https://trovara.farm}"
SSH_PORT="${SSH_PORT:-22}"
SSH_KEY="${SSH_KEY:-}"
REMOTE_BACKUP_DIR="${REMOTE_BACKUP_DIR:-/var/backups/trovara-os}"
LOCAL_BACKUP_DIR="${LOCAL_BACKUP_DIR:-$HOME/Trovara Backups/production}"

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

if [[ -z "$VITE_API_URL" || -z "$VITE_PUBLIC_APP_URL" ||
      -z "$VITE_PUBLIC_MARKETING_URL" ]]; then
  echo "ERROR: all VITE public production URLs must be non-empty" >&2
  exit 1
fi

# --- Flags -------------------------------------------------------------------
RUN_CATALOG=0
SKIP_INSTALL=0
SKIP_MIGRATE=0
SKIP_BACKUP=0
# Default on: after a successful deploy, copy encrypted backups to this computer.
PULL_BACKUPS=1
INSTALL_BACKUP_TIMERS=0
for arg in "$@"; do
  case "$arg" in
    --catalog) RUN_CATALOG=1 ;;
    --skip-install) SKIP_INSTALL=1 ;;
    --skip-migrate) SKIP_MIGRATE=1 ;;
    --skip-backup) SKIP_BACKUP=1 ;;
    --skip-pull-backups) PULL_BACKUPS=0 ;;
    --pull-backups) PULL_BACKUPS=1 ;;
    --install-backup-timers) INSTALL_BACKUP_TIMERS=1 ;;
    -h|--help) sed -n '2,33p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

if [[ "$PULL_BACKUPS" -eq 1 && "$SKIP_BACKUP" -eq 1 ]]; then
  echo "NOTE: --skip-backup also skips local backup pull (use scripts/pull-production-backups.sh to copy existing artifacts)."
  PULL_BACKUPS=0
fi
if [[ "$SKIP_BACKUP" -eq 1 && "${ALLOW_UNSAFE_DEPLOY_WITHOUT_BACKUP:-0}" != "1" ]]; then
  echo "ERROR: production deploys require a verified off-host backup." >&2
  echo "Set ALLOW_UNSAFE_DEPLOY_WITHOUT_BACKUP=1 only for a disposable environment." >&2
  exit 1
fi

# Production releases are built from a clean, immutable Git object, never from
# an uncommitted working tree or a mutable branch name.
GIT_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null)" || {
  echo "ERROR: deploy.sh must run from a Git working tree" >&2
  exit 1
}
if [[ -n "$(git -C "$GIT_ROOT" status --porcelain --untracked-files=normal)" ]]; then
  echo "ERROR: working tree is dirty; commit or stash every change before deploying" >&2
  exit 1
fi
RELEASE_REF="${RELEASE_REF:-HEAD}"
RELEASE_SHA="$(git -C "$GIT_ROOT" rev-parse --verify "${RELEASE_REF}^{commit}")" || {
  echo "ERROR: RELEASE_REF is not a commit or tag: $RELEASE_REF" >&2
  exit 1
}
if [[ "$RELEASE_REF" == "HEAD" && "$RELEASE_SHA" != "$(git -C "$GIT_ROOT" rev-parse HEAD)" ]]; then
  echo "ERROR: unable to resolve local HEAD deterministically" >&2
  exit 1
fi
RELEASE_TAG="$(git -C "$GIT_ROOT" describe --tags --exact-match "$RELEASE_SHA" 2>/dev/null || true)"
RELEASED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
REPO_PREFIX="${SCRIPT_DIR#"$GIT_ROOT"/}"
if [[ "$REPO_PREFIX" == "$SCRIPT_DIR" ]]; then
  REPO_PREFIX="."
fi

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
RELEASE_STAGE="$(mktemp -d -t trovara-release.XXXXXX)"
REMOTE_RUNNER=""
cleanup() {
  rm -rf "$RELEASE_STAGE"
  [[ -z "$REMOTE_RUNNER" ]] || rm -f "$REMOTE_RUNNER"
}
trap cleanup EXIT
git -C "$GIT_ROOT" archive "$RELEASE_SHA" -- "$REPO_PREFIX" | tar -x -C "$RELEASE_STAGE"
STAGED_SOURCE="$RELEASE_STAGE/$REPO_PREFIX"
node - "$STAGED_SOURCE/RELEASE.json" "$RELEASE_SHA" "$RELEASE_TAG" "$RELEASED_AT" <<'NODE'
const fs = require('node:fs')
const [file, sha, tag, releasedAt] = process.argv.slice(2)
fs.writeFileSync(file, `${JSON.stringify({
  schemaVersion: 1,
  sha,
  tag: tag || null,
  releasedAt,
}, null, 2)}\n`, { mode: 0o644 })
NODE

echo "==> Syncing immutable release $RELEASE_SHA (prod .env is never touched)…"
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
  --exclude 'api/data/evidence/' \
  --exclude 'uploads/' \
  --exclude 'logs/' \
  --exclude '*.log' \
  --exclude '.DS_Store' \
  --exclude '.cursor/' \
  --exclude 'CONTEXT.md' \
  --exclude 'context.md' \
  "$STAGED_SOURCE/" "$VM_HOST:$REMOTE_DIR/"

# --- 2-4. Remote build + release --------------------------------------------
# Generate the remote runner, copy it over, then execute with a TTY so sudo can
# prompt if the VM requires a password.
REMOTE_RUNNER="$(mktemp -t trovara-deploy.XXXXXX.sh)"

cat >"$REMOTE_RUNNER" <<REMOTE
#!/usr/bin/env bash
set -euo pipefail
cd "$REMOTE_DIR"

export NVM_DIR="\${NVM_DIR:-\$HOME/.nvm}"
if [[ ! -s "\$NVM_DIR/nvm.sh" ]]; then
  echo "ERROR: nvm is not installed for \$(id -un) at \$NVM_DIR" >&2
  exit 1
fi
# shellcheck disable=SC1091
source "\$NVM_DIR/nvm.sh"
nvm use 22
echo "==> [vm] node \$(node -v), npm \$(npm -v)"

if [[ ! -f .env ]]; then
  echo "ERROR: production .env is missing at $REMOTE_DIR/.env" >&2
  exit 1
fi
set -a
# shellcheck disable=SC1091
source .env
set +a

echo "==> [vm] validating the complete production environment"
bash scripts/check-production-env.sh

SERVICE_USER="$APP_USER"
if [[ -z "\$SERVICE_USER" ]]; then
  SERVICE_USER="\$(sudo systemctl show -p User --value "$SERVICE" 2>/dev/null || true)"
fi
if [[ -z "\$SERVICE_USER" || "\$SERVICE_USER" == "root" ]]; then
  SERVICE_USER="\$(id -un)"
fi
if ! id "\$SERVICE_USER" >/dev/null 2>&1; then
  echo "ERROR: deployment/service user does not exist: \$SERVICE_USER" >&2
  exit 1
fi
SERVICE_GROUP="\$(id -gn "\$SERVICE_USER")"
export BACKUP_DIR="\${BACKUP_DIR:-/var/backups/trovara-os}"

echo "==> [vm] preparing persistent directories for \$SERVICE_USER:\$SERVICE_GROUP"
sudo install -d -m 0750 -o "\$SERVICE_USER" -g "\$SERVICE_GROUP" \
  "\$EVIDENCE_STORAGE_ROOT" "\$BACKUP_DIR" "$REMOTE_DIR/logs"

if [[ "$SKIP_INSTALL" -eq 0 ]]; then
  echo "==> [vm] npm ci (including build/test tooling)"
  npm ci --include=dev
else
  echo "==> [vm] skipping npm ci"
fi

echo "==> [vm] API + app tests"
NODE_ENV=test npm test

echo "==> [vm] dependency audit (high+ blocks deploy)"
npm audit --workspaces --audit-level=high

echo "==> [vm] production build (VITE_API_URL=$VITE_API_URL)"
VITE_API_URL="$VITE_API_URL" \
VITE_PUBLIC_APP_URL="$VITE_PUBLIC_APP_URL" \
VITE_PUBLIC_MARKETING_URL="$VITE_PUBLIC_MARKETING_URL" \
npm run build
cp RELEASE.json app/dist/RELEASE.json

if [[ "$SKIP_BACKUP" -eq 0 ]]; then
  echo "==> [vm] production backup (encrypt, verify, manifest, required remote delivery)"
  npm run backup:production
  npm run backup:freshness
else
  echo "==> [vm] WARNING: skipping backup (disposable/demo database only)"
fi

if [[ "$SKIP_MIGRATE" -eq 0 ]]; then
  echo "==> [vm] db:migrate"
  npm run db:migrate
else
  echo "==> [vm] skipping db:migrate"
fi

if [[ "$RUN_CATALOG" -eq 1 ]]; then
  echo "==> [vm] sync-catalog"
  npm run sync-catalog -w api
fi

if [[ "$INSTALL_BACKUP_TIMERS" -eq 1 ]]; then
  echo "==> [vm] installing backup and restore-test systemd timers"
  BACKUP_SERVICE_USER="\$SERVICE_USER" bash scripts/install-backup-timers.sh
fi

echo "==> [vm] releasing frontend to $WEB_ROOT"
sudo rsync -a --delete "$REMOTE_DIR/app/dist/" "$WEB_ROOT/"

echo "==> [vm] restarting $SERVICE"
sudo systemctl restart "$SERVICE"

echo "==> [vm] health and readiness checks"
for attempt in \$(seq 1 15); do
  if curl -fsS http://127.0.0.1:3000/health >/dev/null &&
     curl -fsS http://127.0.0.1:3000/ready >/dev/null; then
    echo "  OK"
    exit 0
  fi
  sleep 2
done
echo "API health/readiness check FAILED" >&2
sudo systemctl status "$SERVICE" --no-pager || true
exit 1
REMOTE

$SCP -q "$REMOTE_RUNNER" "$VM_HOST:/tmp/trovara-deploy-remote.sh"
$SSH -t "$VM_HOST" 'bash /tmp/trovara-deploy-remote.sh; rc=$?; rm -f /tmp/trovara-deploy-remote.sh; exit $rc'

pull_local_backups() {
  echo "==> Pulling encrypted backup artifacts to $LOCAL_BACKUP_DIR"
  REMOTE_BACKUP_DIR="$REMOTE_BACKUP_DIR" \
    LOCAL_BACKUP_DIR="$LOCAL_BACKUP_DIR" \
    "$SCRIPT_DIR/scripts/pull-production-backups.sh"
}

if [[ "$PULL_BACKUPS" -eq 1 ]]; then
  pull_local_backups
else
  echo "==> Skipping local backup pull"
fi

echo ""
echo "==> Done. Live at $VITE_PUBLIC_APP_URL"
echo "    (If the browser shows an old build, hard-refresh / clear the PWA cache.)"
