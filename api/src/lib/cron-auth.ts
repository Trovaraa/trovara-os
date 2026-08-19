import { and, eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { users } from '../db/schema.js'
import { secureCompare } from './secure-compare.js'
import type { SessionUser } from './session.js'

export function requestHasCronSecret(c: {
  req: { header: (name: string) => string | undefined }
}): boolean {
  const cronSecret = process.env.CRON_SECRET?.trim()
  const provided = c.req.header('x-cron-secret')?.trim()
  return Boolean(cronSecret && provided && secureCompare(provided, cronSecret))
}

/** Cron callers may only target the farm pinned in CRON_FARM_ID (required in production). */
export function cronFarmIdAllowed(payloadFarmId: string | undefined): boolean {
  if (!payloadFarmId) return false
  const pinned = process.env.CRON_FARM_ID?.trim()
  if (!pinned) return process.env.NODE_ENV !== 'production'
  return secureCompare(payloadFarmId, pinned)
}

export async function getOwnerUserByFarmId(farmId: string): Promise<SessionUser | null> {
  const [owner] = await db
    .select()
    .from(users)
    .where(and(eq(users.farmId, farmId), eq(users.role, 'owner')))
    .limit(1)
  if (!owner) return null
  return {
    id: owner.id,
    farmId: owner.farmId,
    email: owner.email,
    name: owner.name,
    role: owner.role,
    farmRoleId: owner.farmRoleId,
    mustChangePassword: owner.mustChangePassword,
  }
}
