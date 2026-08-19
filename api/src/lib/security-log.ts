import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export type SecurityEventType =
  | 'login'
  | 'logout'
  | 'session_revoked'
  | 'sessions_revoked'
  | 'failed_login'
  | 'failed_customer_login'
  | 'customer_login'
  | 'customer_email_verified'
  | 'customer_password_reset_completed'
  | 'customer_credit_invitation_claimed'
  | 'failed_registration'
  | 'registration_token_created'
  | 'registration_token_used'
  | 'registration_token_revoked'
  | 'break_glass_login'
  | 'break_glass_armed'
  | 'break_glass_disarmed'
  | 'break_glass_disarmed_attempt'
  | 'password_reset_requested'
  | 'password_reset_delivery_failed'
  | 'password_reset_failed'
  | 'password_reset_completed'
  | 'password_changed'
  | 'totp_enabled'
  | 'totp_enable_failed'
  | 'totp_disabled'
  | 'totp_disable_failed'
  | 'totp_recovery_codes_regenerated'
  | 'totp_recovery_failed'
  | 'staff_user_created'
  | 'staff_role_changed'
  | 'staff_user_deactivated'
  | 'staff_user_activated'
  | 'staff_password_reset'
  | 'staff_user_removed'
  | 'farm_role_created'
  | 'farm_role_permissions_updated'
  | 'farm_role_deleted'
  | 'vault_entry_created'
  | 'vault_entry_updated'
  | 'vault_entry_deleted'
  | 'vault_password_revealed'
  | 'vault_reveal_failed'
  | 'vault_update_failed'
  | 'permission_resolution_failed'
  | 'break_glass_admin_deactivated'
  | 'break_glass_admin_reactivated'
  | 'csrf_failure'
  | 'forbidden_access'
  | 'invalid_webhook_signature'
  | 'customer_order_abuse'
  | 'customer_order_flagged'
  | 'whatsapp_recipient_blocked'

/** Kept on disk for ops, but omitted from the owner Security dashboard. */
export const SECURITY_DASHBOARD_HIDDEN_TYPES = new Set<string>([
  'forbidden_access',
  'csrf_failure',
])

export type SecurityLogEntry = {
  ts: string
  type: string
  metadata: Record<string, unknown>
}

const APP_ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
const SECURITY_LOG_PATH = join(APP_ROOT, 'logs', 'security.log')

type SecurityMetadata = Record<string, unknown>

/** Deploy runs `npm test` on the live host; never append fixture noise to production logs. */
function shouldSkipSecurityLog(): boolean {
  return process.env.NODE_ENV === 'test' || process.env.VITEST === 'true'
}

export function logSecurityEvent(type: SecurityEventType, metadata: SecurityMetadata = {}) {
  if (shouldSkipSecurityLog()) return
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

/**
 * Newest-first dashboard feed: skip CSRF/RBAC noise and walk backward until
 * `limit` useful events (or the start of the file).
 */
export function selectSecurityDashboardEvents(
  lines: string[],
  limit = 100,
): SecurityLogEntry[] {
  const events: SecurityLogEntry[] = []
  for (let i = lines.length - 1; i >= 0 && events.length < limit; i -= 1) {
    const line = lines[i]?.trim()
    if (!line) continue
    try {
      const parsed = JSON.parse(line) as {
        ts?: string
        type?: string
        metadata?: Record<string, unknown>
      }
      if (!parsed.ts || !parsed.type) continue
      if (SECURITY_DASHBOARD_HIDDEN_TYPES.has(parsed.type)) continue
      events.push({
        ts: parsed.ts,
        type: parsed.type,
        metadata: parsed.metadata ?? {},
      })
    } catch {
      // skip malformed lines
    }
  }
  return events
}
