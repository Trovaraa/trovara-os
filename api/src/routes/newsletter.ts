import { createHash, randomBytes } from 'node:crypto'
import { zValidator } from '@hono/zod-validator'
import { and, count, desc, eq, gt, ilike, or } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { db } from '../db/index.js'
import {
  newsletterConsentEvents,
  newsletterSubscribers,
  newsletterWebhookEvents,
} from '../db/schema.js'
import { logAudit } from '../lib/audit.js'
import { clientIpFromHeaders } from '../lib/client-ip.js'
import { resolveCustomerFarm } from '../lib/customer-orders.js'
import {
  newsletterConsentVersion,
  sendConfirmationEmail,
  sendWelcomeEmail,
  upsertResendContact,
  verifyResendWebhook,
} from '../lib/newsletter-resend.js'
import { checkRateLimit } from '../lib/rate-limit.js'
import { hasPermission } from '../lib/rbac.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'

type SubscriberStatus = 'pending' | 'confirmed' | 'unsubscribed' | 'suppressed'
type Subscriber = typeof newsletterSubscribers.$inferSelect

const TOKEN_TTL_MS = 48 * 60 * 60 * 1000
const PUBLIC_ACCEPTED = {
  ok: true,
  accepted: true,
  message: 'If this request is eligible, we will process it shortly.',
}

const optionalPhone = z.preprocess(
  (value) => (typeof value === 'string' && !value.trim() ? undefined : value),
  z.string().trim().min(5).max(40).optional(),
)

const subscribeSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    email: z.string().trim().email().max(320),
    phone: optionalPhone,
    consent: z.literal(true),
    phoneConsent: z.boolean().optional(),
    honey: z.string().max(500).optional(),
  })
  .superRefine((value, context) => {
    if (value.phone && value.phoneConsent !== true) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['phoneConsent'],
        message: 'Phone consent is required when a phone number is provided',
      })
    }
  })

const tokenSchema = z.object({ token: z.string().trim().min(20).max(200) })
const statusSchema = z.object({ status: z.literal('unsubscribed') })
const listQuerySchema = z.object({
  status: z.enum(['pending', 'confirmed', 'unsubscribed', 'suppressed']).optional(),
  search: z.string().trim().max(200).optional(),
})

export const publicNewsletterRoutes = new Hono()
export const newsletterRoutes = new Hono<{ Variables: AppVariables }>()

newsletterRoutes.use('*', authMiddleware)

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

function newToken(): string {
  return randomBytes(32).toString('base64url')
}

function hashNewsletterToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function safeProviderError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/re_[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 1000)
}

function publicRateLimit(
  c: {
    req: { header: (name: string) => string | undefined }
    header: (name: string, value: string) => void
  },
  action: string,
  max: number,
): boolean {
  const ip = clientIpFromHeaders((name) => c.req.header(name)) ?? 'unknown'
  const result = checkRateLimit(`newsletter:${action}:${ip}`, max, 60_000)
  if (!result.allowed) c.header('Retry-After', String(result.retryAfterSec))
  return result.allowed
}

async function setSyncResult(subscriber: Subscriber): Promise<{ synced: boolean; error?: string }> {
  await db
    .update(newsletterSubscribers)
    .set({
      resendLastSyncStatus: 'pending',
      resendLastSyncError: null,
      updatedAt: new Date(),
    })
    .where(and(eq(newsletterSubscribers.id, subscriber.id), eq(newsletterSubscribers.farmId, subscriber.farmId)))

  try {
    const contactId = await upsertResendContact({
      id: subscriber.id,
      email: subscriber.email,
      fullName: subscriber.fullName,
      status: subscriber.status,
    })
    await db
      .update(newsletterSubscribers)
      .set({
        resendContactId: contactId,
        resendLastSyncStatus: 'synced',
        resendLastSyncError: null,
        resendLastSyncAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(newsletterSubscribers.id, subscriber.id), eq(newsletterSubscribers.farmId, subscriber.farmId)))
    return { synced: true }
  } catch (error) {
    const message = safeProviderError(error)
    await db
      .update(newsletterSubscribers)
      .set({
        resendLastSyncStatus: 'failed',
        resendLastSyncError: message,
        resendLastSyncAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(newsletterSubscribers.id, subscriber.id), eq(newsletterSubscribers.farmId, subscriber.farmId)))
    return { synced: false, error: message }
  }
}

