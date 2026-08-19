#!/usr/bin/env bash
# Fail before any production backup, migration, build, or release when required
# configuration is incomplete. This intentionally prints names, never values.
set -euo pipefail

if [[ "${NODE_ENV:-}" != "production" ]]; then
  echo "ERROR: NODE_ENV must be production" >&2
  exit 1
fi

required=(
  DATABASE_URL API_HOST API_PORT CORS_ORIGIN TRUSTED_PROXY_HOPS
  PUBLIC_APP_URL PUBLIC_MARKETING_URL PUBLIC_SHOP_URL CRON_SECRET CRON_FARM_ID BREAK_GLASS_PASSWORD
  VAULT_ENCRYPTION_KEY EVIDENCE_STORAGE_ROOT BACKUP_DIR
  BACKUP_GPG_PASSPHRASE CUSTOMER_FARM_ID
  FORM_PROXY_SIGNING_SECRET
  FINANCE_IMPORT_SECRET
  KNOWLEDGE_STORAGE_ENDPOINT KNOWLEDGE_STORAGE_REGION KNOWLEDGE_STORAGE_BUCKET
  KNOWLEDGE_STORAGE_ACCESS_KEY KNOWLEDGE_STORAGE_SECRET_KEY
  KNOWLEDGE_STORAGE_ENCRYPTION_KEY CLAMAV_HOST CLAMAV_PORT OCR_COMMAND
)

missing=()
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    missing+=("$name")
  fi
done
if [[ -z "${TOTP_ENCRYPTION_KEY:-}" && -z "${TOTP_KEY_DERIVATION_SECRET:-}" ]]; then
  missing+=("TOTP_ENCRYPTION_KEY (or TOTP_KEY_DERIVATION_SECRET)")
fi

if [[ "${REQUIRE_EVIDENCE_BACKUP:-}" != "1" ]]; then
  missing+=("REQUIRE_EVIDENCE_BACKUP=1")
fi

# Optional rclone offsite: only validate consistency when explicitly enabled.
if [[ "${BACKUP_REMOTE_ENABLED:-}" == "1" || "${BACKUP_REMOTE_REQUIRED:-}" == "1" ]]; then
  if [[ -z "${BACKUP_RCLONE_DESTINATION:-}" ]]; then
    missing+=("BACKUP_RCLONE_DESTINATION (remote backup enabled)")
  fi
fi

if [[ -n "${WHATSAPP_ACCESS_TOKEN:-}" && -z "${META_APP_SECRET:-}" ]]; then
  missing+=("META_APP_SECRET (WhatsApp enabled)")
fi
if [[ "${TELEGRAM_MODE:-polling}" == "webhook" &&
      -n "${TELEGRAM_BOT_TOKEN:-}" &&
      -z "${TELEGRAM_WEBHOOK_SECRET:-}" ]]; then
  missing+=("TELEGRAM_WEBHOOK_SECRET (Telegram webhook enabled)")
fi
if [[ -n "${TELEGRAM_CUSTOMER_BOT_TOKEN:-}" &&
      -z "${TELEGRAM_CUSTOMER_WEBHOOK_SECRET:-}" ]]; then
  missing+=("TELEGRAM_CUSTOMER_WEBHOOK_SECRET (customer bot enabled)")
fi
if [[ -n "${RESEND_API_KEY:-}" &&
      -z "${EMAIL_FROM:-${RESEND_FROM:-}}" ]]; then
  missing+=("EMAIL_FROM (or RESEND_FROM; Resend enabled)")
fi
if [[ -n "${RESEND_INBOUND_WEBHOOK_SECRET:-}" &&
      -z "${FINANCE_INBOUND_FARM_ID:-}" ]]; then
  missing+=("FINANCE_INBOUND_FARM_ID (finance inbound enabled)")
fi

if ((${#missing[@]})); then
  echo "ERROR: incomplete production environment:" >&2
  printf '  - %s\n' "${missing[@]}" >&2
  exit 1
fi

if [[ "$EVIDENCE_STORAGE_ROOT" != /* || "$BACKUP_DIR" != /* ]]; then
  echo "ERROR: EVIDENCE_STORAGE_ROOT and BACKUP_DIR must be absolute" >&2
  exit 1
fi
if [[ "$API_HOST" != "127.0.0.1" ]]; then
  echo "ERROR: production API_HOST must be 127.0.0.1 behind the reverse proxy" >&2
  exit 1
fi
if [[ "${BREAK_GLASS_ENABLED:-false}" == "true" ]]; then
  echo "ERROR: BREAK_GLASS_ENABLED must not remain armed during deployment" >&2
  exit 1
fi
if [[ "${ALLOW_FULL_DB_RESET:-false}" == "true" ||
      "${LIVE_MODE_OVERRIDE:-false}" == "true" ]]; then
  echo "ERROR: destructive database safety overrides must be disabled" >&2
  exit 1
fi

echo "Production environment preflight passed"
