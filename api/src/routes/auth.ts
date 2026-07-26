import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { randomBytes, createHash } from 'node:crypto'
import { and, eq, gt, isNull } from 'drizzle-orm'
import { setCookie, deleteCookie, getCookie } from 'hono/cookie'
import { db } from '../db/index.js'
import { consentRecords, farms, passwordResetTokens, users } from '../db/schema.js'
import { CONSENT_TYPES, CURRENT_CONSENT_VERSION } from '../lib/consent.js'
import {
  isBreakGlassEmail,
  normalizeRegisterEmail,
  normalizeRegisterPhone,
  registerBodySchema,
  validateRegistrationSecret,
  verifyBreakGlassPassword,
} from '../lib/registration.js'
import { ensureBreakGlassOwner } from '../lib/break-glass.js'
import {
  SESSION_COOKIE,
  countActiveSessions,
  createSession,
  deleteSession,
  getDummyPasswordHash,
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
import { createTotpChallenge } from '../lib/totp.js'
import { deliverPasswordReset, requiredDeliveryFailed } from '../lib/notifications.js'
import { authMutationKey, denyAuthMutation } from './auth-shared.js'
import { registerTotpRoutes } from './auth-totp.js'

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

const updatePreferencesSchema = z.object({
  butlerTtsMode: z.enum(['off', 'voice_replies', 'always']).optional(),
  /** Owner opt-in for customer order alerts (Telegram / WhatsApp). */
  orderAlertsSubscribed: z.boolean().optional(),
  /** Owner opt-in for field-worker alerts (tasks, urgent TG/WA). */
  workerAlertsSubscribed: z.boolean().optional(),
  /** UI language, mirrored from the web switcher. Drives AI replies and TG/WA messages. */
  preferredLocale: z.enum(['en', 'yo', 'pcm', 'fr']).optional(),
})

export const authRoutes = new Hono<{ Variables: AppVariables }>()

registerTotpRoutes(authRoutes)

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
  const emailNorm = email.toLowerCase()
  let [user] = await db.select().from(users).where(eq(users.email, emailNorm)).limit(1)

  // Clean go-live has a farm + Founder but no seeded break-glass row. Provision on demand.
  if (!user && isBreakGlassEmail(emailNorm)) {
    const provisioned = await ensureBreakGlassOwner()
    if (provisioned === 'created' || provisioned === 'exists') {
      ;[user] = await db.select().from(users).where(eq(users.email, emailNorm)).limit(1)
    }
  }

  if (!user || !user.active) {
    await verifyPassword(await getDummyPasswordHash(), password)
    logSecurityEvent('failed_login', {
      reason: !user ? 'unknown_email' : 'inactive_user',
      email: emailNorm,
      ip,
    })
    return c.json({ error: 'Invalid email or password' }, 401)
  }

  const breakGlass = isBreakGlassEmail(user.email)
  // Break-glass email: env password is the emergency path; DB hash still works so
  // a Founder who registered as this address can sign in with the password they set.
  let valid = false
  let usedEnvBreakGlass = false
  if (breakGlass) {
    await verifyPassword(await getDummyPasswordHash(), password)
    usedEnvBreakGlass = verifyBreakGlassPassword(password)
    valid = usedEnvBreakGlass || (await verifyPassword(user.passwordHash, password))
  } else {
    valid = await verifyPassword(user.passwordHash, password)
  }
  if (!valid) {
    logSecurityEvent('failed_login', {
      reason: breakGlass ? 'invalid_break_glass_or_password' : 'invalid_password',
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

  if (breakGlass && usedEnvBreakGlass) {
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
      metadata: { email: user.email, via: 'env_password' },
    })
  }

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'login',
    entityType: 'session',
    metadata: breakGlass && usedEnvBreakGlass ? { via: 'break_glass_env' } : undefined,
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
    mustChangePassword: breakGlass && usedEnvBreakGlass ? false : user.mustChangePassword,
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
  if (isBreakGlassEmail(email)) {
    return c.json(
      {
        error:
          'owner@trovara.farm is reserved for break-glass. Register a different @trovara.farm email for day-to-day admin, or sign in with BREAK_GLASS_PASSWORD from the server .env.',
      },
      400,
    )
  }
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
        preferredLocale: created.preferredLocale,
      },
      mustChangePassword: created.mustChangePassword,
    },
    201,
  )
})

