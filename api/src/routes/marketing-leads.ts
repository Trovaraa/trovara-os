import { zValidator } from '@hono/zod-validator'
import { and, count, desc, eq, ilike, inArray, ne, or, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { alias } from 'drizzle-orm/pg-core'
import { db } from '../db/index.js'
import { marketingLeads, users } from '../db/schema.js'
import { logAudit } from '../lib/audit.js'
import { clientIpFromHeaders } from '../lib/client-ip.js'
import { resolveCustomerFarm } from '../lib/customer-orders.js'
import {
  escapeEmailHtml,
  marketingLeadEmailContent,
} from '../lib/email-template.js'
import { sendEmail } from '../lib/notifications.js'
import { checkRateLimit } from '../lib/rate-limit.js'
import { getBreakGlassEmail } from '../lib/registration.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'

const SUBJECTS = {
  general: 'General Enquiry',
  'bulk-order': 'Bulk Order / Wholesale',
  waitlist: 'Product Waitlist / Availability',
  shop: 'Shop Account / Orders',
  'farm-visit': 'Farm Visit',
  'farm-os': 'Trovara Farm OS (Operations System)',
  'farm-advisory': 'Farm Advisory Services',
  partnership: 'Distribution Partnership',
  export: 'Export Enquiry',
  media: 'Media & Press',
  other: 'Other',
} as const

const PRODUCTS = {
  coconut: 'Coconut',
  plantain: 'Plantain',
  poultry: 'Pasture-raised Chicken',
  eggs: 'Pasture-raised Eggs',
  'palm-oil': 'Palm Oil',
} as const

const leadStatuses = ['new', 'in_progress', 'contacted', 'closed', 'spam'] as const
const leadTypes = ['contact', 'product_waitlist'] as const
const subjectSchema = z.enum(Object.keys(SUBJECTS) as [keyof typeof SUBJECTS, ...(keyof typeof SUBJECTS)[]])
const productSchema = z.enum(Object.keys(PRODUCTS) as [keyof typeof PRODUCTS, ...(keyof typeof PRODUCTS)[]])
const optionalPhone = z.preprocess(
  (value) => (typeof value === 'string' && !value.trim() ? undefined : value),
  z.string().trim().min(7).max(40).optional(),
)
const optionalConsentVersion = z.preprocess(
  (value) => (typeof value === 'string' && !value.trim() ? undefined : value),
  z.string().trim().min(1).max(32).optional(),
)
const leadConsentFields = {
  consent: z.literal(true),
  consentVersion: optionalConsentVersion,
} as const
const contactSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(320),
  phone: optionalPhone,
  message: z.string().trim().min(1).max(4_000),
  subject: subjectSchema,
  ...leadConsentFields,
  honey: z.string().max(500).optional(),
}).strict()
const waitlistSchema = z.object({
  name: z.string().trim().min(1).max(120),
  contact: z.string().trim().min(5).max(320),
  product: productSchema,
  ...leadConsentFields,
  honey: z.string().max(500).optional(),
}).strict().superRefine((value, context) => {
  if (!contactParts(value.contact)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['contact'],
      message: 'Contact must be a valid email address or phone number',
    })
  }
})
const DEFAULT_PRIVACY_NOTICE_URL = 'https://trovara.farm/privacy'

function marketingLeadConsentVersion(fromBody?: string): string {
  return fromBody?.trim() || process.env.MARKETING_LEAD_CONSENT_VERSION?.trim() || '1.0'
}

function marketingLeadConsentRecord(fromBody?: string) {
  return {
    consentAt: new Date(),
    consentVersion: marketingLeadConsentVersion(fromBody),
    privacyNoticeUrl: DEFAULT_PRIVACY_NOTICE_URL,
  }
}
const listSchema = z.object({
  type: z.enum(leadTypes).optional(),
  status: z.enum(leadStatuses).optional(),
  search: z.string().trim().max(200).optional(),
})
const patchSchema = z.object({
  status: z.enum(leadStatuses).optional(),
  assignedToId: z.string().uuid().nullable().optional(),
}).strict().refine((value) => value.status !== undefined || value.assignedToId !== undefined, {
  message: 'At least one change is required',
})

