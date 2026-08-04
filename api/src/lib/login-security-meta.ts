import { isUnusualLoginIp, hashIp } from './session.js'
import { withAccessMeta } from './request-access-meta.js'

type LoginUserFields = {
  id: string
  email: string
  role: string
  farmId: string
}

/**
 * Shared staff login metadata: IP/geo + unusualLogin vs prior session IP hashes.
 */
export async function staffLoginSecurityMeta(
  getHeader: (name: string) => string | undefined,
  user: LoginUserFields,
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const base = withAccessMeta(getHeader, {
    userId: user.id,
    email: user.email,
    role: user.role,
    farmId: user.farmId,
    ...extra,
  })
  const resolvedIp = typeof base.ip === 'string' ? base.ip : 'unknown'
  const unusualLogin = await isUnusualLoginIp(user.id, hashIp(resolvedIp))
  return {
    ...base,
    unusualLogin,
    ...(unusualLogin ? { unusualReason: 'new_ip' } : {}),
  }
}
