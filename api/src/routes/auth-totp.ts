import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { randomBytes, createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { setCookie, getCookie } from 'hono/cookie'
import QRCode from 'qrcode'
import { db } from '../db/index.js'
import { users } from '../db/schema.js'
import { isBreakGlassEmail, verifyBreakGlassPassword } from '../lib/registration.js'
import {
  SESSION_COOKIE,
  createSession,
  getUserFromSession,
  hashIp,
  sessionCookieOptions,
  verifyPassword,
} from '../lib/session.js'
import { clientIpFromHeaders } from '../lib/client-ip.js'
import { generateCsrfToken, setCsrfCookie } from '../lib/csrf.js'
import { logAudit } from '../lib/audit.js'
import { logSecurityEvent } from '../lib/security-log.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { checkAuthMutationRateLimit, resetDurableRateLimit, staffLoginRateKey } from '../middleware/security.js'
import { requireRole } from '../lib/rbac.js'
import { authMutationKey, denyAuthMutation } from './auth-shared.js'
import {
  buildOtpAuthUrl,
  consumeTotpChallenge,
  generateSecret,
  invalidateTotpChallenge,
  peekTotpChallenge,
  checkTotpChallengeRateLimit,
  recordTotpChallengeFailure,
  resetTotpChallengeRateLimit,
  verifyTokenForUser,
} from '../lib/totp.js'
import { decryptSecretForVerify, encryptSecret } from '../lib/secret-box.js'

const totpCompleteLoginSchema = z.object({
  totpChallenge: z.string().min(20).max(512),
  token: z.string().trim().regex(/^\d{6}$/),
})

const totpCodeSchema = z.object({
  token: z.string().trim().regex(/^\d{6}$/),
})

const totpDisableSchema = z.object({
  token: z.string().trim().regex(/^\d{6}$/),
  password: z.string().min(8).max(128),
})

const useRecoveryCodeSchema = z.object({
  totpChallenge: z.string().min(20).max(512).optional(),
  token: z.string().trim().min(9).max(12),
  password: z.string().min(8).max(128).optional(),
})

const RECOVERY_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

function hashRecoveryCode(code: string): string {
  const normalized = code.replace(/[\s-]+/g, '').toUpperCase()
  return createHash('sha256').update(normalized).digest('hex')
}

function generateRecoveryCode(): string {
  const part = () =>
    Array.from({ length: 4 }, () => RECOVERY_CODE_CHARS[randomBytes(1)[0]! % RECOVERY_CODE_CHARS.length]).join('')
  return `${part()}-${part()}`
}

function generateRecoveryCodes(count = 8): { plaintext: string[]; hashes: string[] } {
  const plaintext: string[] = []
  const hashes: string[] = []
  const seen = new Set<string>()
  while (plaintext.length < count) {
    const code = generateRecoveryCode()
    const hash = hashRecoveryCode(code)
    if (seen.has(hash)) continue
    seen.add(hash)
    plaintext.push(code)
    hashes.push(hash)
  }
  return { plaintext, hashes }
}

async function verifyStoredTotpToken(userId: string, storedSecret: string, token: string): Promise<boolean> {
  const { plaintext, shouldReencrypt } = decryptSecretForVerify(storedSecret)
  const valid = verifyTokenForUser(userId, plaintext, token)
  if (valid && shouldReencrypt) {
    await db
      .update(users)
      .set({ totpSecret: encryptSecret(plaintext) })
      .where(eq(users.id, userId))
  }
  return valid
}

async function verifyAndConsumeRecoveryCode(
  userId: string,
  recoveryCode: string,
): Promise<{ ok: true; remaining: string[] } | { ok: false }> {
  const codeHash = hashRecoveryCode(recoveryCode)
  const [existing] = await db
    .select({ totpRecoveryCodes: users.totpRecoveryCodes })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)

  const stored = (existing?.totpRecoveryCodes as string[] | null) ?? []
  const index = stored.indexOf(codeHash)
  if (index === -1) return { ok: false }

  const remaining = stored.filter((_, i) => i !== index)
  await db.update(users).set({ totpRecoveryCodes: remaining }).where(eq(users.id, userId))
  return { ok: true, remaining }
}

type AuthApp = Hono<{ Variables: AppVariables }>

