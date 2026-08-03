import { and, eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { users } from '../db/schema.js'

/**
 * True when at least one active owner on the farm has authenticator (TOTP)
 * enabled. Used to gate customer-facing order channels in production.
 */
export async function farmHasOwnerTotpEnabled(farmId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.farmId, farmId),
        eq(users.role, 'owner'),
        eq(users.active, true),
        eq(users.totpEnabled, true),
      ),
    )
    .limit(1)
  return Boolean(row)
}

/**
 * In production, customer WhatsApp/Telegram order flows require an owner with
 * 2FA enabled unless ALLOW_CUSTOMER_CHANNELS_WITHOUT_TOTP=true.
 */
export function customerChannelsRequireOwnerTotp(): boolean {
  if (process.env.NODE_ENV !== 'production') return false
  if (process.env.ALLOW_CUSTOMER_CHANNELS_WITHOUT_TOTP === 'true') return false
  return true
}

export const OWNER_TOTP_REQUIRED_CUSTOMER_MSG =
  'Online ordering is temporarily unavailable. Farm staff: enable Admin 2FA in Settings, then try again.'