async function deliverConfirmation(subscriber: Subscriber, token: string): Promise<boolean> {
  try {
    await sendConfirmationEmail(
      {
        id: subscriber.id,
        email: subscriber.email,
        fullName: subscriber.fullName,
        status: subscriber.status,
        confirmationTokenHash: subscriber.confirmationTokenHash,
      },
      token,
    )
    await db
      .update(newsletterSubscribers)
      .set({
        confirmationDeliveryStatus: 'sent',
        confirmationDeliveryError: null,
        confirmationLastSentAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(newsletterSubscribers.id, subscriber.id), eq(newsletterSubscribers.farmId, subscriber.farmId)))
    return true
  } catch (error) {
    await db
      .update(newsletterSubscribers)
      .set({
        confirmationDeliveryStatus: 'failed',
        confirmationDeliveryError: safeProviderError(error),
        confirmationLastSentAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(newsletterSubscribers.id, subscriber.id), eq(newsletterSubscribers.farmId, subscriber.farmId)))
    return false
  }
}

publicNewsletterRoutes.post('/subscribe', zValidator('json', subscribeSchema), async (c) => {
  if (!publicRateLimit(c, 'subscribe', 10)) {
    return c.json({ error: 'Too many requests - try again shortly.' }, 429)
  }
  const body = c.req.valid('json')
  if (body.honey?.trim()) return c.json(PUBLIC_ACCEPTED, 202)

  const farm = await resolveCustomerFarm()
  if (!farm) return c.json({ error: 'Newsletter signup is temporarily unavailable.' }, 503)

  const now = new Date()
  const email = normalizeEmail(body.email)
  const confirmationToken = newToken()
  const confirmationTokenHash = hashNewsletterToken(confirmationToken)
  const unsubscribeTokenHash = hashNewsletterToken(newToken())
  const consent = {
    farmId: farm.id,
    email,
    fullName: body.name,
    phone: body.phone ?? null,
    emailConsentAt: now,
    emailConsentVersion: newsletterConsentVersion(),
    emailConsentSource: 'marketing_public_form',
    phoneConsentAt: body.phone ? now : null,
  }

  const [existing] = await db
    .select()
    .from(newsletterSubscribers)
    .where(and(eq(newsletterSubscribers.farmId, farm.id), eq(newsletterSubscribers.email, email)))
    .limit(1)

  if (existing?.status === 'confirmed' || existing?.status === 'suppressed') {
    return c.json(PUBLIC_ACCEPTED, 202)
  }

  let subscriber: Subscriber
  if (existing) {
    ;[subscriber] = await db
      .update(newsletterSubscribers)
      .set({
        ...consent,
        status: 'pending',
        confirmationTokenHash,
        confirmationTokenExpiresAt: new Date(now.getTime() + TOKEN_TTL_MS),
        confirmationDeliveryStatus: 'pending',
        confirmationDeliveryError: null,
        unsubscribeTokenHash,
        resendLastSyncStatus: 'pending',
        resendLastSyncError: null,
        updatedAt: now,
      })
      .where(and(eq(newsletterSubscribers.id, existing.id), eq(newsletterSubscribers.farmId, farm.id)))
      .returning()
  } else {
    ;[subscriber] = await db
      .insert(newsletterSubscribers)
      .values({
        ...consent,
        status: 'pending',
        confirmationTokenHash,
        confirmationTokenExpiresAt: new Date(now.getTime() + TOKEN_TTL_MS),
        unsubscribeTokenHash,
      })
      .returning()
  }

  await db.insert(newsletterConsentEvents).values({ subscriberId: subscriber.id, ...consent })

  // Keep pending signup even when Resend fails; anti-enumeration always 202.
  // Local/dev: confirmation link is logged so inbox delivery is not required.
  if (!(await deliverConfirmation(subscriber, confirmationToken))) {
    if (process.env.NODE_ENV !== 'production') {
      const confirmUrl = `${(process.env.PUBLIC_MARKETING_URL?.trim() || 'https://trovara.farm').replace(/\/+$/, '')}/newsletter/confirm?token=${encodeURIComponent(confirmationToken)}`
      console.info(`[newsletter-email:confirm] to=${email} link=${confirmUrl}`)
    }
  }
  return c.json(PUBLIC_ACCEPTED, 202)
})