type MarketingLead = typeof marketingLeads.$inferSelect

const PUBLIC_ACCEPTED = { ok: true, accepted: true }

export const publicMarketingLeadRoutes = new Hono()
export const marketingLeadRoutes = new Hono<{ Variables: AppVariables }>()
marketingLeadRoutes.use('*', authMiddleware)

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase()
}

function normalizePhone(value: string): string | null {
  const trimmed = value.trim()
  const digits = trimmed.replace(/\D/g, '')
  if (digits.length < 7 || digits.length > 15) return null
  if (digits.startsWith('00')) return `+${digits.slice(2)}`
  // Public Trovara forms currently serve Nigeria. Treat the common local,
  // country-code, and E.164 spellings as the same waitlist contact.
  if (digits.startsWith('234') && digits.length === 13) return `+${digits}`
  if (digits.startsWith('0') && digits.length === 11) return `+234${digits.slice(1)}`
  if (/^[789]\d{9}$/.test(digits)) return `+234${digits}`
  if (trimmed.startsWith('+')) return `+${digits}`
  return digits
}

function contactParts(value: string): { email: string | null; phone: string | null; normalized: string } | null {
  const trimmed = value.trim()
  if (z.string().email().safeParse(trimmed).success) {
    const email = normalizeEmail(trimmed)
    return { email, phone: null, normalized: `email:${email}` }
  }
  const normalizedPhone = normalizePhone(trimmed)
  return normalizedPhone
    ? { email: null, phone: trimmed, normalized: `phone:${normalizedPhone}` }
    : null
}

function publicRateLimit(c: { req: { header: (name: string) => string | undefined }; header: (name: string, value: string) => void }, action: string): boolean {
  const ip = clientIpFromHeaders((name) => c.req.header(name)) ?? 'unknown'
  const result = checkRateLimit(`marketing-leads:${action}:${ip}`, 10, 60_000)
  if (!result.allowed) c.header('Retry-After', String(result.retryAfterSec))
  return result.allowed
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/re_[A-Za-z0-9_-]+/g, '[redacted]')
    .slice(0, 1000)
}

function marketingLeadsUrl(): string {
  const base = process.env.PUBLIC_APP_URL?.trim() || 'https://os.trovara.farm'
  try {
    return new URL('/marketing-leads', base).toString()
  } catch {
    return 'https://os.trovara.farm/marketing-leads'
  }
}

function configuredMarketingLeadRecipients(): Array<{ email: string }> | null {
  const configured = process.env.MARKETING_LEAD_NOTIFICATION_EMAILS?.trim()
  if (!configured) return null
  return [...new Set(
    configured
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  )].map((email) => ({ email }))
}

function leadNotificationHtml(lead: MarketingLead, descriptor: string, contact: string): string {
  const isContact = lead.leadType === 'contact'
  const contactHref = lead.email
    ? `mailto:${escapeEmailHtml(lead.email)}`
    : lead.phone
      ? `tel:${escapeEmailHtml(lead.phone)}`
      : null
  const contactValue = contactHref
    ? `<a href="${contactHref}" style="color:#276338;text-decoration:none;font-weight:700">${escapeEmailHtml(contact)}</a>`
    : escapeEmailHtml(contact)
  const messageHtml = lead.message
    ? escapeEmailHtml(lead.message).replace(/\n/g, '<br>')
    : undefined

  return marketingLeadEmailContent({
    badge: isContact ? 'NEW WEBSITE ENQUIRY' : 'NEW PRODUCT WAITLIST JOIN',
    headline: isContact ? 'A new enquiry just came in' : 'Someone joined a product waitlist',
    intro: 'Review the details below and follow up while the enquiry is fresh.',
    preheader: `${lead.name} submitted ${descriptor}.`,
    rows: [
      { label: 'Name', valueHtml: escapeEmailHtml(lead.name) },
      { label: 'Contact', valueHtml: contactValue },
      {
        label: isContact ? 'Topic' : 'Product',
        valueHtml: escapeEmailHtml(descriptor),
      },
      { label: 'Submissions', valueHtml: String(lead.submissionCount) },
    ],
    messageHtml,
    ctaHref: marketingLeadsUrl(),
  })
}

