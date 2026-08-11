#!/usr/bin/env bash
#
# Install parameterized production backup timers on a systemd host.
# Run from deploy.sh with BACKUP_SERVICE_USER set to the API service account.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVICE_USER="${BACKUP_SERVICE_USER:-$(id -un)}"

if ! command -v systemctl >/dev/null 2>&1; then
  echo "ERROR: systemd is required to install backup timers" >&2
  exit 1
fi
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  echo "ERROR: backup service user does not exist: $SERVICE_USER" >&2
  exit 1
fi
if [[ ! -f "$ROOT_DIR/.env" ]]; then
  echo "ERROR: production environment file is missing: $ROOT_DIR/.env" >&2
  exit 1
fi
if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: Docker is required for weekly restore tests" >&2
  exit 1
fi
if [[ "$(id -un)" == "$SERVICE_USER" ]]; then
  DOCKER_CHECK=(docker info)
else
  DOCKER_CHECK=(sudo -u "$SERVICE_USER" docker info)
fi
if ! "${DOCKER_CHECK[@]}" >/dev/null 2>&1; then
  echo "ERROR: $SERVICE_USER needs working Docker access for weekly restore tests" >&2
  exit 1
fi

SERVICE_GROUP="$(id -gn "$SERVICE_USER")"
UNIT_DIR="$(mktemp -d -t trovara-backup-units.XXXXXX)"
trap 'rm -rf "$UNIT_DIR"' EXIT

cat >"$UNIT_DIR/trovara-backup.service" <<EOF
[Unit]
Description=Trovara OS encrypted production backup
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=$SERVICE_USER
Group=$SERVICE_GROUP
WorkingDirectory=$ROOT_DIR
EnvironmentFile=$ROOT_DIR/.env
ExecStart=/usr/bin/bash $ROOT_DIR/scripts/backup-production.sh
ExecStartPost=/usr/bin/bash $ROOT_DIR/scripts/check-backup-freshness.sh
PrivateTmp=true
NoNewPrivileges=true
UMask=0077
EOF

cat >"$UNIT_DIR/trovara-backup.timer" <<'EOF'
[Unit]
Description=Run Trovara OS production backup nightly

[Timer]
OnCalendar=*-*-* 02:15:00
RandomizedDelaySec=15m
Persistent=true
Unit=trovara-backup.service

[Install]
WantedBy=timers.target
EOF

cat >"$UNIT_DIR/trovara-restore-test.service" <<EOF
[Unit]
Description=Trovara OS isolated backup restore test
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
User=$SERVICE_USER
Group=$SERVICE_GROUP
WorkingDirectory=$ROOT_DIR
EnvironmentFile=$ROOT_DIR/.env
ExecStart=/usr/bin/bash $ROOT_DIR/scripts/restore-test-isolated.sh
PrivateTmp=true
NoNewPrivileges=true
UMask=0077
EOF

cat >"$UNIT_DIR/trovara-restore-test.timer" <<'EOF'
[Unit]
Description=Run Trovara OS isolated restore test weekly

[Timer]
OnCalendar=Sun *-*-* 04:15:00
RandomizedDelaySec=15m
Persistent=true
Unit=trovara-restore-test.service

[Install]
WantedBy=timers.target
EOF

sudo install -m 0644 "$UNIT_DIR"/trovara-*.service "$UNIT_DIR"/trovara-*.timer \
  /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now trovara-backup.timer trovara-restore-test.timer

sudo systemctl is-active --quiet trovara-backup.timer
sudo systemctl is-active --quiet trovara-restore-test.timer
echo "Backup timers installed for $SERVICE_USER:$SERVICE_GROUP"
systemctl list-timers 'trovara-*' --no-pager
