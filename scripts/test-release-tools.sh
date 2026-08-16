#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

bash -n deploy.sh rollback.sh scripts/release-history.sh scripts/test-release-tools.sh
node --check scripts/record-release.mjs

TEST_DIR="$(mktemp -d -t trovara-release-tools.XXXXXX)"
cleanup() { rm -rf "$TEST_DIR"; }
trap cleanup EXIT

# Render the exact remote runner heredoc with inert values, then syntax-check
# the result. `bash -n deploy.sh` alone cannot see quoting errors introduced by
# the local interpolation step.
cat >"$TEST_DIR/render-runner.sh" <<EOF
REMOTE_RUNNER="$TEST_DIR/remote-runner.sh"
REMOTE_DIR=/tmp/trovara-os
RELEASE_HISTORY_DIR=/tmp/trovara-os/.release-history
WEB_ROOT=/tmp/trovara-web
APP_USER=tester
SERVICE=trovara-api
SKIP_INSTALL=0
SKIP_BACKUP=0
SKIP_MIGRATE=0
RUN_CATALOG=0
INSTALL_BACKUP_TIMERS=0
VITE_API_URL=https://os.example
VITE_PUBLIC_APP_URL=https://os.example
VITE_PUBLIC_MARKETING_URL=https://www.example
RELEASE_SHA=1234567abcdef
RELEASE_OPERATION=deploy
RELEASE_ROLLBACK_FROM=unknown
RELEASE_OPERATOR_SAFE=tester
EOF
sed -n '/^cat >"\$REMOTE_RUNNER" <<REMOTE$/,/^REMOTE$/p' deploy.sh >>"$TEST_DIR/render-runner.sh"
bash "$TEST_DIR/render-runner.sh"
bash -n "$TEST_DIR/remote-runner.sh"

SHA="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
cat >"$TEST_DIR/RELEASE.json" <<EOF
{"schemaVersion":1,"sha":"$SHA","tag":null,"releasedAt":"2026-08-15T00:00:00Z"}
EOF
cat >"$TEST_DIR/backup.json" <<'EOF'
{"status":"success","completedAt":"2026-08-15T00:01:00Z","databaseBackup":"db.sql.gpg","evidenceBackup":"evidence.tar.gpg","manifest":"db.manifest.sha256","remoteDelivery":{"status":"delivered"}}
EOF

node scripts/record-release.mjs \
  --history-dir "$TEST_DIR/history" \
  --release-file "$TEST_DIR/RELEASE.json" \
  --operation deploy \
  --previous-sha 1234567 \
  --rollback-from unknown \
  --operator test-operator \
  --migration-tip 0067_test \
  --migration-count 67 \
  --migration-action applied \
  --backup-report "$TEST_DIR/backup.json" >/dev/null

node - "$TEST_DIR/history/current.json" "$TEST_DIR/history/history.jsonl" "$SHA" <<'NODE'
import fs from 'node:fs'
const [currentPath, historyPath, expectedSha] = process.argv.slice(2)
const current = JSON.parse(fs.readFileSync(currentPath, 'utf8'))
const history = fs.readFileSync(historyPath, 'utf8').trim().split('\n').map(JSON.parse)
if (current.sha !== expectedSha || current.migrationCount !== 67) process.exit(1)
if (current.migrationAction !== 'applied' || current.backup?.database !== 'db.sql.gpg') process.exit(1)
if (current.backup?.evidence !== 'evidence.tar.gpg' || current.backup?.remoteDelivery !== 'delivered') process.exit(1)
if (history.length !== 1) process.exit(1)
NODE

# A Git archive on production deliberately has no usable history. Exercise the
# rollback resolver where a real parent is available (developer clone / CI),
# and keep the release-recorder + rendered-runner checks portable everywhere.
if CURRENT="$(git rev-parse HEAD 2>/dev/null)" &&
   PREVIOUS="$(git rev-parse HEAD~1 2>/dev/null)"; then
  CURRENT_RELEASE_SHA="$CURRENT" bash rollback.sh "$PREVIOUS" \
    --dry-run --allow-forward-database >"$TEST_DIR/rollback.out"
  grep -q 'RELEASE_OPERATION=rollback' "$TEST_DIR/rollback.out"
  grep -q -- '--skip-migrate' "$TEST_DIR/rollback.out"

  if CURRENT_RELEASE_SHA="$CURRENT" bash rollback.sh "$PREVIOUS" \
    --allow-forward-database >"$TEST_DIR/unconfirmed.out" 2>&1; then
    echo "rollback unexpectedly accepted an unconfirmed operation" >&2
    exit 1
  fi
  grep -q -- '--confirm-rollback' "$TEST_DIR/unconfirmed.out"
fi

echo "Release tooling tests passed"
