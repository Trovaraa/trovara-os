import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { z } from 'zod'
import { db } from '../db/index.js'
import {
  customerAccounts,
  customerContacts,
  farms,
  harvestLots,
  orderItems,
  orders,
  products,
} from '../db/schema.js'
import {
  CUSTOMER_SESSION_COOKIE,
  consumeCustomerEmailVerificationToken,
  consumeCustomerPasswordResetToken,
  createCustomerEmailVerificationToken,
  createCustomerLinkCode,
  createCustomerPasswordResetToken,
  createCustomerSession,
  customerSessionCookieOptions,
  deleteCustomerSession,
  getCustomerFromSession,
  revokeAllCustomerSessions,
} from '../lib/customer-accounts.js'
import {
  createOrderFromCart,
  resolveCustomerFarm,
  upsertCustomerContact,
} from '../lib/customer-orders.js'
import { orderReference } from '../lib/customer-cart.js'
import { generateCsrfToken, setCsrfCookie } from '../lib/csrf.js'
import { publicLotPageUrl } from '../lib/public-app-url.js'
import { getDummyPasswordHash, hashPassword, verifyPassword } from '../lib/session.js'
import { emailProviderReady, sendEmail } from '../lib/notifications.js'
import {
  shopResetPasswordEmailContent,
  shopVerifyEmailContent,
} from '../lib/email-template.js'
import {
  checkDurableRateLimit,
  resetDurableRateLimit,
  shopEmailAddrRateKey,
  shopEmailIpRateKey,
  shopLoginRateKey,
  SHOP_EMAIL_ADDR_MAX_ATTEMPTS,
  SHOP_EMAIL_IP_MAX_ATTEMPTS,
} from '../middleware/security.js'
import { clientIpFromHeaders } from '../lib/client-ip.js'
import { logSecurityEvent } from '../lib/security-log.js'

export const customerShopRoutes = new Hono()

const credentialsSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(8).max(128),
})

const registerSchema = credentialsSchema.extend({
  name: z.string().trim().min(2).max(100),
  phone: z.string().trim().min(7).max(30).optional(),
})

const orderSchema = z.object({
  items: z
    .array(
      z.object({
        productId: z.string().uuid(),
        quantity: z.number().int().min(1).max(100),
      }),
    )
    .min(1)
    .max(20),
  address: z.string().trim().min(5).max(500),
  phone: z.string().trim().min(7).max(30).optional(),
})

const forgotPasswordSchema = z.object({
  email: z.string().trim().email().max(254),
})

const resetPasswordSchema = z.object({
  token: z.string().min(20).max(512),
  newPassword: z.string().min(8).max(128),
})

const verifyEmailSchema = z.object({
  token: z.string().min(20).max(512),
})

const resendVerificationSchema = z.object({
  email: z.string().trim().email().max(254),
})

const SHOP_EMAIL_RATE_LIMIT_MSG = 'Too many requests. Please try again later.'
const EMAIL_DELIVERY_UNAVAILABLE_MSG =
  'Email delivery is temporarily unavailable. Please try again later.'
const EMAIL_SEND_FAILED_MSG = 'Unable to send email right now. Please try again later.'

function secureCookies(): boolean {
  return process.env.NODE_ENV === 'production'
}

function marketingUrl(): string {
  const url = process.env.PUBLIC_MARKETING_URL?.trim()
  if (!url) return 'https://trovara.farm'
  return url.replace(/\/+$/, '')
}

/** Local/dev only: print the link so inbox delivery is not required to test. */
function logShopEmailLinkLocally(kind: 'verify' | 'reset', to: string, url: string) {
  if (process.env.NODE_ENV === 'production') return
  console.info(`[shop-email:${kind}] to=${to} link=${url}`)
}

async function currentCustomer(c: any) {
  return getCustomerFromSession(getCookie(c, CUSTOMER_SESSION_COOKIE))
}

function setCustomerSession(c: any, token: string) {
  setCookie(c, CUSTOMER_SESSION_COOKIE, token, customerSessionCookieOptions(secureCookies()))
}