publicNewsletterRoutes.post('/confirm', zValidator('json', tokenSchema), async (c) => {
  if (!publicRateLimit(c, 'confirm', 30)) {
    return c.json({ error: 'Too many requests - try again shortly.' }, 429)
  }
  const farm = await resolveCustomerFarm()
  if (!farm) return c.json({ error: 'Newsletter confirmation is temporarily unavailable.' }, 503)

  const token = c.req.valid('json').token
  const tokenHash = hashNewsletterToken(token)
  const [pending] = await db
    .select()
    .from(newsletterSubscribers)
    .where(
      and(
        eq(newsletterSubscribers.farmId, farm.id),
        eq(newsletterSubscribers.status, 'pending'),
        eq(newsletterSubscribers.confirmationTokenHash, tokenHash),
        gt(newsletterSubscribers.confirmationTokenExpiresAt, new Date()),
      ),
    )
    .limit(1)
  if (!pending) return c.json({ error: 'This confirmation link is invalid or expired.' }, 400)

  const now = new Date()
  const unsubscribeToken = newToken()
  const [confirmed] = await db
    .update(newsletterSubscribers)
    .set({
      status: 'confirmed',
      confirmedAt: now,
      confirmationTokenHash: null,
      confirmationTokenExpiresAt: null,
      unsubscribeTokenHash: hashNewsletterToken(unsubscribeToken),
      updatedAt: now,
    })
    .where(
      and(
        eq(newsletterSubscribers.id, pending.id),
        eq(newsletterSubscribers.farmId, farm.id),
        eq(newsletterSubscribers.status, 'pending'),
        eq(newsletterSubscribers.confirmationTokenHash, tokenHash),
      ),
    )
    .returning()
  if (!confirmed) return c.json({ error: 'This confirmation link is invalid or expired.' }, 400)

  const sync = await setSyncResult(confirmed)
  try {
    await sendWelcomeEmail(
      {
        id: confirmed.id,
        email: confirmed.email,
        fullName: confirmed.fullName,
        status: confirmed.status,
        unsubscribeToken,
      },
      now.getTime().toString(36),
    )
  } catch (error) {
    console.warn('Newsletter welcome email failed:', safeProviderError(error))
  }
  return c.json({ ok: true, confirmed: true, providerSync: sync.synced ? 'synced' : 'pending' })
})

publicNewsletterRoutes.post('/unsubscribe', zValidator('json', tokenSchema), async (c) => {
  if (!publicRateLimit(c, 'unsubscribe', 30)) {
    return c.json({ error: 'Too many requests - try again shortly.' }, 429)
  }
  const farm = await resolveCustomerFarm()
  if (!farm) return c.json(PUBLIC_ACCEPTED, 202)

  const tokenHash = hashNewsletterToken(c.req.valid('json').token)
  const [existing] = await db
    .select()
    .from(newsletterSubscribers)
    .where(
      and(
        eq(newsletterSubscribers.farmId, farm.id),
        eq(newsletterSubscribers.unsubscribeTokenHash, tokenHash),
      ),
    )
    .limit(1)
  if (!existing) return c.json(PUBLIC_ACCEPTED, 202)

  const now = new Date()
  const [subscriber] = await db
    .update(newsletterSubscribers)
    .set({
      status: 'unsubscribed',
      unsubscribedAt: existing.unsubscribedAt ?? now,
      unsubscribedReason: existing.unsubscribedReason ?? 'public_unsubscribe_link',
      confirmationTokenHash: null,
      confirmationTokenExpiresAt: null,
      updatedAt: now,
    })
    .where(and(eq(newsletterSubscribers.id, existing.id), eq(newsletterSubscribers.farmId, farm.id)))
    .returning()
  await setSyncResult(subscriber)
  return c.json(PUBLIC_ACCEPTED, 202)
})

