import { config } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
config({ path: resolve(rootDir, '.env') })

if (process.env.NODE_ENV === 'production') {
  if (!process.env.CRON_SECRET?.trim()) {
    console.warn(
      'WARNING: CRON_SECRET is not set - cron scripts (retention, proactive alerts, evening digest) cannot authenticate.',
    )
  }

  const sessionSecret = process.env.SESSION_SECRET?.trim()
  if (sessionSecret && sessionSecret.length < 32) {
    console.error('FATAL: SESSION_SECRET must be at least 32 characters in production')
    process.exit(1)
  }

  if (process.env.TELEGRAM_BOT_TOKEN?.trim() && !process.env.TELEGRAM_WEBHOOK_SECRET?.trim()) {
    console.warn(
      'WARNING: TELEGRAM_BOT_TOKEN is set but TELEGRAM_WEBHOOK_SECRET is unset in production - webhook mode will not verify inbound requests.',
    )
  }

  if (
    process.env.TELEGRAM_CUSTOMER_BOT_TOKEN?.trim() &&
    !process.env.TELEGRAM_CUSTOMER_WEBHOOK_SECRET?.trim()
  ) {
    console.warn(
      'WARNING: TELEGRAM_CUSTOMER_BOT_TOKEN is set but TELEGRAM_CUSTOMER_WEBHOOK_SECRET is unset in production - the customer bot webhook will not verify inbound requests.',
    )
  }
}