async function enforceShopEmailRateLimits(
  c: { json: (body: unknown, status?: number) => Response },
  ip: string,
  email: string,
): Promise<Response | null> {
  if (!(await checkDurableRateLimit(shopEmailIpRateKey(ip), SHOP_EMAIL_IP_MAX_ATTEMPTS))) {
    return c.json({ error: SHOP_EMAIL_RATE_LIMIT_MSG }, 429)
  }
  if (
    !(await checkDurableRateLimit(shopEmailAddrRateKey(email), SHOP_EMAIL_ADDR_MAX_ATTEMPTS))
  ) {
    return c.json({ error: SHOP_EMAIL_RATE_LIMIT_MSG }, 429)
  }
  return null
}

function emailDeliveryUnavailable(c: { json: (body: unknown, status?: number) => Response }) {
  return c.json({ error: EMAIL_DELIVERY_UNAVAILABLE_MSG }, 503)
}

function emailSendFailed(c: { json: (body: unknown, status?: number) => Response }) {
  return c.json({ error: EMAIL_SEND_FAILED_MSG }, 503)
}


customerShopRoutes.get('/session', async (c) => {
  const csrfToken = generateCsrfToken()
  setCsrfCookie(c, csrfToken)
  const account = await currentCustomer(c)
  return c.json({ csrfToken, account })
})

customerShopRoutes.get('/catalog', async (c) => {
  const farm = await resolveCustomerFarm()
  if (!farm) return c.json({ error: 'The shop is not available yet.' }, 503)
  const rows = await db
    .select({
      id: products.id,
      sku: products.sku,
      name: products.name,
      unit: products.unit,
      priceKobo: products.priceKobo,
      currency: products.currency,
    })
    .from(products)
    .where(and(eq(products.farmId, farm.id), eq(products.active, true)))
    .orderBy(asc(products.sortOrder), asc(products.name))
  return c.json({ farm, products: rows })
})

customerShopRoutes.post('/register', zValidator('json', registerSchema), async (c) => {
  const farm = await resolveCustomerFarm()
  if (!farm) return c.json({ error: 'The shop is not available yet.' }, 503)
  const body = c.req.valid('json')
  const email = body.email.toLowerCase()
  const ip = clientIpFromHeaders((name) => c.req.header(name))

  const rateLimited = await enforceShopEmailRateLimits(c, ip, email)
  if (rateLimited) return rateLimited
  if (!emailProviderReady()) return emailDeliveryUnavailable(c)

  const [existing] = await db
    .select({ id: customerAccounts.id })
    .from(customerAccounts)
    .where(and(eq(customerAccounts.farmId, farm.id), eq(customerAccounts.email, email)))
    .limit(1)

  if (existing) {
    // Anti-enumeration: identical response to a fresh signup. Resend verify only
    // when the existing account is still unverified.
    const [unverified] = await db
      .select({
        id: customerAccounts.id,
        name: customerAccounts.name,
        active: customerAccounts.active,
      })
      .from(customerAccounts)
      .where(
        and(
          eq(customerAccounts.id, existing.id),
          isNull(customerAccounts.emailVerifiedAt),
        ),
      )
      .limit(1)
    if (unverified?.active) {
      const { rawToken } = await createCustomerEmailVerificationToken(unverified.id)
      const verifyUrl = `${marketingUrl()}/shop/verify-email?token=${encodeURIComponent(rawToken)}`
      logShopEmailLinkLocally('verify', email, verifyUrl)
      const mail = shopVerifyEmailContent(unverified.name, verifyUrl)
      const delivery = await sendEmail({
        to: email,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      })
      // Keep the anti-enumeration 201 even if resend fails (do not 503 vs verified 201).
      if (delivery.status !== 'delivered') {
        logSecurityEvent('password_reset_delivery_failed', {
          reason: 'shop_register_unverified_resend_failed',
          status: delivery.status,
          path: c.req.path,
        })
      }
    }
    return c.json({
      ok: true,
      needsVerification: true,
      message: 'Registration successful. Please check your email to verify your account.',
    }, 201)
  }

  const [account] = await db
    .insert(customerAccounts)
    .values({
      farmId: farm.id,
      email,
      name: body.name,
      phone: body.phone || null,
      passwordHash: await hashPassword(body.password),
      emailVerifiedAt: null,
    })
    .returning({
      id: customerAccounts.id,
      farmId: customerAccounts.farmId,
      email: customerAccounts.email,
      name: customerAccounts.name,
      phone: customerAccounts.phone,
    })

  const { rawToken } = await createCustomerEmailVerificationToken(account.id)
  const verifyUrl = `${marketingUrl()}/shop/verify-email?token=${encodeURIComponent(rawToken)}`
  logShopEmailLinkLocally('verify', email, verifyUrl)
  const mail = shopVerifyEmailContent(body.name, verifyUrl)

  const delivery = await sendEmail({
    to: email,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
  })
  if (delivery.status !== 'delivered') {
    await db.delete(customerAccounts).where(eq(customerAccounts.id, account.id))
    return emailSendFailed(c)
  }

  return c.json({
    ok: true,
    needsVerification: true,
    message: 'Registration successful. Please check your email to verify your account.',
  }, 201)
})

