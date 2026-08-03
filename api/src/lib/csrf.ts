import { randomBytes } from 'node:crypto'
import type { Context, Next } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { logSecurityEvent } from './security-log.js'
import { secureCompare } from './secure-compare.js'
import { withAccessMeta } from './request-access-meta.js'

export const CSRF_COOKIE = 'trovara_csrf'
export const CSRF_HEADER = 'X-CSRF-Token'

const MUTATING_METHODS = new Set(['POST', 'PATCH', 'DELETE'])

/** Keep in sync with CUSTOMER_SESSION_COOKIE in customer-accounts.ts */
const CUSTOMER_SESSION_COOKIE = 'trovara_customer_session'

/** Shop mutations that require a customer session; guests should get 401, not CSRF 403. */
const CUSTOMER_SESSION_MUTATION_PATHS = new Set([
  '/shop/orders',
  '/shop/logout',
  '/shop/link-code',
])

// Webhooks are authenticated by their own mechanisms (Meta HMAC signature,
// Telegram secret token) - they carry no cookies, so CSRF doesn't apply.
export const CSRF_EXEMPT_PATHS = new Set([
  '/auth/login',
  '/auth/register',
  '/auth/totp/complete-login',
  '/auth/forgot-password',
  '/auth/reset-password',
  '/auth/totp/use-recovery-code',
  '/shop/register',
  '/shop/login',
  '/shop/forgot-password',
  '/shop/reset-password',
  '/shop/verify-email',
  '/shop/resend-verification',
  // Public double-opt-in actions carry no staff session cookie. Confirmation
  // and unsubscribe are authorized by high-entropy, single-purpose tokens;
  // the Resend webhook verifies its Svix signature.
  '/public/newsletter/subscribe',
  '/public/newsletter/confirm',
  '/public/newsletter/unsubscribe',
  '/public/newsletter/webhook',
  // Public marketing forms carry no staff session cookie. They are protected
  // with per-IP limits, strict validation, and honeypots.
  '/public/leads/contact',
  '/public/leads/waitlist',
  '/health',
  '/api/whatsapp/webhook',
  '/api/telegram/webhook',
  '/api/telegram/customer/webhook',
  '/api/paystack/webhook',
  '/api/system/run-retention',
  '/api/alerts/run-proactive',
  '/api/alerts/evening-digest',
])

export function isCsrfExemptPath(path: string): boolean {
  return CSRF_EXEMPT_PATHS.has(path)
}

export function generateCsrfToken(): string {
  return randomBytes(32).toString('base64url')
}

export function csrfCookieOptions(secure: boolean) {
  return {
    httpOnly: false,
    secure,
    sameSite: 'Strict' as const,
    path: '/',
    maxAge: 7 * 24 * 60 * 60,
  }
}

export function setCsrfCookie(c: Context, token: string) {
  const secure = process.env.NODE_ENV === 'production'
  setCookie(c, CSRF_COOKIE, token, csrfCookieOptions(secure))
}

export async function csrfMiddleware(c: Context, next: Next) {
  const method = c.req.method.toUpperCase()

  if (!MUTATING_METHODS.has(method) || isCsrfExemptPath(c.req.path)) {
    await next()
    return
  }

  // Unauthenticated shop mutations: defer to the route (401) instead of CSRF 403.
  if (
    CUSTOMER_SESSION_MUTATION_PATHS.has(c.req.path) &&
    !getCookie(c, CUSTOMER_SESSION_COOKIE)
  ) {
    await next()
    return
  }

  const cookieToken = getCookie(c, CSRF_COOKIE)
  const headerToken = c.req.header(CSRF_HEADER)

  if (!cookieToken || !headerToken || !secureCompare(cookieToken, headerToken)) {
    logSecurityEvent(
      'csrf_failure',
      withAccessMeta((name) => c.req.header(name), {
        method: c.req.method,
        path: c.req.path,
        hasCookie: Boolean(cookieToken),
        hasHeader: Boolean(headerToken),
      }),
    )
    return c.json({ error: 'Invalid or missing CSRF token' }, 403)
  }

  await next()
}
