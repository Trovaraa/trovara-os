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
const contactSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(320),
  phone: optionalPhone,
  message: z.string().trim().min(1).max(4_000),
  subject: subjectSchema,
  honey: z.string().max(500).optional(),
}).strict()
const waitlistSchema = z.object({
  name: z.string().trim().min(1).max(120),
  contact: z.string().trim().min(5).max(320),
  product: productSchema,
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
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
  const label = isContact ? 'NEW WEBSITE ENQUIRY' : 'NEW PRODUCT WAITLIST JOIN'
  const title = isContact ? 'A new enquiry just came in' : 'Someone joined a product waitlist'
  const contactHref = lead.email
    ? `mailto:${escapeHtml(lead.email)}`
    : lead.phone
      ? `tel:${escapeHtml(lead.phone)}`
      : null
  const contactValue = contactHref
    ? `<a href="${contactHref}" style="color:#276338;text-decoration:none;font-weight:700">${escapeHtml(contact)}</a>`
    : escapeHtml(contact)
  const message = lead.message
    ? `<div style="margin:24px 0 0;padding:18px 20px;background:#f4f7f2;border-left:4px solid #889058;border-radius:0 8px 8px 0">
        <p style="margin:0 0 8px;color:#617064;font-size:11px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase">Message</p>
        <p style="margin:0;color:#28382f;font-size:15px;line-height:1.65">${escapeHtml(lead.message).replace(/\n/g, '<br>')}</p>
      </div>`
    : ''

  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;background:#f1f4ef;color:#28382f;font-family:Arial,Helvetica,sans-serif">
  <div style="display:none;max-height:0;overflow:hidden">${escapeHtml(`${lead.name} submitted ${descriptor}.`)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f4ef">
    <tr>
      <td align="center" style="padding:32px 16px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;background:#ffffff;border:1px solid #dfe8dc;border-radius:14px;overflow:hidden">
          <tr>
            <td style="padding:24px 28px;background:#18311f">
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding-right:12px;vertical-align:middle">
                    <img src="https://trovara.farm/brand/trovara-mark.png" width="46" height="46" alt="" style="display:block;width:46px;height:46px;border:0;border-radius:9px">
                  </td>
                  <td style="vertical-align:middle">
                    <span style="display:block;color:#ffffff;font-size:19px;font-weight:800;letter-spacing:1.5px;line-height:1.1">TROVARA</span>
                    <span style="display:block;margin-top:4px;color:#c5ce82;font-size:9px;font-weight:700;letter-spacing:3.5px;line-height:1">FARM OS</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:32px 28px">
              <span style="display:inline-block;padding:6px 10px;background:#edf4e9;color:#276338;border-radius:999px;font-size:10px;font-weight:800;letter-spacing:1px">${label}</span>
              <h1 style="margin:16px 0 8px;color:#18311f;font-size:27px;line-height:1.25">${title}</h1>
              <p style="margin:0 0 26px;color:#617064;font-size:15px;line-height:1.6">Review the details below and follow up while the enquiry is fresh.</p>

              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #e2e9df;border-radius:10px">
                <tr>
                  <td style="width:34%;padding:13px 16px;border-bottom:1px solid #e8eee5;color:#718075;font-size:12px;font-weight:700;text-transform:uppercase">Name</td>
                  <td style="padding:13px 16px;border-bottom:1px solid #e8eee5;color:#28382f;font-size:14px;font-weight:700">${escapeHtml(lead.name)}</td>
                </tr>
                <tr>
                  <td style="padding:13px 16px;border-bottom:1px solid #e8eee5;color:#718075;font-size:12px;font-weight:700;text-transform:uppercase">Contact</td>
                  <td style="padding:13px 16px;border-bottom:1px solid #e8eee5;font-size:14px">${contactValue}</td>
                </tr>
                <tr>
                  <td style="padding:13px 16px;border-bottom:1px solid #e8eee5;color:#718075;font-size:12px;font-weight:700;text-transform:uppercase">${isContact ? 'Topic' : 'Product'}</td>
                  <td style="padding:13px 16px;border-bottom:1px solid #e8eee5;color:#28382f;font-size:14px">${escapeHtml(descriptor)}</td>
                </tr>
                <tr>
                  <td style="padding:13px 16px;color:#718075;font-size:12px;font-weight:700;text-transform:uppercase">Submissions</td>
                  <td style="padding:13px 16px;color:#28382f;font-size:14px">${lead.submissionCount}</td>
                </tr>
              </table>

              ${message}

              <p style="margin:28px 0 0">
                <a href="${escapeHtml(marketingLeadsUrl())}" style="display:inline-block;padding:13px 20px;background:#2f6b3b;color:#ffffff;text-decoration:none;border-radius:8px;font-size:14px;font-weight:700">Open in Trovara OS</a>
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:18px 28px;background:#f8faf7;border-top:1px solid #e2e9df;color:#718075;font-size:12px;line-height:1.5">
              Sent automatically because you are an active Owner or Sales user in Trovara OS.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
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