customerShopRoutes.post('/login', zValidator('json', credentialsSchema), async (c) => {
  const ip = clientIpFromHeaders((name) => c.req.header(name))
  if (!(await checkDurableRateLimit(shopLoginRateKey(ip)))) {
    logSecurityEvent('failed_customer_login', {
      reason: 'rate_limited',
      ip,
      path: c.req.path,
    })
    return c.json({ error: 'Too many login attempts. Try again later.' }, 429)
  }

  const farm = await resolveCustomerFarm()
  if (!farm) return c.json({ error: 'The shop is not available yet.' }, 503)
  const body = c.req.valid('json')
  const [account] = await db
    .select()
    .from(customerAccounts)
    .where(
      and(
        eq(customerAccounts.farmId, farm.id),
        eq(customerAccounts.email, body.email.toLowerCase()),
      ),
    )
    .limit(1)
  const valid = account
    ? await verifyPassword(account.passwordHash, body.password)
    : await verifyPassword(await getDummyPasswordHash(), body.password)
  
  if (!account || !account.active || !valid) {
    return c.json(
      {
        error:
          "We couldn't sign you in. Check your email and password, or create an account if you're new.",
      },
      401,
    )
  }

  if (!account.emailVerifiedAt) {
    return c.json(
      {
        error: 'Please verify your email before signing in. Check your inbox for the verification link.',
        needsVerification: true,
      },
      403,
    )
  }

  await resetDurableRateLimit(shopLoginRateKey(ip))
  const token = await createCustomerSession(account.id)
  setCustomerSession(c, token)
  const csrfToken = generateCsrfToken()
  setCsrfCookie(c, csrfToken)
  return c.json({
    account: {
      id: account.id,
      farmId: account.farmId,
      email: account.email,
      name: account.name,
      phone: account.phone,
    },
    csrfToken,
  })
})

customerShopRoutes.post('/logout', async (c) => {
  await deleteCustomerSession(getCookie(c, CUSTOMER_SESSION_COOKIE))
  deleteCookie(c, CUSTOMER_SESSION_COOKIE, { path: '/' })
  return c.json({ ok: true })
})

customerShopRoutes.post('/forgot-password', zValidator('json', forgotPasswordSchema), async (c) => {
  const body = c.req.valid('json')
  const email = body.email.toLowerCase()
  const ip = clientIpFromHeaders((name) => c.req.header(name))

  const rateLimited = await enforceShopEmailRateLimits(c, ip, email)
  if (rateLimited) return rateLimited
  // Provider gate before lookup so a downed Resend cannot distinguish accounts via 503 vs 200.
  if (!emailProviderReady()) return emailDeliveryUnavailable(c)

  const farm = await resolveCustomerFarm()
  if (!farm) return c.json({ error: 'The shop is not available yet.' }, 503)

  const [account] = await db
    .select()
    .from(customerAccounts)
    .where(and(eq(customerAccounts.farmId, farm.id), eq(customerAccounts.email, email)))
    .limit(1)

  if (account && account.active) {
    const { rawToken } = await createCustomerPasswordResetToken(account.id)
    const resetUrl = `${marketingUrl()}/shop/reset-password?token=${encodeURIComponent(rawToken)}`
    logShopEmailLinkLocally('reset', email, resetUrl)
    const mail = shopResetPasswordEmailContent(account.name, resetUrl)

    const delivery = await sendEmail({
      to: email,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    })
    if (delivery.status !== 'delivered') {
      logSecurityEvent('password_reset_delivery_failed', {
        reason: 'shop_forgot_password_send_failed',
        status: delivery.status,
        path: c.req.path,
      })
    }
  }

  return c.json({
    ok: true,
    message: 'If that email exists, password reset instructions were sent.',
  })
})