export async function notifyMarketingLead(lead: MarketingLead): Promise<boolean> {
  const recipients =
    configuredMarketingLeadRecipients() ??
    await db
      .select({ email: users.email })
      .from(users)
      .where(
        and(
          eq(users.farmId, lead.farmId),
          eq(users.active, true),
          inArray(users.role, ['owner', 'sales']),
          ne(users.email, getBreakGlassEmail()),
        ),
      )

  const descriptor = lead.leadType === 'contact' ? lead.subjectLabel : lead.productLabel
  const subject = `New ${lead.leadType === 'contact' ? 'website enquiry' : 'product waitlist join'}: ${descriptor ?? 'Marketing lead'}`
  const contact = lead.email ?? lead.phone ?? 'Not provided'
  const text = [
    `Name: ${lead.name}`,
    `Contact: ${contact}`,
    `Type: ${lead.leadType}`,
    `Topic: ${descriptor ?? 'Not provided'}`,
    lead.message ? `Message:\n${lead.message}` : '',
    `Submission count: ${lead.submissionCount}`,
  ].filter(Boolean).join('\n\n')
  const html = leadNotificationHtml(lead, descriptor ?? 'Not provided', contact)

  try {
    const results = await Promise.all(recipients.map(({ email }) => sendEmail({
      to: email,
      subject,
      text,
      html,
      replyTo: lead.email ?? undefined,
    })))
    const delivered = recipients.length > 0 && results.every((result) => result.status === 'delivered')
    const error = recipients.length === 0
      ? 'No active owner or sales recipient is configured'
      : delivered
        ? null
        : `Email delivery was not completed (${results.map((result) => result.status).join(', ')})`
    await db.update(marketingLeads).set({
      staffNotificationStatus: delivered ? 'sent' : 'failed',
      staffNotificationError: error,
      staffNotifiedAt: new Date(),
      updatedAt: new Date(),
    }).where(and(eq(marketingLeads.id, lead.id), eq(marketingLeads.farmId, lead.farmId)))
    return delivered
  } catch (error) {
    await db.update(marketingLeads).set({
      staffNotificationStatus: 'failed',
      staffNotificationError: safeError(error),
      staffNotifiedAt: new Date(),
      updatedAt: new Date(),
    }).where(and(eq(marketingLeads.id, lead.id), eq(marketingLeads.farmId, lead.farmId)))
    return false
  }
}

function startNotification(lead: MarketingLead): void {
  void notifyMarketingLead(lead).catch((error) => {
    console.warn('Marketing lead notification failed:', safeError(error))
  })
}

publicMarketingLeadRoutes.post('/contact', zValidator('json', contactSchema), async (c) => {
  if (!publicRateLimit(c, 'contact')) return c.json({ error: 'Too many requests - try again shortly.' }, 429)
  const body = c.req.valid('json')
  if (body.honey?.trim()) return c.json(PUBLIC_ACCEPTED, 202)
  const farm = await resolveCustomerFarm()
  if (!farm) return c.json({ error: 'Form service is temporarily unavailable.' }, 503)
  const now = new Date()
  const email = normalizeEmail(body.email)
  const consent = marketingLeadConsentRecord(body.consentVersion)
  const [lead] = await db.insert(marketingLeads).values({
    farmId: farm.id,
    leadType: 'contact',
    name: body.name,
    email,
    phone: body.phone ?? null,
    normalizedContact: `email:${email}`,
    subjectKey: body.subject,
    subjectLabel: SUBJECTS[body.subject],
    message: body.message,
    source: 'marketing_public_contact',
    lastSubmittedAt: now,
    ...consent,
  }).returning()
  startNotification(lead)
  return c.json(PUBLIC_ACCEPTED, 202)
})

