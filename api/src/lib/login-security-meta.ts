import { isUnusualLoginIp, hashIp } from './session.js'
import { withAccessMeta } from './request-access-meta.js'
import { and, eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { farmRoles } from '../db/schema.js'

type LoginUserFields = {
  id: string
  email: string
  role: string
  farmId: string
  farmRoleId?: string | null
}

/**
 * Shared staff login metadata: IP/geo + unusualLogin vs prior session IP hashes.
 */
export async function staffLoginSecurityMeta(
  getHeader: (name: string) => string | undefined,
  user: LoginUserFields,
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  // Snapshot the name at login, not when the historical event is displayed.
  const [assignedRole] = user.farmRoleId
    ? await db.select({ name: farmRoles.name }).from(farmRoles)
      .where(and(eq(farmRoles.id, user.farmRoleId), eq(farmRoles.farmId, user.farmId))).limit(1)
    : []
  const base = withAccessMeta(getHeader, {
    ...extra,
    userId: user.id,
    email: user.email,
    role: assignedRole?.name ?? user.role,
    systemRole: user.role,
    farmRoleId: user.farmRoleId ?? null,
    farmId: user.farmId,
  })
  const resolvedIp = typeof base.ip === 'string' ? base.ip : 'unknown'
  const unusualLogin = await isUnusualLoginIp(user.id, hashIp(resolvedIp))
  return {
    ...base,
    unusualLogin,
    ...(unusualLogin ? { unusualReason: 'new_ip' } : {}),
  }
}