publicNewsletterRoutes.post('/webhook', async (c) => {
  if (!publicRateLimit(c, 'webhook', 300)) {
    return c.json({ error: 'Too many requests' }, 429)
  }
  if (!process.env.RESEND_WEBHOOK_SECRET?.trim()) {
    return c.json({ error: 'Webhook is not configured' }, 503)
  }

  const rawBody = await c.req.text()
  const svixId = c.req.header('svix-id') ?? ''
  const svixTimestamp = c.req.header('svix-timestamp') ?? ''
  const svixSignature = c.req.header('svix-signature') ?? ''
  if (!svixId || !svixTimestamp || !svixSignature) {
    return c.json({ error: 'Invalid webhook signature' }, 401)
  }

  let event: ReturnType<typeof verifyResendWebhook>
  try {
    event = verifyResendWebhook(rawBody, {
      id: svixId,
      timestamp: svixTimestamp,
      signature: svixSignature,
    })
  } catch {
    return c.json({ error: 'Invalid webhook signature' }, 401)
  }

  const farm = await resolveCustomerFarm()
  if (!farm) return c.json({ error: 'Newsletter farm is not configured' }, 503)
  const inserted = await db
    .insert(newsletterWebhookEvents)
    .values({ farmId: farm.id, svixId, eventType: event.type })
    .onConflictDoNothing({ target: newsletterWebhookEvents.svixId })
    .returning()
  if (!inserted.length) {
    const [prior] = await db
      .select()
      .from(newsletterWebhookEvents)
      .where(eq(newsletterWebhookEvents.svixId, svixId))
      .limit(1)
    if (prior?.processedAt) return c.json({ received: true })
  }

  try {
    if (event.type === 'contact.updated' && event.data.unsubscribed) {
      const email = normalizeEmail(event.data.email)
      await db
        .update(newsletterSubscribers)
        .set({
          status: 'unsubscribed',
          unsubscribedAt: new Date(),
          unsubscribedReason: 'resend_contact_updated',
          resendContactId: event.data.id,
          resendLastSyncStatus: 'synced',
          resendLastSyncError: null,
          resendLastSyncAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(eq(newsletterSubscribers.farmId, farm.id), eq(newsletterSubscribers.email, email)),
        )
    }
    if (event.type === 'email.bounced' || event.type === 'email.complained') {
      const reason = event.type === 'email.bounced' ? 'resend_email_bounced' : 'resend_email_complained'
      for (const address of event.data.to) {
        await db
          .update(newsletterSubscribers)
          .set({
            status: 'suppressed',
            suppressedAt: new Date(),
            suppressedReason: reason,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(newsletterSubscribers.farmId, farm.id),
              eq(newsletterSubscribers.email, normalizeEmail(address)),
            ),
          )
      }
    }
    await db
      .update(newsletterWebhookEvents)
      .set({ processedAt: new Date(), processingError: null })
      .where(eq(newsletterWebhookEvents.svixId, svixId))
    return c.json({ received: true })
  } catch (error) {
    await db
      .update(newsletterWebhookEvents)
      .set({ processingError: safeProviderError(error) })
      .where(eq(newsletterWebhookEvents.svixId, svixId))
    return c.json({ error: 'Webhook processing failed' }, 500)
  }
})

newsletterRoutes.get('/', zValidator('query', listQuerySchema), async (c) => {
  const user = c.get('user')
  if (!hasPermission(user, 'newsletter.manage')) return c.json({ error: 'Forbidden' }, 403)
  const query = c.req.valid('query')
  const filters = [eq(newsletterSubscribers.farmId, user.farmId)]
  if (query.status) filters.push(eq(newsletterSubscribers.status, query.status))
  if (query.search) {
    const search = `%${query.search.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`
    const searchFilter = or(
      ilike(newsletterSubscribers.email, search),
      ilike(newsletterSubscribers.fullName, search),
    )
    if (searchFilter) filters.push(searchFilter)
  }

  const subscribers = await db
    .select({
      id: newsletterSubscribers.id,
      email: newsletterSubscribers.email,
      fullName: newsletterSubscribers.fullName,
      phone: newsletterSubscribers.phone,
      emailConsentAt: newsletterSubscribers.emailConsentAt,
      emailConsentVersion: newsletterSubscribers.emailConsentVersion,
      emailConsentSource: newsletterSubscribers.emailConsentSource,
      phoneConsentAt: newsletterSubscribers.phoneConsentAt,
      status: newsletterSubscribers.status,
      confirmedAt: newsletterSubscribers.confirmedAt,
      unsubscribedAt: newsletterSubscribers.unsubscribedAt,
      unsubscribedReason: newsletterSubscribers.unsubscribedReason,
      suppressedAt: newsletterSubscribers.suppressedAt,
      suppressedReason: newsletterSubscribers.suppressedReason,
      confirmationDeliveryStatus: newsletterSubscribers.confirmationDeliveryStatus,
      confirmationDeliveryError: newsletterSubscribers.confirmationDeliveryError,
      confirmationLastSentAt: newsletterSubscribers.confirmationLastSentAt,
      resendContactId: newsletterSubscribers.resendContactId,
      resendLastSyncStatus: newsletterSubscribers.resendLastSyncStatus,
      resendLastSyncError: newsletterSubscribers.resendLastSyncError,
      resendLastSyncAt: newsletterSubscribers.resendLastSyncAt,
      createdAt: newsletterSubscribers.createdAt,
      updatedAt: newsletterSubscribers.updatedAt,
    })
    .from(newsletterSubscribers)
    .where(and(...filters))
    .orderBy(desc(newsletterSubscribers.createdAt))
    .limit(500)
  const counts = await db
    .select({ status: newsletterSubscribers.status, count: count() })
    .from(newsletterSubscribers)
    .where(eq(newsletterSubscribers.farmId, user.farmId))
    .groupBy(newsletterSubscribers.status)
  const summary: Record<SubscriberStatus | 'total', number> = {
    total: 0,
    pending: 0,
    confirmed: 0,
    unsubscribed: 0,
    suppressed: 0,
  }
  for (const row of counts) {
    summary[row.status] = Number(row.count)
    summary.total += Number(row.count)
  }
  return c.json({ subscribers, summary })
})

newsletterRoutes.post('/:id/resend-confirmation', async (c) => {
  const user = c.get('user')
  if (!hasPermission(user, 'newsletter.manage')) return c.json({ error: 'Forbidden' }, 403)
  const [existing] = await db
    .select()
    .from(newsletterSubscribers)
    .where(
      and(
        eq(newsletterSubscribers.id, c.req.param('id')),
        eq(newsletterSubscribers.farmId, user.farmId),
      ),
    )
    .limit(1)
  if (!existing) return c.json({ error: 'Not found' }, 404)
  if (existing.status !== 'pending') return c.json({ error: 'Subscriber is not pending' }, 409)

  const token = newToken()
  const [subscriber] = await db
    .update(newsletterSubscribers)
    .set({
      confirmationTokenHash: hashNewsletterToken(token),
      confirmationTokenExpiresAt: new Date(Date.now() + TOKEN_TTL_MS),
      confirmationDeliveryStatus: 'pending',
      confirmationDeliveryError: null,
      updatedAt: new Date(),
    })
    .where(and(eq(newsletterSubscribers.id, existing.id), eq(newsletterSubscribers.farmId, user.farmId)))
    .returning()
  const delivered = await deliverConfirmation(subscriber, token)
  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'resend_confirmation',
    entityType: 'newsletter_subscriber',
    entityId: subscriber.id,
    metadata: { delivered },
  })
  if (!delivered) return c.json({ error: 'Confirmation delivery failed; the pending record was retained.' }, 502)
  return c.json({ sent: true })
})