publicMarketingLeadRoutes.post('/waitlist', zValidator('json', waitlistSchema), async (c) => {
  if (!publicRateLimit(c, 'waitlist')) return c.json({ error: 'Too many requests - try again shortly.' }, 429)
  const body = c.req.valid('json')
  if (body.honey?.trim()) return c.json(PUBLIC_ACCEPTED, 202)
  const farm = await resolveCustomerFarm()
  if (!farm) return c.json({ error: 'Form service is temporarily unavailable.' }, 503)
  const contact = contactParts(body.contact)
  if (!contact) return c.json({ error: 'Invalid contact' }, 400)
  const now = new Date()
  const consent = marketingLeadConsentRecord(body.consentVersion)
  const [lead] = await db.insert(marketingLeads).values({
    farmId: farm.id,
    leadType: 'product_waitlist',
    name: body.name,
    email: contact.email,
    phone: contact.phone,
    normalizedContact: contact.normalized,
    productKey: body.product,
    productLabel: PRODUCTS[body.product],
    source: 'marketing_public_waitlist',
    lastSubmittedAt: now,
    ...consent,
  }).onConflictDoUpdate({
    target: [marketingLeads.farmId, marketingLeads.productKey, marketingLeads.normalizedContact],
    targetWhere: sql`${marketingLeads.leadType} = 'product_waitlist'`,
    set: {
      name: body.name,
      email: contact.email,
      phone: contact.phone,
      status: sql`case when ${marketingLeads.status} in ('closed', 'spam') then 'new'::marketing_lead_status else ${marketingLeads.status} end`,
      submissionCount: sql`${marketingLeads.submissionCount} + 1`,
      lastSubmittedAt: now,
      consentAt: consent.consentAt,
      consentVersion: consent.consentVersion,
      privacyNoticeUrl: consent.privacyNoticeUrl,
      staffNotificationStatus: 'pending',
      staffNotificationError: null,
      updatedAt: now,
    },
  }).returning()
  startNotification(lead)
  return c.json(PUBLIC_ACCEPTED, 202)
})

function requireLeadRole(role: string): boolean {
  return role === 'owner' || role === 'sales'
}

marketingLeadRoutes.get('/', zValidator('query', listSchema), async (c) => {
  const user = c.get('user')
  if (!requireLeadRole(user.role)) return c.json({ error: 'Forbidden' }, 403)
  const query = c.req.valid('query')
  const filters = [eq(marketingLeads.farmId, user.farmId)]
  if (query.type) filters.push(eq(marketingLeads.leadType, query.type))
  if (query.status) filters.push(eq(marketingLeads.status, query.status))
  if (query.search) {
    const term = `%${query.search.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`
    const search = or(
      ilike(marketingLeads.name, term),
      ilike(marketingLeads.email, term),
      ilike(marketingLeads.phone, term),
      ilike(marketingLeads.subjectLabel, term),
      ilike(marketingLeads.productLabel, term),
      ilike(marketingLeads.message, term),
    )
    if (search) filters.push(search)
  }
  const assignee = alias(users, 'marketing_lead_assignee')
  const leads = await db.select({
    id: marketingLeads.id,
    leadType: marketingLeads.leadType,
    status: marketingLeads.status,
    name: marketingLeads.name,
    email: marketingLeads.email,
    phone: marketingLeads.phone,
    subjectKey: marketingLeads.subjectKey,
    subjectLabel: marketingLeads.subjectLabel,
    message: marketingLeads.message,
    productKey: marketingLeads.productKey,
    productLabel: marketingLeads.productLabel,
    source: marketingLeads.source,
    submissionCount: marketingLeads.submissionCount,
    lastSubmittedAt: marketingLeads.lastSubmittedAt,
    assignedToId: marketingLeads.assignedToId,
    assignedToName: assignee.name,
    notificationStatus: marketingLeads.staffNotificationStatus,
    notificationError: marketingLeads.staffNotificationError,
    notificationAt: marketingLeads.staffNotifiedAt,
    createdAt: marketingLeads.createdAt,
    updatedAt: marketingLeads.updatedAt,
  }).from(marketingLeads)
    .leftJoin(assignee, eq(marketingLeads.assignedToId, assignee.id))
    .where(and(...filters)).orderBy(desc(marketingLeads.lastSubmittedAt)).limit(500)
  const [statusCounts, typeCounts, assignees] = await Promise.all([
    db.select({ value: marketingLeads.status, count: count() }).from(marketingLeads)
      .where(eq(marketingLeads.farmId, user.farmId)).groupBy(marketingLeads.status),
    db.select({ value: marketingLeads.leadType, count: count() }).from(marketingLeads)
      .where(eq(marketingLeads.farmId, user.farmId)).groupBy(marketingLeads.leadType),
    db.select({
      id: users.id,
      name: users.name,
      role: users.role,
      active: users.active,
    }).from(users).where(and(
      eq(users.farmId, user.farmId),
      eq(users.active, true),
      inArray(users.role, ['owner', 'sales']),
    )).orderBy(users.name),
  ])
  const byStatus = Object.fromEntries(leadStatuses.map((status) => [status, 0])) as Record<(typeof leadStatuses)[number], number>
  const byType = Object.fromEntries(leadTypes.map((type) => [type, 0])) as Record<(typeof leadTypes)[number], number>
  for (const row of statusCounts) byStatus[row.value] = Number(row.count)
  for (const row of typeCounts) byType[row.value] = Number(row.count)
  return c.json({
    leads,
    assignees,
    summary: {
      total: Object.values(byStatus).reduce((sum, value) => sum + value, 0),
      byStatus,
      byType,
    },
  })
})