export function registerTotpRoutes(app: AuthApp) {
  app.post('/totp/complete-login', zValidator('json', totpCompleteLoginSchema), async (c) => {
    const ip = clientIpFromHeaders((name) => c.req.header(name))
    const userAgent = c.req.header('user-agent')
    const hashedIp = hashIp(ip)
    const { totpChallenge, token: totpToken } = c.req.valid('json')

    const rate = checkTotpChallengeRateLimit(totpChallenge, ip)
    if (!rate.allowed) {
      invalidateTotpChallenge(totpChallenge)
      c.header('Retry-After', String(rate.retryAfterSec))
      return c.json({ error: 'Too many failed attempts. Sign in again.' }, 429)
    }

    const challengedUserId = peekTotpChallenge(totpChallenge)
    if (!challengedUserId) {
      return c.json({ error: 'Session expired. Sign in again.' }, 401)
    }

    const [user] = await db.select().from(users).where(eq(users.id, challengedUserId)).limit(1)
    if (!user || !user.active || !user.totpEnabled || !user.totpSecret) {
      return c.json({ error: 'Invalid login challenge' }, 401)
    }

    if (!(await verifyStoredTotpToken(user.id, user.totpSecret, totpToken))) {
      const locked = recordTotpChallengeFailure(totpChallenge, ip)
      logSecurityEvent('failed_login', {
        reason: locked ? 'totp_rate_limited' : 'invalid_totp',
        userId: user.id,
        ip,
      })
      return c.json(
        { error: locked ? 'Too many failed attempts. Sign in again.' : 'Invalid authentication code' },
        locked ? 429 : 401,
      )
    }

    resetTotpChallengeRateLimit(totpChallenge, ip)
    consumeTotpChallenge(totpChallenge)
    await resetDurableRateLimit(staffLoginRateKey(ip))

    const sessionToken = await createSession(user.id, {
      userAgent,
      ipHash: hashedIp,
    })

    const secure = process.env.NODE_ENV === 'production'
    setCookie(c, SESSION_COOKIE, sessionToken, sessionCookieOptions(secure))
    setCsrfCookie(c, generateCsrfToken())

    if (isBreakGlassEmail(user.email)) {
      logSecurityEvent('break_glass_login', {
        userId: user.id,
        email: user.email,
        ip,
        via: 'totp',
      })
      await logAudit({
        farmId: user.farmId,
        userId: user.id,
        action: 'break_glass_login',
        entityType: 'session',
        metadata: { email: user.email, via: 'totp' },
      })
    }

    await logAudit({
      farmId: user.farmId,
      userId: user.id,
      action: 'login',
      entityType: 'session',
      metadata: { via: 'totp' },
    })

    return c.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        farmId: user.farmId,
        totpEnabled: user.totpEnabled,
        butlerTtsMode: user.butlerTtsMode,
        preferredLocale: user.preferredLocale,
      },
      mustChangePassword: isBreakGlassEmail(user.email) ? false : user.mustChangePassword,
    })
  })

  app.get('/totp/status', authMiddleware, async (c) => {
    const user = c.get('user')
    if (user.role !== 'owner') return c.json({ error: 'Forbidden' }, 403)

    const [existing] = await db
      .select({
        totpEnabled: users.totpEnabled,
        hasSecret: users.totpSecret,
      })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1)

    if (!existing) return c.json({ error: 'Unauthorized' }, 401)
    return c.json({
      enabled: existing.totpEnabled,
      hasSecret: !!existing.hasSecret,
    })
  })

  app.post('/totp/setup', authMiddleware, async (c) => {
    const user = c.get('user')
    try {
      requireRole(user, 'owner')
    } catch {
      return c.json({ error: 'Forbidden' }, 403)
    }

    const secret = generateSecret()
    await db
      .update(users)
      .set({ totpSecret: encryptSecret(secret), totpEnabled: false })
      .where(eq(users.id, user.id))

    const otpauthUrl = buildOtpAuthUrl({ secret, email: user.email, issuer: 'Trovara OS' })
    const qrUrl = await QRCode.toDataURL(otpauthUrl, { margin: 1, width: 256 })

    await logAudit({
      farmId: user.farmId,
      userId: user.id,
      action: 'totp_setup_started',
      entityType: 'security',
    })

    return c.json({
      secret,
      qrUrl,
      otpAuthUrl: otpauthUrl,
    })
  })

  app.post('/totp/enable', authMiddleware, zValidator('json', totpCodeSchema), async (c) => {
    const user = c.get('user')
    const mutation = checkAuthMutationRateLimit(authMutationKey(c, user.id))
    if (!mutation.allowed) return denyAuthMutation(c, mutation.retryAfterSec)

    try {
      requireRole(user, 'owner')
    } catch {
      return c.json({ error: 'Forbidden' }, 403)
    }
    const { token } = c.req.valid('json')

    const [existing] = await db
      .select({ totpSecret: users.totpSecret })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1)

    if (!existing?.totpSecret) {
      return c.json({ error: 'Run setup first' }, 400)
    }
    if (!(await verifyStoredTotpToken(user.id, existing.totpSecret, token))) {
      return c.json({ error: 'Invalid authentication code' }, 400)
    }

    const { plaintext, hashes } = generateRecoveryCodes()
    await db
      .update(users)
      .set({ totpEnabled: true, totpRecoveryCodes: hashes })
      .where(eq(users.id, user.id))

    await logAudit({
      farmId: user.farmId,
      userId: user.id,
      action: 'totp_enabled',
      entityType: 'security',
    })

    return c.json({ ok: true, enabled: true, recoveryCodes: plaintext })
  })

  app.post('/totp/disable', authMiddleware, zValidator('json', totpDisableSchema), async (c) => {
    const user = c.get('user')
    const mutation = checkAuthMutationRateLimit(authMutationKey(c, user.id))
    if (!mutation.allowed) return denyAuthMutation(c, mutation.retryAfterSec)

    try {
      requireRole(user, 'owner')
    } catch {
      return c.json({ error: 'Forbidden' }, 403)
    }
    const { token, password } = c.req.valid('json')

    const [existing] = await db
      .select({
        passwordHash: users.passwordHash,
        totpSecret: users.totpSecret,
        totpEnabled: users.totpEnabled,
      })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1)

    if (!existing) return c.json({ error: 'Unauthorized' }, 401)
    const validPassword = isBreakGlassEmail(user.email)
      ? verifyBreakGlassPassword(password)
      : await verifyPassword(existing.passwordHash, password)
    if (!validPassword) return c.json({ error: 'Current password is incorrect' }, 400)
    if (!existing.totpSecret || !existing.totpEnabled) {
      return c.json({ error: '2FA is not enabled' }, 400)
    }
    if (!(await verifyStoredTotpToken(user.id, existing.totpSecret, token))) {
      return c.json({ error: 'Invalid authentication code' }, 400)
    }

    await db
      .update(users)
      .set({ totpEnabled: false, totpSecret: null, totpRecoveryCodes: null })
      .where(eq(users.id, user.id))

    await logAudit({
      farmId: user.farmId,
      userId: user.id,
      action: 'totp_disabled',
      entityType: 'security',
    })

    return c.json({ ok: true, enabled: false })
  })

  app.post('/totp/use-recovery-code', zValidator('json', useRecoveryCodeSchema), async (c) => {
    const ip = clientIpFromHeaders((name) => c.req.header(name))
    const userAgent = c.req.header('user-agent')
    const hashedIp = hashIp(ip)
    const { totpChallenge, token: recoveryCode, password } = c.req.valid('json')

    if (totpChallenge) {
      const rate = checkTotpChallengeRateLimit(totpChallenge, ip)
      if (!rate.allowed) {
        invalidateTotpChallenge(totpChallenge)
        c.header('Retry-After', String(rate.retryAfterSec))
        return c.json({ error: 'Too many failed attempts. Sign in again.' }, 429)
      }

      const challengedUserId = peekTotpChallenge(totpChallenge)
      if (!challengedUserId) {
        return c.json({ error: 'Session expired. Sign in again.' }, 401)
      }

      const [user] = await db.select().from(users).where(eq(users.id, challengedUserId)).limit(1)
      if (!user || !user.active || !user.totpEnabled) {
        return c.json({ error: 'Invalid login challenge' }, 401)
      }

      const verified = await verifyAndConsumeRecoveryCode(user.id, recoveryCode)
      if (!verified.ok) {
        const locked = recordTotpChallengeFailure(totpChallenge, ip)
        return c.json(
          { error: locked ? 'Too many failed attempts. Sign in again.' : 'Invalid recovery code' },
          locked ? 429 : 401,
        )
      }

      resetTotpChallengeRateLimit(totpChallenge, ip)
      consumeTotpChallenge(totpChallenge)
      await resetDurableRateLimit(staffLoginRateKey(ip))

      const sessionToken = await createSession(user.id, {
        userAgent,
        ipHash: hashedIp,
      })
      const secure = process.env.NODE_ENV === 'production'
      setCookie(c, SESSION_COOKIE, sessionToken, sessionCookieOptions(secure))
      setCsrfCookie(c, generateCsrfToken())

      await logAudit({
        farmId: user.farmId,
        userId: user.id,
        action: 'login',
        entityType: 'session',
        metadata: { via: 'recovery_code' },
      })

      return c.json({
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          farmId: user.farmId,
          totpEnabled: user.totpEnabled,
          butlerTtsMode: user.butlerTtsMode,
          preferredLocale: user.preferredLocale,
        },
        mustChangePassword: isBreakGlassEmail(user.email) ? false : user.mustChangePassword,
        recoveryCodesRemaining: verified.remaining.length,
      })
    }

    const sessionToken = getCookie(c, SESSION_COOKIE)
    const sessionUser = sessionToken ? await getUserFromSession(sessionToken) : null
    if (!sessionUser) return c.json({ error: 'Unauthorized' }, 401)
    if (sessionUser.role !== 'owner') return c.json({ error: 'Forbidden' }, 403)
    if (!password) return c.json({ error: 'Password is required' }, 400)

    const mutation = checkAuthMutationRateLimit(authMutationKey(c, sessionUser.id))
    if (!mutation.allowed) return denyAuthMutation(c, mutation.retryAfterSec)

    const [existing] = await db
      .select({
        passwordHash: users.passwordHash,
        totpEnabled: users.totpEnabled,
      })
      .from(users)
      .where(eq(users.id, sessionUser.id))
      .limit(1)

    if (!existing?.totpEnabled) return c.json({ error: '2FA is not enabled' }, 400)
    const validPassword = isBreakGlassEmail(sessionUser.email)
      ? verifyBreakGlassPassword(password)
      : await verifyPassword(existing.passwordHash, password)
    if (!validPassword) return c.json({ error: 'Current password is incorrect' }, 400)

    const verified = await verifyAndConsumeRecoveryCode(sessionUser.id, recoveryCode)
    if (!verified.ok) return c.json({ error: 'Invalid recovery code' }, 401)

    await db
      .update(users)
      .set({ totpEnabled: false, totpSecret: null, totpRecoveryCodes: null })
      .where(eq(users.id, sessionUser.id))

    await logAudit({
      farmId: sessionUser.farmId,
      userId: sessionUser.id,
      action: 'totp_disabled',
      entityType: 'security',
      metadata: { via: 'recovery_code' },
    })

    return c.json({ ok: true, enabled: false, recoveryCodesRemaining: verified.remaining.length })
  })

  app.post('/totp/regenerate-recovery-codes', authMiddleware, zValidator('json', totpCodeSchema), async (c) => {
    const user = c.get('user')
    const mutation = checkAuthMutationRateLimit(authMutationKey(c, user.id))
    if (!mutation.allowed) return denyAuthMutation(c, mutation.retryAfterSec)

    try {
      requireRole(user, 'owner')
    } catch {
      return c.json({ error: 'Forbidden' }, 403)
    }
    const { token } = c.req.valid('json')

    const [existing] = await db
      .select({ totpSecret: users.totpSecret, totpEnabled: users.totpEnabled })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1)

    if (!existing?.totpEnabled || !existing.totpSecret) {
      return c.json({ error: '2FA is not enabled' }, 400)
    }
    if (!(await verifyStoredTotpToken(user.id, existing.totpSecret, token))) {
      return c.json({ error: 'Invalid authentication code' }, 400)
    }

    const { plaintext, hashes } = generateRecoveryCodes()
    await db.update(users).set({ totpRecoveryCodes: hashes }).where(eq(users.id, user.id))

    await logAudit({
      farmId: user.farmId,
      userId: user.id,
      action: 'totp_recovery_codes_regenerated',
      entityType: 'security',
    })

    return c.json({ ok: true, recoveryCodes: plaintext })
  })
}
