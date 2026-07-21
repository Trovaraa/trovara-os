import { describe, expect, it, beforeEach, vi } from 'vitest'

process.env.DATABASE_URL ??= 'postgresql://test:test@127.0.0.1:5432/test'

import type { SessionUser } from './session.js'
import { hasRole, requireRole } from './rbac.js'
import { generateCsrfToken, isCsrfExemptPath } from './csrf.js'
import { secureCompare } from './secure-compare.js'
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
  })

  it('exempts staff and customer Telegram webhooks', () => {
    expect(isCsrfExemptPath('/api/telegram/webhook')).toBe(true)
    expect(isCsrfExemptPath('/api/telegram/customer/webhook')).toBe(true)
    expect(isCsrfExemptPath('/api/whatsapp/webhook')).toBe(true)
    expect(isCsrfExemptPath('/api/paystack/webhook')).toBe(true)
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
