import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { randomBytes, createHash } from 'node:crypto'
import { and, eq, gt, isNull } from 'drizzle-orm'
import { setCookie, deleteCookie, getCookie } from 'hono/cookie'
import QRCode from 'qrcode'
import { db } from '../db/index.js'
import { consentRecords, farms, passwordResetTokens, users } from '../db/schema.js'
import { CONSENT_TYPES, CURRENT_CONSENT_VERSION } from '../lib/consent.js'
import {
  isBreakGlassEmail,
  normalizeRegisterEmail,
  normalizeRegisterPhone,
  registerBodySchema,
  validateRegistrationSecret,
} from '../lib/registration.js'
import {
  SESSION_COOKIE,
  countActiveSessions,
  createSession,
  deleteSession,
  getDummyPasswordHash,
  getUserFromSession,
  hashIp,
  hashPassword,
  listActiveSessions,
  revokeOtherSessions,
  revokeSessionById,
  sessionCookieOptions,
  verifyPassword,
} from '../lib/session.js'
import { clientIpFromHeaders } from '../lib/client-ip.js'
import { generateCsrfToken, setCsrfCookie, CSRF_COOKIE } from '../lib/csrf.js'
import { logAudit } from '../lib/audit.js'
import { logSecurityEvent } from '../lib/security-log.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { checkLoginRateLimit, checkAuthMutationRateLimit, resetLoginRateLimit } from '../middleware/security.js'
import { requireRole } from '../lib/rbac.js'
import {
  buildOtpAuthUrl,
  consumeTotpChallenge,
  createTotpChallenge,
  generateSecret,
  invalidateTotpChallenge,
  peekTotpChallenge,
  checkTotpChallengeRateLimit,
  recordTotpChallengeFailure,
  resetTotpChallengeRateLimit,
  verifyTokenForUser,
} from '../lib/totp.js'
import { decryptSecretForVerify, encryptSecret } from '../lib/secret-box.js'
import { deliverPasswordReset, requiredDeliveryFailed } from '../lib/notifications.js'

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
})

const forgotPasswordSchema = z.object({
  email: z.string().email(),
})

const resetPasswordSchema = z.object({
  token: z.string().min(20).max(512),
  password: z.string().min(8).max(128).optional(),
  newPassword: z.string().min(8).max(128).optional(),
})

const changePasswordSchema = z.object({
  currentPassword: z.string().min(8).max(128),
  newPassword: z.string().min(8).max(128),
})

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

const updatePreferencesSchema = z.object({
  butlerTtsMode: z.enum(['off', 'voice_replies', 'always']),
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

function authMutationKey(c: { req: { header: (name: string) => string | undefined } }, userId?: string): string {
  if (userId) return `user:${userId}`
  return `ip:${clientIpFromHeaders((name) => c.req.header(name))}`
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

function denyAuthMutation(c: any, retryAfterSec: number) {
  c.header('Retry-After', String(retryAfterSec))
  return c.json({ error: 'Too many requests. Please try again later.' }, 429)
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

export const authRoutes = new Hono<{ Variables: AppVariables }>()

function hashResetToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

authRoutes.post('/login', zValidator('json', loginSchema), async (c) => {
  const ip = clientIpFromHeaders((name) => c.req.header(name))
  if (!checkLoginRateLimit(ip)) {
    logSecurityEvent('failed_login', {
      reason: 'rate_limited',
      ip,
      path: c.req.path,
    })
    return c.json({ error: 'Too many login attempts. Try again later.' }, 429)
  }

  const { email, password } = c.req.valid('json')
  const [user] = await db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1)
  if (!user || !user.active) {
    await verifyPassword(await getDummyPasswordHash(), password)
    logSecurityEvent('failed_login', {
      reason: !user ? 'unknown_email' : 'inactive_user',
      email: email.toLowerCase(),
      ip,
    })
    return c.json({ error: 'Invalid email or password' }, 401)
  }

  const valid = await verifyPassword(user.passwordHash, password)
  if (!valid) {
    logSecurityEvent('failed_login', {
      reason: 'invalid_password',
      email: email.toLowerCase(),
      userId: user.id,
      ip,
    })
    return c.json({ error: 'Invalid email or password' }, 401)
  }

  const userAgent = c.req.header('user-agent')
  const hashedIp = hashIp(ip)
  if (user.totpEnabled && user.totpSecret) {
    const totpChallenge = createTotpChallenge(user.id)
    return c.json({
      requiresTotp: true,
      totpChallenge,
    })
  }

  resetLoginRateLimit(ip)
  const token = await createSession(user.id, {
    userAgent,
    ipHash: hashedIp,
  })
  const secure = process.env.NODE_ENV === 'production'
  setCookie(c, SESSION_COOKIE, token, sessionCookieOptions(secure))
  setCsrfCookie(c, generateCsrfToken())

  if (isBreakGlassEmail(user.email)) {
    logSecurityEvent('break_glass_login', {
      userId: user.id,
      email: user.email,
      ip,
    })
    await logAudit({
      farmId: user.farmId,
      userId: user.id,
      action: 'break_glass_login',
      entityType: 'session',
      metadata: { email: user.email },
    })
  }

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'login',
    entityType: 'session',
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
    },
    mustChangePassword: user.mustChangePassword,
  })
})

