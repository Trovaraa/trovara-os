import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export type SecurityEventType =
  | 'failed_login'
  | 'failed_registration'
  | 'break_glass_login'
  | 'password_reset_requested'
  | 'password_reset_failed'
  | 'password_reset_completed'
  | 'password_changed'
  | 'csrf_failure'
  | 'forbidden_access'
  | 'invalid_webhook_signature'

const APP_ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
const SECURITY_LOG_PATH = join(APP_ROOT, 'logs', 'security.log')

type SecurityMetadata = Record<string, unknown>

export function logSecurityEvent(type: SecurityEventType, metadata: SecurityMetadata = {}) {
  try {
    mkdirSync(dirname(SECURITY_LOG_PATH), { recursive: true })
    const entry = {
      ts: new Date().toISOString(),
      type,
      metadata,
    }
    appendFileSync(SECURITY_LOG_PATH, `${JSON.stringify(entry)}\n`, 'utf8')
  } catch (err) {
    // Security logging should never break request handling.
    console.error(
      'Security log write failed:',
      err instanceof Error ? err.message : String(err),
    )
  }
}