customerShopRoutes.post('/reset-password', zValidator('json', resetPasswordSchema), async (c) => {
  const body = c.req.valid('json')
  const tokenData = await consumeCustomerPasswordResetToken(body.token)
  
  if (!tokenData) {
    return c.json({ error: 'Invalid or expired reset token.' }, 400)
  }

  await db
    .update(customerAccounts)
    .set({ passwordHash: await hashPassword(body.newPassword) })
    .where(eq(customerAccounts.id, tokenData.accountId))

  await revokeAllCustomerSessions(tokenData.accountId)

  return c.json({ ok: true, message: 'Password reset successfully. Please sign in.' })
})

customerShopRoutes.post('/verify-email', zValidator('json', verifyEmailSchema), async (c) => {
  const body = c.req.valid('json')
  const tokenData = await consumeCustomerEmailVerificationToken(body.token)
  
  if (!tokenData) {
    return c.json({ error: 'Invalid or expired verification token.' }, 400)
  }

  const token = await createCustomerSession(tokenData.accountId)
  setCustomerSession(c, token)
  const csrfToken = generateCsrfToken()
  setCsrfCookie(c, csrfToken)

  const [account] = await db
    .select({
      id: customerAccounts.id,
      farmId: customerAccounts.farmId,
      email: customerAccounts.email,
      name: customerAccounts.name,
      phone: customerAccounts.phone,
    })
    .from(customerAccounts)
    .where(eq(customerAccounts.id, tokenData.accountId))
    .limit(1)

  return c.json({
    ok: true,
    message: 'Email verified successfully.',
    account,
    csrfToken,
  })
})

customerShopRoutes.post('/resend-verification', zValidator('json', resendVerificationSchema), async (c) => {
  const body = c.req.valid('json')
  const email = body.email.toLowerCase()
  const ip = clientIpFromHeaders((name) => c.req.header(name))

  const rateLimited = await enforceShopEmailRateLimits(c, ip, email)
  if (rateLimited) return rateLimited
  if (!emailProviderReady()) return emailDeliveryUnavailable(c)

  const farm = await resolveCustomerFarm()
  if (!farm) return c.json({ error: 'The shop is not available yet.' }, 503)

  const [account] = await db
    .select()
    .from(customerAccounts)
    .where(
      and(
        eq(customerAccounts.farmId, farm.id),
        eq(customerAccounts.email, email),
        isNull(customerAccounts.emailVerifiedAt),
      ),
    )
    .limit(1)

  if (account && account.active) {
    const { rawToken } = await createCustomerEmailVerificationToken(account.id)
    const verifyUrl = `${marketingUrl()}/shop/verify-email?token=${encodeURIComponent(rawToken)}`
    logShopEmailLinkLocally('verify', email, verifyUrl)
    const mail = shopVerifyEmailContent(account.name, verifyUrl)

    const delivery = await sendEmail({
      to: email,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    })
    if (delivery.status !== 'delivered') {
      logSecurityEvent('password_reset_delivery_failed', {
        reason: 'shop_resend_verification_failed',
        status: delivery.status,
        path: c.req.path,
      })
    }
  }

  return c.json({
    ok: true,
    message: 'If that email needs verification, instructions were sent.',
  })
})

customerShopRoutes.get('/me', async (c) => {
  const account = await currentCustomer(c)
  if (!account) return c.json({ error: 'Sign in required.' }, 401)
  const channels = await db
    .select({ channel: customerContacts.channel, name: customerContacts.name })
    .from(customerContacts)
    .where(eq(customerContacts.customerAccountId, account.id))
  return c.json({ account, channels: channels.filter((row) => row.channel !== 'web') })
})

