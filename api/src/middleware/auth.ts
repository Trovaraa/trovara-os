import type { Context, Next } from 'hono'
import { getCookie } from 'hono/cookie'
import { SESSION_COOKIE, getUserFromSession, type SessionUser } from '../lib/session.js'
import { logSecurityEvent } from '../lib/security-log.js'

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

  c.set('user', user)
  await next()
  if (c.res.status === 403) {
    logSecurityEvent('forbidden_access', {
      path: c.req.path,
      method: c.req.method,
      userId: user.id,
      farmId: user.farmId,
      role: user.role,
    })
  }
}

export function optionalAuth(c: Context<{ Variables: Partial<AppVariables> }>) {
  return getCookie(c, SESSION_COOKIE)
}
