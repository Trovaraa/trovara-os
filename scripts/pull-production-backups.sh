#!/usr/bin/env bash
#
# Copy encrypted production backup artifacts from the VM to this computer.
# Safe to run repeatedly: rsync transfers only new/changed encrypted artifacts,
# manifests, and machine-readable reports. Plain SQL files are never copied.
#
# Uses one multiplexed SSH connection so a passphrase-protected key is entered
# at most once (preflight), then reused by rsync without re-prompting.

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ -f "$ROOT_DIR/.env.deploy" ]]; then
  # shellcheck disable=SC1091
  set -a
  source "$ROOT_DIR/.env.deploy"
  set +a
fi

: "${VM_HOST:?Set VM_HOST in .env.deploy or the environment}"

SSH_PORT="${SSH_PORT:-22}"
SSH_KEY="${SSH_KEY:-}"
REMOTE_BACKUP_DIR="${REMOTE_BACKUP_DIR:-/var/backups/trovara-os}"
LOCAL_BACKUP_DIR="${LOCAL_BACKUP_DIR:-$HOME/Trovara Backups/production}"

if ! command -v rsync >/dev/null 2>&1; then
  echo "ERROR: rsync is required on this computer" >&2
  exit 1
fi

# Shared SSH options, including a private connection-multiplexing socket so the
# passphrase is only requested once and rsync reuses the same connection.
# Kept under ~/.ssh to stay within the OS socket-path length limit.
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
CONTROL_PATH="$HOME/.ssh/trovara-cm-$$.sock"
SSH_OPTS=(-p "$SSH_PORT"
  -o ControlMaster=auto
  -o "ControlPath=$CONTROL_PATH"
  -o ControlPersist=120
  -o ConnectTimeout=15)
if [[ -n "$SSH_KEY" ]]; then
  SSH_KEY="${SSH_KEY/#\~/$HOME}"
  if [[ ! -f "$SSH_KEY" ]]; then
    echo "ERROR: SSH_KEY not found: $SSH_KEY" >&2
    exit 1
  fi
  SSH_OPTS+=(-i "$SSH_KEY")
fi

close_master() {
  ssh "${SSH_OPTS[@]}" -O exit "$VM_HOST" >/dev/null 2>&1 || true
}
trap close_master EXIT

# Preflight: opens the master connection (one passphrase prompt) and verifies
# the remote can actually serve the backups before rsync runs.
echo "==> Checking $VM_HOST before pulling backups"
preflight="$(ssh "${SSH_OPTS[@]}" "$VM_HOST" "
  set -e
  if ! command -v rsync >/dev/null 2>&1; then echo NO_RSYNC; exit 0; fi
  if [[ ! -d '$REMOTE_BACKUP_DIR' ]]; then echo NO_DIR; exit 0; fi
  if [[ ! -r '$REMOTE_BACKUP_DIR' ]]; then echo NO_READ; exit 0; fi
  count=\$(find '$REMOTE_BACKUP_DIR' -maxdepth 1 -name '*.sql.gpg' | wc -l | tr -d ' ')
  echo \"OK:\$count\"
")" || {
  echo "ERROR: could not connect to $VM_HOST. Verify SSH access and, for a" >&2
  echo "       passphrase-protected key, run: ssh-add \"$SSH_KEY\"" >&2
  exit 1
}

case "$preflight" in
  NO_RSYNC)
    echo "ERROR: rsync is not installed on the VM. Install it, e.g.:" >&2
    echo "       ssh ${VM_HOST} 'sudo apt-get update && sudo apt-get install -y rsync'" >&2
    exit 1 ;;
  NO_DIR)
    echo "ERROR: remote backup dir does not exist: $REMOTE_BACKUP_DIR" >&2
    echo "       Run a production backup first (deploy without --skip-backup)." >&2
    exit 1 ;;
  NO_READ)
    echo "ERROR: the SSH user cannot read $REMOTE_BACKUP_DIR (permissions)." >&2
    exit 1 ;;
  OK:0)
    echo "ERROR: no encrypted database backups (*.sql.gpg) exist in $REMOTE_BACKUP_DIR yet." >&2
    exit 1 ;;
  OK:*)
    echo "    ${preflight#OK:} encrypted backup(s) available" ;;
  *)
    echo "ERROR: unexpected preflight response: $preflight" >&2
    exit 1 ;;
esac

mkdir -p "$LOCAL_BACKUP_DIR"
chmod 700 "$LOCAL_BACKUP_DIR"

echo "==> Pulling encrypted backups to $LOCAL_BACKUP_DIR"
rsync -az --partial --prune-empty-dirs \
  -e "ssh ${SSH_OPTS[*]}" \
  --include='*/' \
  --include='*.sql.gpg' \
  --include='*.evidence.tar.gpg' \
  --include='*.manifest.sha256' \
  --include='*.json' \
  --exclude='*.partial' \
  --exclude='*' \
  "$VM_HOST:$REMOTE_BACKUP_DIR/" "$LOCAL_BACKUP_DIR/"

chmod -R go-rwx "$LOCAL_BACKUP_DIR"

shopt -s nullglob
database_backups=("$LOCAL_BACKUP_DIR"/*.sql.gpg)
if [[ "${#database_backups[@]}" -eq 0 ]]; then
  echo "ERROR: no encrypted database backup was copied" >&2
  exit 1
fi

latest_backup="$(ls -1t "${database_backups[@]}" | awk 'NR == 1 { print; exit }')"
echo "Off-server copy ready: $latest_backup"
echo "Keep the GPG passphrase recovery copy separate from this directory."
