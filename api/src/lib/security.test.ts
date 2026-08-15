import { describe, expect, it, beforeEach, vi } from 'vitest'

process.env.DATABASE_URL ??= 'postgresql://test:test@127.0.0.1:5432/test'

import type { SessionUser } from './session.js'
import { hasRole, requireRole } from './rbac.js'
import { generateCsrfToken, isCsrfExemptPath } from './csrf.js'
import { secureCompare, secureCompareSecret } from './secure-compare.js'
import { isPasswordChangeExemptPath } from '../middleware/auth.js'
import { checkRateLimit, resetRateLimitBucket } from './rate-limit.js'
import {
  checkMutationRateLimit,
  resetMutationRateLimit,
  resetAuthMutationRateLimit,
} from '../middleware/security.js'

const getUserFromSessionMock = vi.hoisted(() => vi.fn())

vi.mock('hono/cookie', () => ({
  getCookie: vi.fn(() => 'test-session-token'),
  setCookie: vi.fn(),
  deleteCookie: vi.fn(),
}))

vi.mock('./session.js', () => ({
  SESSION_COOKIE: 'trovara_session',
  getUserFromSession: getUserFromSessionMock,
}))

function user(role: SessionUser['role']): SessionUser {
  return {
    id: 'u-1',
    farmId: 'farm-1',
    email: 'owner@trovara.farm',
    name: 'Owner',
    role,
    mustChangePassword: false,
  }
}

describe('RBAC negative checks', () => {
  it('rejects disallowed role on requireRole', () => {
    expect(() => requireRole(user('field_worker'), 'owner')).toThrow('FORBIDDEN')
  })

  it('returns false when role does not match', () => {
    expect(hasRole(user('supervisor'), 'owner')).toBe(false)
  })
})

describe('CSRF token generation', () => {
  it('returns non-empty random-looking tokens', () => {
    const a = generateCsrfToken()
    const b = generateCsrfToken()
    expect(a).not.toEqual(b)
    expect(a.length).toBeGreaterThan(30)
    expect(/^[A-Za-z0-9_-]+$/.test(a)).toBe(true)
  })
})

describe('rate-limit checks', () => {
  beforeEach(() => {
    resetRateLimitBucket()
    resetMutationRateLimit()
    resetAuthMutationRateLimit()
  })

  it('checkRateLimit allows then denies beyond max', () => {
    const key = 'test-user'
    expect(checkRateLimit(key, 2, 60_000).allowed).toBe(true)
    expect(checkRateLimit(key, 2, 60_000).allowed).toBe(true)
    const denied = checkRateLimit(key, 2, 60_000)
    expect(denied.allowed).toBe(false)
    expect(denied.retryAfterSec).toBeGreaterThan(0)
  })

  it('checkMutationRateLimit allows 120 and denies 121st', () => {
    const key = 'user:abc'
    for (let i = 0; i < 120; i += 1) {
      expect(checkMutationRateLimit(key).allowed).toBe(true)
    }
    const denied = checkMutationRateLimit(key)
    expect(denied.allowed).toBe(false)
    expect(denied.retryAfterSec).toBeGreaterThan(0)
  })
})

describe('secureCompare', () => {
  it('returns true for equal strings', () => {
    expect(secureCompare('abc123', 'abc123')).toBe(true)
  })

  it('returns false when lengths differ', () => {
    expect(secureCompare('short', 'longer-value')).toBe(false)
  })

  it('returns false for same-length mismatches', () => {
    expect(secureCompare('abc123', 'abc124')).toBe(false)
  })
})

describe('secureCompareSecret', () => {
  it('returns true for equal secrets of any length', () => {
    expect(secureCompareSecret('short', 'short')).toBe(true)
    expect(secureCompareSecret('longer-break-glass', 'longer-break-glass')).toBe(true)
  })

  it('returns false when values or lengths differ', () => {
    expect(secureCompareSecret('short', 'longer-value')).toBe(false)
    expect(secureCompareSecret('abc123', 'abc124')).toBe(false)
  })
})