authRoutes.post('/register', zValidator('json', registerBodySchema), async (c) => {
  const mutation = checkAuthMutationRateLimit(authMutationKey(c))
  if (!mutation.allowed) return denyAuthMutation(c, mutation.retryAfterSec)

  const ip = clientIpFromHeaders((name) => c.req.header(name))
  const body = c.req.valid('json')
  const secretCheck = validateRegistrationSecret(
    body.registrationSecret,
    process.env.OWNER_REGISTRATION_SECRET,
  )
  if (!secretCheck.ok) {
    if (secretCheck.reason === 'disabled') {
      return c.json({ error: 'Admin registration is disabled' }, 503)
    }
    logSecurityEvent('failed_registration', {
      reason: 'invalid_secret',
      email: normalizeRegisterEmail(body.email),
      ip,
    })
    return c.json({ error: 'Invalid registration secret' }, 401)
  }

  const [farm] = await db.select({ id: farms.id }).from(farms).limit(1)
  if (!farm) {
    return c.json({ error: 'No farm provisioned. Seed or create a farm first.' }, 409)
  }

  const email = normalizeRegisterEmail(body.email)
  const phone = normalizeRegisterPhone(body.phone)
  if (phone.length < 7) {
    return c.json({ error: 'Phone number looks invalid' }, 400)
  }

  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1)
  if (existing) return c.json({ error: 'Email already in use' }, 400)

  const [created] = await db
    .insert(users)
    .values({
      farmId: farm.id,
      email,
      name: body.name.trim(),
      phone,
      passwordHash: await hashPassword(body.password),
      role: 'owner',
      mustChangePassword: false,
      active: true,
    })
    .returning()

  if (!created) return c.json({ error: 'Could not create account' }, 500)

  const acceptedAt = new Date()
  await db.insert(consentRecords).values(
    CONSENT_TYPES.map((consentType) => ({
      userId: created.id,
      farmId: farm.id,
      consentType,
      version: CURRENT_CONSENT_VERSION,
      acceptedAt,
    })),
  )

  const userAgent = c.req.header('user-agent')
  const hashedIp = hashIp(ip)
  const sessionToken = await createSession(created.id, {
    userAgent,
    ipHash: hashedIp,
  })
  const secure = process.env.NODE_ENV === 'production'
  setCookie(c, SESSION_COOKIE, sessionToken, sessionCookieOptions(secure))
  setCsrfCookie(c, generateCsrfToken())

  await logAudit({
    farmId: farm.id,
    userId: created.id,
    action: 'register',
    entityType: 'user',
    entityId: created.id,
    metadata: { role: 'owner', via: 'founder_registration' },
  })

  return c.json(
    {
      user: {
        id: created.id,
        email: created.email,
        name: created.name,
        role: created.role,
        farmId: created.farmId,
        totpEnabled: created.totpEnabled,
        butlerTtsMode: created.butlerTtsMode,
      },
      mustChangePassword: created.mustChangePassword,
    },
    201,
  )
})

authRoutes.post('/totp/complete-login', zValidator('json', totpCompleteLoginSchema), async (c) => {
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
  resetLoginRateLimit(ip)

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
    },
    mustChangePassword: user.mustChangePassword,
  })
})

