import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, unknown>

let sessionUser: Row = {
  id: 'user-owner',
  farmId: 'farm-1',
  role: 'owner',
  email: 'owner@trovara.farm',
}

const selectRow: Row = {
  butlerTtsMode: 'off',
  orderAlertsSubscribed: false,
  workerAlertsSubscribed: false,
  preferredLocale: 'en',
}

const updates: { patch: Row; where: unknown }[] = []

vi.mock('drizzle-orm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('drizzle-orm')>()),
  // Marker instead of SQL so tests can assert which row a write targets.
  eq: (column: unknown, value: unknown) => ({ __eq: [column, value] }),
}))

vi.mock('../db/index.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => [selectRow] }),
      }),
    }),
    update: () => ({
      set: (patch: Row) => ({
        where: async (where: unknown) => {
          updates.push({ patch, where })
        },
      }),
    }),
  },
}))

vi.mock('../middleware/auth.js', () => ({
  authMiddleware: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set('user', sessionUser)
    await next()
  },
}))

vi.mock('../middleware/security.js', () => ({
  checkAuthMutationRateLimit: vi.fn(() => ({ allowed: true, retryAfterSec: 0 })),
  checkLoginRateLimit: vi.fn(() => true),
  resetLoginRateLimit: vi.fn(),
}))

vi.mock('../routes/auth-totp.js', () => ({ registerTotpRoutes: () => undefined }))

vi.mock('../lib/session.js', () => ({
  SESSION_COOKIE: 'trovara_session',
  countActiveSessions: vi.fn(async () => 1),
  createSession: vi.fn(),
  deleteSession: vi.fn(),
  getDummyPasswordHash: vi.fn(),
  hashIp: vi.fn(() => 'ip'),
  hashPassword: vi.fn(),
  listActiveSessions: vi.fn(async () => []),
  revokeOtherSessions: vi.fn(),
  revokeSessionById: vi.fn(),
  sessionCookieOptions: () => ({}),
  verifyPassword: vi.fn(),
}))

vi.mock('../lib/csrf.js', () => ({
  CSRF_COOKIE: 'trovara_csrf',
  generateCsrfToken: vi.fn(() => 'csrf'),
  setCsrfCookie: vi.fn(),
}))

vi.mock('../lib/audit.js', () => ({ logAudit: vi.fn() }))
vi.mock('../lib/security-log.js', () => ({ logSecurityEvent: vi.fn() }))
vi.mock('../lib/break-glass.js', () => ({ ensureBreakGlassOwner: vi.fn() }))
vi.mock('../lib/totp.js', () => ({ createTotpChallenge: vi.fn() }))
vi.mock('../lib/notifications.js', () => ({
  deliverPasswordReset: vi.fn(),
  requiredDeliveryFailed: vi.fn(() => false),
}))
vi.mock('../lib/registration.js', () => ({
  isBreakGlassEmail: () => false,
  normalizeRegisterEmail: (v: string) => v,
  normalizeRegisterPhone: (v: string) => v,
  registerBodySchema: { safeParse: () => ({ success: true, data: {} }) },
  validateRegistrationSecret: () => ({ ok: false, reason: 'disabled' }),
  verifyBreakGlassPassword: vi.fn(),
}))

async function patchPreferences(body: unknown) {
  const { authRoutes } = await import('./auth.js')
  const app = new Hono()
  app.route('/auth', authRoutes)
  return app.request('/auth/preferences', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('PATCH /auth/preferences - preferredLocale', () => {
  beforeEach(() => {
    updates.length = 0
    sessionUser = {
      id: 'user-owner',
      farmId: 'farm-1',
      role: 'owner',
      email: 'owner@trovara.farm',
    }
  })

  it.each(['en', 'yo', 'pcm', 'fr'])('accepts the supported locale %s', async (locale) => {
    const res = await patchPreferences({ preferredLocale: locale })
    expect(res.status).toBe(200)
    expect(updates).toHaveLength(1)
    expect(updates[0]?.patch).toEqual({
      preferredLocale: locale,
      preferredLocaleSetAt: expect.any(Date),
    })
  })

  // Setting a language here is an answer, so Butler must stop asking for one.
  it('records that the language was chosen, not defaulted', async () => {
    const before = Date.now()
    await patchPreferences({ preferredLocale: 'fr' })
    const setAt = updates[0]?.patch.preferredLocaleSetAt as Date
    expect(setAt.getTime()).toBeGreaterThanOrEqual(before)
  })

  it('leaves the marker alone when the patch does not touch language', async () => {
    await patchPreferences({ butlerTtsMode: 'always' })
    expect(updates[0]?.patch).not.toHaveProperty('preferredLocaleSetAt')
  })

  it.each(['de', 'EN', 'en-GB', '', 'pidgin', 1, null])(
    'rejects the unsupported locale %j',
    async (locale) => {
      const res = await patchPreferences({ preferredLocale: locale })
      expect(res.status).toBe(400)
      expect(updates).toHaveLength(0)
    },
  )

  it('writes only to the authenticated user, ignoring a target user id in the body', async () => {
    const { users } = await import('../db/schema.js')
    const res = await patchPreferences({ preferredLocale: 'fr', userId: 'victim', id: 'victim' })

    expect(res.status).toBe(200)
    expect(updates[0]?.patch).toEqual({ preferredLocale: 'fr', preferredLocaleSetAt: expect.any(Date) })
    expect(updates[0]?.where).toEqual({ __eq: [users.id, 'user-owner'] })
  })

  it('lets non-owner staff set their own language', async () => {
    sessionUser = { id: 'user-worker', farmId: 'farm-1', role: 'field_worker', email: 'w@x.co' }
    const res = await patchPreferences({ preferredLocale: 'yo' })
    expect(res.status).toBe(200)
    expect(updates[0]?.patch).toEqual({ preferredLocale: 'yo', preferredLocaleSetAt: expect.any(Date) })
  })

  it('keeps butler and alert preferences owner-only', async () => {
    sessionUser = { id: 'user-worker', farmId: 'farm-1', role: 'field_worker', email: 'w@x.co' }
    const res = await patchPreferences({ preferredLocale: 'yo', butlerTtsMode: 'always' })
    expect(res.status).toBe(403)
    expect(updates).toHaveLength(0)

    const alertsRes = await patchPreferences({ orderAlertsSubscribed: true })
    expect(alertsRes.status).toBe(403)
    expect(updates).toHaveLength(0)
  })

  it('still rejects an empty patch and requires auth', async () => {
    expect((await patchPreferences({})).status).toBe(400)

    sessionUser = { id: 'user-worker', farmId: 'farm-1', role: 'sales', email: 's@x.co' }
    expect((await patchPreferences({})).status).toBe(403)
    expect(updates).toHaveLength(0)
  })

  it('updates language alongside owner preferences in one patch', async () => {
    const res = await patchPreferences({ preferredLocale: 'fr', butlerTtsMode: 'always' })
    expect(res.status).toBe(200)
    expect(updates[0]?.patch).toEqual({
      butlerTtsMode: 'always',
      preferredLocale: 'fr',
      preferredLocaleSetAt: expect.any(Date),
    })
  })
})