describe('CSRF exempt pre-auth paths', () => {
  it('exempts login, register, and password reset routes', () => {
    expect(isCsrfExemptPath('/auth/login')).toBe(true)
    expect(isCsrfExemptPath('/auth/register')).toBe(true)
    expect(isCsrfExemptPath('/auth/totp/complete-login')).toBe(true)
    expect(isCsrfExemptPath('/auth/forgot-password')).toBe(true)
    expect(isCsrfExemptPath('/auth/reset-password')).toBe(true)
    expect(isCsrfExemptPath('/auth/totp/use-recovery-code')).toBe(true)
  })

  it('exempts cron routes authenticated by x-cron-secret', () => {
    expect(isCsrfExemptPath('/api/system/run-retention')).toBe(true)
    expect(isCsrfExemptPath('/api/alerts/run-proactive')).toBe(true)
    expect(isCsrfExemptPath('/api/alerts/evening-digest')).toBe(true)
    expect(isCsrfExemptPath('/api/alerts/run-health-sla')).toBe(true)
  })

  it('exempts staff and customer Telegram webhooks', () => {
    expect(isCsrfExemptPath('/api/telegram/webhook')).toBe(true)
    expect(isCsrfExemptPath('/api/telegram/customer/webhook')).toBe(true)
    expect(isCsrfExemptPath('/api/whatsapp/webhook')).toBe(true)
    expect(isCsrfExemptPath('/api/paystack/webhook')).toBe(true)
  })

  it('exempts public token-authorized newsletter routes', () => {
    expect(isCsrfExemptPath('/public/newsletter/subscribe')).toBe(true)
    expect(isCsrfExemptPath('/public/newsletter/confirm')).toBe(true)
    expect(isCsrfExemptPath('/public/newsletter/unsubscribe')).toBe(true)
    expect(isCsrfExemptPath('/public/newsletter/webhook')).toBe(true)
    expect(isCsrfExemptPath('/public/newsletter/webhook/')).toBe(true)
  })

  it('exempts exactly the public marketing lead submissions', () => {
    expect(isCsrfExemptPath('/public/leads/contact')).toBe(true)
    expect(isCsrfExemptPath('/public/leads/waitlist')).toBe(true)
    expect(isCsrfExemptPath('/public/leads')).toBe(false)
    expect(isCsrfExemptPath('/public/leads/contact/extra')).toBe(false)
    expect(isCsrfExemptPath('/public/surveys')).toBe(true)
    expect(isCsrfExemptPath('/public/surveys/extra')).toBe(false)
  })

  it('exempts only the anonymous Journal engagement mutations', () => {
    expect(isCsrfExemptPath('/public/journal/field-note/like')).toBe(true)
    expect(isCsrfExemptPath('/public/journal/field-note/comments')).toBe(true)
    expect(isCsrfExemptPath('/public/journal/field-note')).toBe(false)
    expect(isCsrfExemptPath('/public/journal/field-note/comments/extra')).toBe(false)
  })

  it('exempts customer shop unauthenticated routes', () => {
    expect(isCsrfExemptPath('/shop/register')).toBe(true)
    expect(isCsrfExemptPath('/shop/login')).toBe(true)
    expect(isCsrfExemptPath('/shop/forgot-password')).toBe(true)
    expect(isCsrfExemptPath('/shop/reset-password')).toBe(true)
    expect(isCsrfExemptPath('/shop/verify-email')).toBe(true)
    expect(isCsrfExemptPath('/shop/resend-verification')).toBe(true)
  })

  it('requires CSRF for customer shop authenticated routes', () => {
    expect(isCsrfExemptPath('/shop/orders')).toBe(false)
    expect(isCsrfExemptPath('/shop/logout')).toBe(false)
    expect(isCsrfExemptPath('/shop/me')).toBe(false)
  })

  it('exempts brand pack unlock paths authorized by share token', () => {
    expect(isCsrfExemptPath('/public/brand/abc123/unlock')).toBe(true)
    expect(isCsrfExemptPath('/public/brand/abc123/items')).toBe(false)
  })

  it('does not CSRF-exempt brand kit upload paths', () => {
    expect(isCsrfExemptPath('/api/brand/assets/upload')).toBe(false)
    expect(
      isCsrfExemptPath('/api/brand/assets/upload/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
    ).toBe(false)
  })

  it('does not exempt protected API routes', () => {
    expect(isCsrfExemptPath('/api/tasks')).toBe(false)
    expect(isCsrfExemptPath('/auth/change-password')).toBe(false)
  })
})

describe('mustChangePassword gate', () => {
  const mustChangeUser: SessionUser = {
    id: 'u-must-change',
    farmId: 'farm-1',
    email: 'worker@trovara.farm',
    name: 'Worker',
    role: 'field_worker',
    mustChangePassword: true,
  }

  it('allows password-change exempt auth paths', () => {
    expect(isPasswordChangeExemptPath('/auth/me')).toBe(true)
    expect(isPasswordChangeExemptPath('/auth/change-password')).toBe(true)
    expect(isPasswordChangeExemptPath('/auth/logout')).toBe(true)
  })

  it('blocks non-exempt routes such as /api/tasks', async () => {
    getUserFromSessionMock.mockResolvedValueOnce(mustChangeUser)
    const { authMiddleware } = await import('../middleware/auth.js')
    const next = vi.fn(async () => undefined)
    const json = vi.fn((body: unknown, status?: number) => new Response(JSON.stringify(body), { status: status ?? 200 }))
    const context = {
      req: {
        path: '/api/tasks',
        method: 'GET',
        header: () => undefined,
      },
      json,
      set: vi.fn(),
      get: vi.fn(),
      res: { status: 200 },
    }

    await authMiddleware(context as any, next)

    expect(next).not.toHaveBeenCalled()
    expect(json).toHaveBeenCalledWith({ error: 'Password change required' }, 403)
  })
})

describe('looksUrgent patterns', () => {
  it('flags urgent incident phrases', async () => {
    process.env.DATABASE_URL ??= 'postgresql://test:test@127.0.0.1:5432/test'
    const { looksUrgent } = await import('./farm-notify.js')
    expect(looksUrgent('Many birds died in pen B this morning')).toBe(true)
    expect(looksUrgent('There is a fire near the feed store')).toBe(true)
  })

  it('does not flag normal operational updates', async () => {
    process.env.DATABASE_URL ??= 'postgresql://test:test@127.0.0.1:5432/test'
    const { looksUrgent } = await import('./farm-notify.js')
    expect(looksUrgent('Feed delivered successfully for tomorrow')).toBe(false)
    expect(looksUrgent('Completed weeding and watering in zone C')).toBe(false)
  })
})
