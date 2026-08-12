#!/usr/bin/env bash
# Gate production operations on a recent, successful encrypted backup.
# Remote rclone delivery is optional; when enabled in the report it must have
# succeeded. When disabled, local verified artifacts (+ Mac deploy pulls) are
# enough.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-$ROOT_DIR/backups}"
REPORT="${BACKUP_REPORT_DIR:-$BACKUP_DIR/reports}/latest-backup.json"
MAX_AGE_HOURS="${BACKUP_MAX_AGE_HOURS:-26}"

[[ "$MAX_AGE_HOURS" =~ ^[1-9][0-9]*$ ]] || {
  echo "ERROR: BACKUP_MAX_AGE_HOURS must be a positive integer" >&2
  exit 1
}
[[ -s "$REPORT" ]] || {
  echo "ERROR: backup success report missing: $REPORT" >&2
  exit 1
}

node --input-type=module - "$REPORT" "$BACKUP_DIR" "$MAX_AGE_HOURS" <<'NODE'
import fs from 'node:fs'
import path from 'node:path'

const [reportPath, backupDir, maxAgeRaw] = process.argv.slice(2)
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
const safeName = (value) =>
  typeof value === 'string' && /^[A-Za-z0-9._-]+$/.test(value) ? value : null

if (report.status !== 'success') throw new Error('latest backup report is not successful')

const remote = report.remoteDelivery ?? {}
const remoteEnabled = remote.enabled === true
if (remoteEnabled && remote.status !== 'delivered') {
  throw new Error('latest backup was not delivered off-server (remote delivery enabled)')
}
if (!remoteEnabled && remote.status && remote.status !== 'disabled') {
  throw new Error(`latest backup remoteDelivery status is unexpected: ${remote.status}`)
}

const completed = Date.parse(report.completedAt)
if (!Number.isFinite(completed)) throw new Error('latest backup has an invalid completedAt')
const ageHours = (Date.now() - completed) / 3_600_000
if (ageHours < 0 || ageHours > Number(maxAgeRaw)) {
  throw new Error(`latest backup is stale (${ageHours.toFixed(1)}h; max ${maxAgeRaw}h)`)
}
for (const key of ['databaseBackup', 'evidenceBackup', 'manifest']) {
  const name = safeName(report[key])
  if (!name || !fs.statSync(path.join(backupDir, name)).isFile()) {
    throw new Error(`latest backup report has missing/unsafe ${key}`)
  }
}
const remoteNote = remoteEnabled ? 'remote delivered' : 'local only (remote optional)'
console.log(`Backup freshness gate passed (${ageHours.toFixed(1)}h old, ${remoteNote})`)
NODE
