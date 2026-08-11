import { Hono } from 'hono'
import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../db/index.js', () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
  },
}))

vi.mock('../lib/session.js', () => ({
  SESSION_COOKIE: 'trovara_session',
  createSession: vi.fn(),
  getUserFromSession: vi.fn(),
  hashIp: vi.fn(() => 'ip'),
  sessionCookieOptions: () => ({}),
  verifyPassword: vi.fn(),
}))

vi.mock('../lib/totp.js', () => ({
  buildOtpAuthUrl: vi.fn(),
  consumeTotpChallenge: vi.fn(),
  generateSecret: vi.fn(),
  invalidateTotpChallenge: vi.fn(),
  peekTotpChallenge: vi.fn(),
  checkTotpChallengeRateLimit: vi.fn(() => ({ allowed: true })),
  recordTotpChallengeFailure: vi.fn(),
  resetTotpChallengeRateLimit: vi.fn(),
  verifyTokenForUser: vi.fn(),
}))

vi.mock('../lib/secret-box.js', () => ({
  decryptSecretForVerify: vi.fn(),
  encryptSecret: vi.fn(),
}))

vi.mock('../middleware/auth.js', () => ({
  authMiddleware: async (_c: unknown, next: () => Promise<void>) => next(),
}))

vi.mock('../middleware/security.js', () => ({
  checkAuthMutationRateLimit: vi.fn(() => ({ allowed: true })),
  resetDurableRateLimit: vi.fn(async () => undefined),
  resetLoginRateLimit: vi.fn(async () => undefined),
  staffLoginRateKey: vi.fn(() => 'login-key'),
}))

vi.mock('../lib/csrf.js', () => ({
  generateCsrfToken: vi.fn(() => 'csrf'),
  setCsrfCookie: vi.fn(),
}))

vi.mock('../lib/audit.js', () => ({
  logAudit: vi.fn(),
}))

vi.mock('../lib/security-log.js', () => ({
  logSecurityEvent: vi.fn(),
}))

vi.mock('../lib/registration.js', () => ({
  isBreakGlassEmail: () => false,
  verifyBreakGlassPassword: vi.fn(),
}))

vi.mock('../lib/rbac.js', () => ({
  hasPermission: vi.fn(() => true),
  requirePermission: vi.fn(),
  requireRole: vi.fn(),
}))

vi.mock('qrcode', () => ({
  default: { toDataURL: vi.fn(async () => 'data:image/png;base64,xx') },
}))

describe('registerTotpRoutes', () => {
  it('mounts all /totp/* routes on the auth app', async () => {
    const { registerTotpRoutes } = await import('../routes/auth-totp.js')
    const app = new Hono()
    registerTotpRoutes(app as never)

    const paths = app.routes.map((r) => `${r.method} ${r.path}`).sort()
    expect(paths).toEqual(
      expect.arrayContaining([
        'POST /totp/complete-login',
        'GET /totp/status',
        'POST /totp/setup',
        'POST /totp/enable',
        'POST /totp/disable',
        'POST /totp/use-recovery-code',
        'POST /totp/regenerate-recovery-codes',
      ]),
    )
  })
})

describe('TOTP recovery code consumption', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    const { db } = await import('../db/index.js')
    const hash = createHash('sha256').update('ABCD2345').digest('hex')
    vi.mocked(db.select).mockImplementation(() => {
      const query: Record<string, unknown> = {}
      const same = () => query
      Object.assign(query, {
        from: same,
        where: same,
        limit: same,
        then: (resolve: (value: unknown[]) => unknown) =>
          Promise.resolve([{ totpRecoveryCodes: [hash] }]).then(resolve),
      })
      return query as never
    })

    let claimed = false
    vi.mocked(db.update).mockImplementation(() => ({
      set: () => ({
        where: () => ({
          returning: async () => {
            if (claimed) return []
            claimed = true
            return [{ id: 'user-1' }]
          },
        }),
      }),
    }) as never)
  })

  it('allows only one concurrent use of the same recovery code', async () => {
    const { verifyAndConsumeRecoveryCode } = await import('../routes/auth-totp.js')
    const results = await Promise.all([
      verifyAndConsumeRecoveryCode('user-1', 'ABCD-2345'),
      verifyAndConsumeRecoveryCode('user-1', 'ABCD-2345'),
    ])

    expect(results.filter((result) => result.ok)).toHaveLength(1)
    expect(results.filter((result) => !result.ok)).toHaveLength(1)
  })
})