authRoutes.post('/forgot-password', zValidator('json', forgotPasswordSchema), async (c) => {
  const mutation = checkAuthMutationRateLimit(authMutationKey(c))
  if (!mutation.allowed) return denyAuthMutation(c, mutation.retryAfterSec)

  const { email } = c.req.valid('json')
  const normalizedEmail = email.toLowerCase()
  const [user] = await db.select().from(users).where(eq(users.email, normalizedEmail)).limit(1)

  // Break-glass password is env-only; never issue email/WhatsApp reset tokens for it.
  if (user && user.active && !isBreakGlassEmail(user.email)) {
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
    logSecurityEvent('password_reset_requested', {
      email: normalizedEmail,
      userFound: Boolean(user?.active),
      breakGlass: user ? isBreakGlassEmail(user.email) : false,
    })
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

  // Break-glass email may have a DB password (Founder registration / day-to-day) and/or
  // BREAK_GLASS_PASSWORD in env (emergency). Changing password updates the DB hash only.
  const valid = isBreakGlassEmail(existing.email)
    ? verifyBreakGlassPassword(currentPassword) ||
      (await verifyPassword(existing.passwordHash, currentPassword))
    : await verifyPassword(existing.passwordHash, currentPassword)
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

authRoutes.get('/preferences', authMiddleware, async (c) => {
  const user = c.get('user')
  if (user.role !== 'owner') return c.json({ error: 'Forbidden' }, 403)

  const [existing] = await db
    .select({
      butlerTtsMode: users.butlerTtsMode,
      orderAlertsSubscribed: users.orderAlertsSubscribed,
      workerAlertsSubscribed: users.workerAlertsSubscribed,
      preferredLocale: users.preferredLocale,
    })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1)

  if (!existing) return c.json({ error: 'Unauthorized' }, 401)
  return c.json(existing)
})

authRoutes.patch('/preferences', authMiddleware, zValidator('json', updatePreferencesSchema), async (c) => {
  const user = c.get('user')
  const body = c.req.valid('json')
  // Butler TTS and alert subscriptions stay owner-only; language is every user's
  // own setting - field staff read AI replies and TG/WA alerts in it too.
  const ownerOnlyFields =
    body.butlerTtsMode !== undefined ||
    body.orderAlertsSubscribed !== undefined ||
    body.workerAlertsSubscribed !== undefined
  const localeOnly = body.preferredLocale !== undefined && !ownerOnlyFields
  if (!localeOnly && user.role !== 'owner') return c.json({ error: 'Forbidden' }, 403)
  if (!ownerOnlyFields && body.preferredLocale === undefined) {
    return c.json({ error: 'No preferences to update' }, 400)
  }

  const patch: {
    butlerTtsMode?: typeof body.butlerTtsMode
    orderAlertsSubscribed?: boolean
    workerAlertsSubscribed?: boolean
    preferredLocale?: typeof body.preferredLocale
    preferredLocaleSetAt?: Date
  } = {}
  if (body.butlerTtsMode !== undefined) patch.butlerTtsMode = body.butlerTtsMode
  if (body.orderAlertsSubscribed !== undefined) patch.orderAlertsSubscribed = body.orderAlertsSubscribed
  if (body.workerAlertsSubscribed !== undefined) patch.workerAlertsSubscribed = body.workerAlertsSubscribed
  if (body.preferredLocale !== undefined) {
    patch.preferredLocale = body.preferredLocale
    // Choosing it here counts as answering, so Butler stops asking.
    patch.preferredLocaleSetAt = new Date()
  }

  await db.update(users).set(patch).where(eq(users.id, user.id))

  const [updated] = await db
    .select({
      butlerTtsMode: users.butlerTtsMode,
      orderAlertsSubscribed: users.orderAlertsSubscribed,
      workerAlertsSubscribed: users.workerAlertsSubscribed,
      preferredLocale: users.preferredLocale,
    })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1)

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'update_preferences',
    entityType: 'user',
    entityId: user.id,
    metadata: patch,
  })

  return c.json({ ok: true, ...updated })
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
      preferredLocale: users.preferredLocale,
    })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1)
  if (!existing) return c.json({ error: 'Unauthorized' }, 401)
  const activeSessions = await countActiveSessions(user.id)
  return c.json({ user: existing, activeSessions })
})