authRoutes.post('/forgot-password', zValidator('json', forgotPasswordSchema), async (c) => {
  const mutation = checkAuthMutationRateLimit(authMutationKey(c))
  if (!mutation.allowed) return denyAuthMutation(c, mutation.retryAfterSec)

  const { email } = c.req.valid('json')
  const normalizedEmail = email.toLowerCase()
  const [user] = await db.select().from(users).where(eq(users.email, normalizedEmail)).limit(1)

  if (user && user.active) {
    const now = new Date()
    await db
      .update(passwordResetTokens)
      .set({ usedAt: now })
      .where(
        and(
          eq(passwordResetTokens.userId, user.id),
          isNull(passwordResetTokens.usedAt),
          gt(passwordResetTokens.expiresAt, now),
        ),
      )

    const rawToken = randomBytes(32).toString('base64url')
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000)
    const [resetToken] = await db.insert(passwordResetTokens).values({
      userId: user.id,
      tokenHash: hashResetToken(rawToken),
      expiresAt,
    }).returning({ id: passwordResetTokens.id })
    logSecurityEvent('password_reset_requested', { email: normalizedEmail, userId: user.id })

    const delivery = await deliverPasswordReset(user.email, rawToken, user.phone)
    if (requiredDeliveryFailed(delivery) && resetToken) {
      await db
        .update(passwordResetTokens)
        .set({ usedAt: new Date() })
        .where(eq(passwordResetTokens.id, resetToken.id))
      logSecurityEvent('password_reset_delivery_failed', {
        userId: user.id,
        requiredChannels: delivery
          .filter((result) => result.required && result.status !== 'delivered')
          .map((result) => result.channel),
      })
    }

    await logAudit({
      farmId: user.farmId,
      userId: user.id,
      action: 'password_reset_requested',
      entityType: 'security',
      metadata: { expiresAt: expiresAt.toISOString() },
    })
  } else {
    logSecurityEvent('password_reset_requested', { email: normalizedEmail, userFound: false })
  }

  return c.json({
    ok: true,
    message: 'If that email exists, password reset instructions were sent.',
  })
})

authRoutes.post('/reset-password', zValidator('json', resetPasswordSchema), async (c) => {
  const { token, password, newPassword } = c.req.valid('json')
  const nextPassword = newPassword ?? password
  if (!nextPassword) return c.json({ error: 'Password is required' }, 400)
  const now = new Date()
  const [tokenRow] = await db
    .select({
      id: passwordResetTokens.id,
      userId: passwordResetTokens.userId,
      farmId: users.farmId,
    })
    .from(passwordResetTokens)
    .innerJoin(users, eq(passwordResetTokens.userId, users.id))
    .where(
      and(
        eq(passwordResetTokens.tokenHash, hashResetToken(token)),
        gt(passwordResetTokens.expiresAt, now),
        isNull(passwordResetTokens.usedAt),
      ),
    )
    .limit(1)

  if (!tokenRow) {
    logSecurityEvent('password_reset_failed', { reason: 'invalid_or_expired_token' })
    return c.json({ error: 'Invalid or expired reset token' }, 400)
  }

  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({
        passwordHash: await hashPassword(nextPassword),
        mustChangePassword: false,
      })
      .where(eq(users.id, tokenRow.userId))

    await tx
      .update(passwordResetTokens)
      .set({ usedAt: now })
      .where(eq(passwordResetTokens.id, tokenRow.id))
  })

  // No active session after reset - revoke all sessions for this user
  await revokeOtherSessions(tokenRow.userId, undefined)

  logSecurityEvent('password_reset_completed', { userId: tokenRow.userId })
  await logAudit({
    farmId: tokenRow.farmId,
    userId: tokenRow.userId,
    action: 'password_reset_completed',
    entityType: 'security',
  })

  return c.json({ ok: true })
})

authRoutes.post('/logout', authMiddleware, async (c) => {
  const token = getCookie(c, SESSION_COOKIE)
  if (token) await deleteSession(token)
  deleteCookie(c, SESSION_COOKIE, { path: '/' })
  deleteCookie(c, CSRF_COOKIE, { path: '/' })
  return c.json({ ok: true })
})

authRoutes.post('/change-password', authMiddleware, zValidator('json', changePasswordSchema), async (c) => {
  const user = c.get('user')
  const mutation = checkAuthMutationRateLimit(authMutationKey(c, user.id))
  if (!mutation.allowed) return denyAuthMutation(c, mutation.retryAfterSec)

  const { currentPassword, newPassword } = c.req.valid('json')

  const [existing] = await db.select().from(users).where(eq(users.id, user.id)).limit(1)
  if (!existing) return c.json({ error: 'Unauthorized' }, 401)

  const valid = await verifyPassword(existing.passwordHash, currentPassword)
  if (!valid) return c.json({ error: 'Current password is incorrect' }, 400)

  await db
    .update(users)
    .set({
      passwordHash: await hashPassword(newPassword),
      mustChangePassword: false,
    })
    .where(eq(users.id, user.id))

  const currentToken = getCookie(c, SESSION_COOKIE)
  await revokeOtherSessions(user.id, currentToken)

  logSecurityEvent('password_changed', { userId: user.id })
  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'password_changed',
    entityType: 'security',
  })

  return c.json({ ok: true })
})