customerShopRoutes.post('/link-code', async (c) => {
  const account = await currentCustomer(c)
  if (!account) return c.json({ error: 'Sign in required.' }, 401)
  const link = await createCustomerLinkCode(account.id)
  return c.json({
    ...link,
    instruction: `Send "link ${link.code}" to the Trovara bot on WhatsApp or Telegram.`,
  })
})

customerShopRoutes.get('/orders', async (c) => {
  const account = await currentCustomer(c)
  if (!account) return c.json({ error: 'Sign in required.' }, 401)
  const contacts = await db
    .select({ id: customerContacts.id })
    .from(customerContacts)
    .where(eq(customerContacts.customerAccountId, account.id))
  const contactIds = contacts.map((row) => row.id)
  if (!contactIds.length) return c.json({ orders: [] })

  const rows = await db
    .select({
      id: orders.id,
      status: orders.status,
      paymentStatus: orders.paymentStatus,
      totalAmount: orders.totalAmount,
      currency: orders.currency,
      source: orders.source,
      createdAt: orders.createdAt,
      publicToken: harvestLots.publicToken,
      lotCode: harvestLots.lotCode,
      farmSlug: farms.slug,
    })
    .from(orders)
    .innerJoin(farms, eq(orders.farmId, farms.id))
    .leftJoin(harvestLots, eq(harvestLots.orderId, orders.id))
    .where(and(eq(orders.farmId, account.farmId), inArray(orders.customerContactId, contactIds)))
    .orderBy(desc(orders.createdAt))

  const ids = rows.map((row) => row.id)
  const items = ids.length
    ? await db
        .select({
          orderId: orderItems.orderId,
          productName: orderItems.productName,
          quantity: orderItems.quantity,
          unit: orderItems.unit,
        })
        .from(orderItems)
        .where(inArray(orderItems.orderId, ids))
    : []

  return c.json({
    orders: rows.map((row) => ({
      ...row,
      reference: orderReference(row.id),
      items: items.filter((item) => item.orderId === row.id),
      traceabilityUrl:
        row.publicToken && row.farmSlug
          ? publicLotPageUrl(row.farmSlug, row.publicToken)
          : null,
    })),
  })
})

customerShopRoutes.post('/orders', zValidator('json', orderSchema), async (c) => {
  const account = await currentCustomer(c)
  if (!account) return c.json({ error: 'Sign in required.' }, 401)
  
  const [fullAccount] = await db
    .select({ emailVerifiedAt: customerAccounts.emailVerifiedAt })
    .from(customerAccounts)
    .where(eq(customerAccounts.id, account.id))
    .limit(1)
  
  if (!fullAccount || !fullAccount.emailVerifiedAt) {
    return c.json(
      {
        error: 'Please verify your email before placing an order. Check your inbox for the verification link.',
      },
      403,
    )
  }

  const body = c.req.valid('json')
  const ids = [...new Set(body.items.map((item) => item.productId))]
  const catalog = await db
    .select({
      id: products.id,
      name: products.name,
      unit: products.unit,
      priceKobo: products.priceKobo,
      currency: products.currency,
    })
    .from(products)
    .where(
      and(
        eq(products.farmId, account.farmId),
        eq(products.active, true),
        inArray(products.id, ids),
      ),
    )
  if (catalog.length !== ids.length) return c.json({ error: 'One or more products are unavailable.' }, 400)

  const contact = await upsertCustomerContact(
    account.farmId,
    'web',
    account.id,
    account.name,
    body.phone || account.phone,
    account.id,
  )

  const result = await createOrderFromCart({
    farmId: account.farmId,
    channel: 'web',
    contactId: contact.id,
    contactName: account.name,
    cart: body.items.map((item) => ({ productId: item.productId, qty: item.quantity })),
    draft: {
      name: account.name,
      phone: body.phone || account.phone || undefined,
      address: body.address,
    },
    catalog,
  })
  if ('error' in result) return c.json({ error: result.error }, 400)

  return c.json(result, 201)
})
