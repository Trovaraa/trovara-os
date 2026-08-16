#!/usr/bin/env bash
# Read the private production release ledger over SSH.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -f "$ROOT_DIR/.env.deploy" ]]; then
  # shellcheck disable=SC1091
  set -a; source "$ROOT_DIR/.env.deploy"; set +a
fi

: "${VM_HOST:?Set VM_HOST in .env.deploy or the environment}"
REMOTE_DIR="${REMOTE_DIR:-/home/ubuntu/trovara-os}"
RELEASE_HISTORY_DIR="${RELEASE_HISTORY_DIR:-$REMOTE_DIR/.release-history}"
SSH_PORT="${SSH_PORT:-22}"
SSH_KEY="${SSH_KEY:-}"
LIMIT="${1:-20}"
if [[ ! "$LIMIT" =~ ^[1-9][0-9]{0,2}$ ]]; then
  echo "Usage: npm run release:history -- [1-999]" >&2
  exit 1
fi

SSH_ARGS=(-p "$SSH_PORT")
if [[ -n "$SSH_KEY" ]]; then
  SSH_KEY="${SSH_KEY/#\~/$HOME}"
  SSH_ARGS+=(-i "$SSH_KEY")
fi

ssh "${SSH_ARGS[@]}" "$VM_HOST" \
  "tail -n $LIMIT -- '$RELEASE_HISTORY_DIR/history.jsonl'" |
  node -e '
let data = "";
process.stdin.on("data", chunk => data += chunk).on("end", () => {
  const rows = data.trim().split("\n").filter(Boolean).map(line => JSON.parse(line)).reverse();
  if (!rows.length) { console.log("No successful releases recorded yet."); return; }
  console.table(rows.map(row => ({
    completedAt: row.completedAt,
    operation: row.operation,
    sha: String(row.sha || "").slice(0, 12),
    tag: row.tag || "",
    previous: String(row.previousSha || "").slice(0, 12),
    migrations: `${row.migrationAction || "?"}:${row.migrationTip || "?"}`,
    backup: row.backup?.status || "none",
    operator: row.operator || "unknown",
  })));
});
'