authRoutes.get('/totp/status', authMiddleware, async (c) => {
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

authRoutes.post('/totp/setup', authMiddleware, async (c) => {
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

authRoutes.post('/totp/enable', authMiddleware, zValidator('json', totpCodeSchema), async (c) => {
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

authRoutes.post('/totp/disable', authMiddleware, zValidator('json', totpDisableSchema), async (c) => {
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
  const validPassword = await verifyPassword(existing.passwordHash, password)
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

authRoutes.post('/totp/use-recovery-code', zValidator('json', useRecoveryCodeSchema), async (c) => {
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
    resetLoginRateLimit(ip)

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
      },
      mustChangePassword: user.mustChangePassword,
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
  const validPassword = await verifyPassword(existing.passwordHash, password)
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

authRoutes.post('/totp/regenerate-recovery-codes', authMiddleware, zValidator('json', totpCodeSchema), async (c) => {
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

authRoutes.get('/preferences', authMiddleware, async (c) => {
  const user = c.get('user')
  if (user.role !== 'owner') return c.json({ error: 'Forbidden' }, 403)

  const [existing] = await db
    .select({ butlerTtsMode: users.butlerTtsMode })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1)

  if (!existing) return c.json({ error: 'Unauthorized' }, 401)
  return c.json({ butlerTtsMode: existing.butlerTtsMode })
})

authRoutes.patch('/preferences', authMiddleware, zValidator('json', updatePreferencesSchema), async (c) => {
  const user = c.get('user')
  if (user.role !== 'owner') return c.json({ error: 'Forbidden' }, 403)
  const body = c.req.valid('json')

  await db.update(users).set({ butlerTtsMode: body.butlerTtsMode }).where(eq(users.id, user.id))

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'update_preferences',
    entityType: 'user',
    entityId: user.id,
    metadata: { butlerTtsMode: body.butlerTtsMode },
  })

  return c.json({ ok: true, butlerTtsMode: body.butlerTtsMode })
})

authRoutes.post('/revoke-all-sessions', authMiddleware, async (c) => {
  const user = c.get('user')
  const currentToken = getCookie(c, SESSION_COOKIE)
  const revokedSessions = await revokeOtherSessions(user.id, currentToken)

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'revoke_all_sessions',
    entityType: 'session',
    metadata: { revokedSessions },
  })

  return c.json({ ok: true, revokedSessions })
})

authRoutes.get('/sessions', authMiddleware, async (c) => {
  const user = c.get('user')
  const currentToken = getCookie(c, SESSION_COOKIE)
  const sessionList = await listActiveSessions(user.id, currentToken)
  return c.json({
    activeSessions: sessionList.length,
    sessions: sessionList.map((s) => ({
      id: s.id,
      createdAt: s.createdAt.toISOString(),
      expiresAt: s.expiresAt.toISOString(),
      userAgent: s.userAgent,
      current: s.current,
    })),
  })
})

authRoutes.delete('/sessions/:id', authMiddleware, async (c) => {
  const user = c.get('user')
  const sessionId = c.req.param('id')
  if (!sessionId) return c.json({ error: 'Session not found' }, 404)
  const currentToken = getCookie(c, SESSION_COOKIE)
  const result = await revokeSessionById(user.id, sessionId, currentToken)
  if (result === 'not_found') return c.json({ error: 'Session not found' }, 404)
  if (result === 'current') {
    return c.json({ error: 'Cannot revoke the current session - use Sign out instead.' }, 400)
  }
  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'revoke_session',
    entityType: 'session',
    entityId: sessionId,
  })
  return c.json({ ok: true })
})

authRoutes.get('/me', authMiddleware, async (c) => {
  const user = c.get('user')
  const [existing] = await db
    .select({
      id: users.id,
      farmId: users.farmId,
      email: users.email,
      name: users.name,
      role: users.role,
      mustChangePassword: users.mustChangePassword,
      totpEnabled: users.totpEnabled,
      butlerTtsMode: users.butlerTtsMode,
    })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1)
  if (!existing) return c.json({ error: 'Unauthorized' }, 401)
  const activeSessions = await countActiveSessions(user.id)
  return c.json({ user: existing, activeSessions })
})