newsletterRoutes.post('/:id/sync', async (c) => {
  const user = c.get('user')
  if (!hasPermission(user, 'newsletter.manage')) return c.json({ error: 'Forbidden' }, 403)
  const [subscriber] = await db
    .select()
    .from(newsletterSubscribers)
    .where(
      and(
        eq(newsletterSubscribers.id, c.req.param('id')),
        eq(newsletterSubscribers.farmId, user.farmId),
      ),
    )
    .limit(1)
  if (!subscriber) return c.json({ error: 'Not found' }, 404)
  const result = await setSyncResult(subscriber)
  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'sync',
    entityType: 'newsletter_subscriber',
    entityId: subscriber.id,
    metadata: { synced: result.synced },
  })
  if (!result.synced) return c.json({ error: 'Resend sync failed; retry is available.' }, 502)
  return c.json({ synced: true })
})

newsletterRoutes.patch('/:id/status', zValidator('json', statusSchema), async (c) => {
  const user = c.get('user')
  if (!hasPermission(user, 'newsletter.manage')) return c.json({ error: 'Forbidden' }, 403)
  const [existing] = await db
    .select()
    .from(newsletterSubscribers)
    .where(
      and(
        eq(newsletterSubscribers.id, c.req.param('id')),
        eq(newsletterSubscribers.farmId, user.farmId),
      ),
    )
    .limit(1)
  if (!existing) return c.json({ error: 'Not found' }, 404)

  const now = new Date()
  const [subscriber] = await db
    .update(newsletterSubscribers)
    .set({
      status: 'unsubscribed',
      unsubscribedAt: existing.unsubscribedAt ?? now,
      unsubscribedReason: existing.unsubscribedReason ?? 'owner_status_change',
      confirmationTokenHash: null,
      confirmationTokenExpiresAt: null,
      resendLastSyncStatus: 'pending',
      resendLastSyncError: null,
      updatedAt: now,
    })
    .where(and(eq(newsletterSubscribers.id, existing.id), eq(newsletterSubscribers.farmId, user.farmId)))
    .returning()
  const sync = await setSyncResult(subscriber)
  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'status_change',
    entityType: 'newsletter_subscriber',
    entityId: subscriber.id,
    metadata: { from: existing.status, to: 'unsubscribed', resendSynced: sync.synced },
  })
  return c.json({ subscriber: { id: subscriber.id, status: subscriber.status }, providerSync: sync.synced ? 'synced' : 'pending' })
})
