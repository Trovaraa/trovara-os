import { and, eq, ne } from 'drizzle-orm'
import { db } from '../db/index.js'
import { users } from '../db/schema.js'
import { getBreakGlassEmail } from './registration.js'

/**
 * True when at least one active day-to-day owner on the farm has authenticator
 * (TOTP) enabled. The break-glass emergency account is excluded so enabling
 * 2FA only on that reserved address cannot satisfy the customer-channel gate.
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
        ne(users.email, getBreakGlassEmail()),
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
