import type { Context, Next } from 'hono'
import { getCookie } from 'hono/cookie'
import { SESSION_COOKIE, getUserFromSession, type SessionUser } from '../lib/session.js'
import { logSecurityEvent } from '../lib/security-log.js'
import { withAccessMeta } from '../lib/request-access-meta.js'
import { resolvePermissionKeys } from '../lib/farm-roles.js'

export type AppVariables = {
  user: SessionUser
}

const PASSWORD_CHANGE_EXEMPT_PATHS = new Set([
  '/auth/me',
  '/auth/change-password',
  '/auth/logout',
])

export function isPasswordChangeExemptPath(path: string): boolean {
  return PASSWORD_CHANGE_EXEMPT_PATHS.has(path)
}

export async function authMiddleware(c: Context<{ Variables: AppVariables }>, next: Next) {
  const token = getCookie(c, SESSION_COOKIE)
  const user = await getUserFromSession(token)
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  if (user.mustChangePassword && !isPasswordChangeExemptPath(c.req.path)) {
    return c.json({ error: 'Password change required' }, 403)
  }

  try {
    user.permissions = await resolvePermissionKeys({
      role: user.role,
      farmId: user.farmId,
      farmRoleId: user.farmRoleId,
      userId: user.id,
    })
  } catch (err) {
    // Fail closed for non-owners: empty grants deny permission checks instead of
    // falling through to overly-broad legacy defaults (e.g. vault.view).
    logSecurityEvent(
      'permission_resolution_failed',
      withAccessMeta((name) => c.req.header(name), {
        path: c.req.path,
        method: c.req.method,
        userId: user.id,
        farmId: user.farmId,
        role: user.role,
        error: err instanceof Error ? err.message : 'unknown',
      }),
    )
    user.permissions = []
  }

  c.set('user', user)
  await next()
  if (c.res.status === 403) {
    logSecurityEvent(
      'forbidden_access',
      withAccessMeta((name) => c.req.header(name), {
        path: c.req.path,
        method: c.req.method,
        userId: user.id,
        farmId: user.farmId,
        role: user.role,
      }),
    )
  }
}

export function optionalAuth(c: Context<{ Variables: Partial<AppVariables> }>) {
  return getCookie(c, SESSION_COOKIE)
}