marketingLeadRoutes.patch('/:id', zValidator('json', patchSchema), async (c) => {
  const user = c.get('user')
  if (!requireLeadRole(user.role)) return c.json({ error: 'Forbidden' }, 403)
  const body = c.req.valid('json')
  const [existing] = await db.select().from(marketingLeads).where(and(
    eq(marketingLeads.id, c.req.param('id')),
    eq(marketingLeads.farmId, user.farmId),
  )).limit(1)
  if (!existing) return c.json({ error: 'Not found' }, 404)
  if (body.assignedToId) {
    const [assignee] = await db.select({ id: users.id }).from(users).where(and(
      eq(users.id, body.assignedToId),
      eq(users.farmId, user.farmId),
      eq(users.active, true),
      inArray(users.role, ['owner', 'sales']),
    )).limit(1)
    if (!assignee) return c.json({ error: 'Assignee must be an active owner or sales user in this farm' }, 400)
  }
  const changes: Partial<typeof marketingLeads.$inferInsert> = { updatedAt: new Date() }
  if (body.status !== undefined) changes.status = body.status
  if (body.assignedToId !== undefined) changes.assignedToId = body.assignedToId
  const [lead] = await db.update(marketingLeads).set(changes).where(and(
    eq(marketingLeads.id, existing.id),
    eq(marketingLeads.farmId, user.farmId),
  )).returning()
  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'update',
    entityType: 'marketing_lead',
    entityId: lead.id,
    metadata: {
      status: body.status === undefined ? undefined : { from: existing.status, to: body.status },
      assignedToId: body.assignedToId === undefined ? undefined : { from: existing.assignedToId, to: body.assignedToId },
    },
  })
  return c.json({ lead })
})

marketingLeadRoutes.post('/:id/notify', async (c) => {
  const user = c.get('user')
  if (!requireLeadRole(user.role)) return c.json({ error: 'Forbidden' }, 403)
  const [lead] = await db.select().from(marketingLeads).where(and(
    eq(marketingLeads.id, c.req.param('id')),
    eq(marketingLeads.farmId, user.farmId),
  )).limit(1)
  if (!lead) return c.json({ error: 'Not found' }, 404)
  await db.update(marketingLeads).set({
    staffNotificationStatus: 'pending',
    staffNotificationError: null,
    updatedAt: new Date(),
  }).where(and(eq(marketingLeads.id, lead.id), eq(marketingLeads.farmId, user.farmId)))
  const sent = await notifyMarketingLead(lead)
  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'notify',
    entityType: 'marketing_lead',
    entityId: lead.id,
    metadata: { sent },
  })
  if (!sent) return c.json({ error: 'Staff notification failed; retry remains available.' }, 502)
  return c.json({ sent: true })
})
