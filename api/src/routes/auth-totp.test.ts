import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'

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
  resetLoginRateLimit: vi.fn(async () => undefined),
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
