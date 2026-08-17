import { zValidator } from '@hono/zod-validator'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { db } from '../db/index.js'
import { newsletterCampaigns } from '../db/schema.js'
import { logAudit } from '../lib/audit.js'
import {
  CAMPAIGN_PRODUCTS,
  campaignAudienceCount,
  dispatchNewsletterCampaign,
  listNewsletterCampaigns,
  type CampaignProductKey,
} from '../lib/newsletter-campaigns.js'
import { requestAccessMeta } from '../lib/request-access-meta.js'
import { hasPermission } from '../lib/rbac.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'

const productKeys = Object.keys(CAMPAIGN_PRODUCTS) as [CampaignProductKey, ...CampaignProductKey[]]
const absoluteUrl = z.string().trim().url().max(1_000).refine((value) => {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol)
  } catch {
    return false
  }
}, 'CTA URL must use HTTP or HTTPS')

const audienceQuerySchema = z.object({
  audienceType: z.enum(['newsletter', 'product_waitlist']),
  productKey: z.enum(productKeys).optional(),
}).superRefine((value, context) => {
  if (value.audienceType === 'product_waitlist' && !value.productKey) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['productKey'], message: 'Product is required' })
  }
})

const createCampaignSchema = z.object({
  audienceType: z.enum(['newsletter', 'product_waitlist']),
  productKey: z.enum(productKeys).optional(),
  subject: z.string().trim().min(3).max(200),
  previewText: z.string().trim().max(240).optional(),
  bodyText: z.string().trim().min(3).max(10_000),
  ctaLabel: z.string().trim().min(1).max(80).optional(),
  ctaUrl: absoluteUrl.optional(),
}).strict().superRefine((value, context) => {
  if (value.audienceType === 'product_waitlist' && !value.productKey) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['productKey'], message: 'Product is required' })
  }
  if ((value.ctaLabel && !value.ctaUrl) || (value.ctaUrl && !value.ctaLabel)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['ctaUrl'], message: 'CTA label and URL must be provided together' })
  }
})

export const newsletterCampaignRoutes = new Hono<{ Variables: AppVariables }>()
newsletterCampaignRoutes.use('*', authMiddleware)

newsletterCampaignRoutes.get('/', async (c) => {
  const user = c.get('user')
  if (!hasPermission(user, 'newsletter.manage')) return c.json({ error: 'Forbidden' }, 403)
  return c.json({ campaigns: await listNewsletterCampaigns(user.farmId) })
})

newsletterCampaignRoutes.get('/audience', zValidator('query', audienceQuerySchema), async (c) => {
  const user = c.get('user')
  if (!hasPermission(user, 'newsletter.manage')) return c.json({ error: 'Forbidden' }, 403)
  const query = c.req.valid('query')
  const recipientCount = await campaignAudienceCount(user.farmId, query.audienceType, query.productKey)
  return c.json({ recipientCount })
})

newsletterCampaignRoutes.post('/', zValidator('json', createCampaignSchema), async (c) => {
  const user = c.get('user')
  if (!hasPermission(user, 'newsletter.manage')) return c.json({ error: 'Forbidden' }, 403)
  const body = c.req.valid('json')
  const recipientCount = await campaignAudienceCount(user.farmId, body.audienceType, body.productKey)
  if (!recipientCount) return c.json({ error: 'No eligible email recipients are in this audience.' }, 409)

  const [campaign] = await db.insert(newsletterCampaigns).values({
    farmId: user.farmId,
    campaignType: body.audienceType === 'newsletter' ? 'marketing' : 'product_availability',
    audienceType: body.audienceType,
    productKey: body.audienceType === 'product_waitlist' ? body.productKey : null,
    subject: body.subject,
    previewText: body.previewText || null,
    bodyText: body.bodyText,
    ctaLabel: body.ctaLabel || null,
    ctaUrl: body.ctaUrl || null,
    recipientCount,
    createdById: user.id,
  }).returning()

  const sent = await dispatchNewsletterCampaign(campaign.id, user.farmId)
  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'send',
    entityType: 'newsletter_campaign',
    entityId: campaign.id,
    access: requestAccessMeta((name) => c.req.header(name)),
    metadata: {
      audienceType: body.audienceType,
      productKey: body.productKey,
      recipientCount: sent.recipientCount,
      status: sent.status,
    },
  })
  if (sent.status === 'failed') return c.json({ campaign: sent, error: sent.lastError || 'Campaign delivery failed.' }, 502)
  return c.json({ campaign: sent }, 201)
})

newsletterCampaignRoutes.post('/:id/send', async (c) => {
  const user = c.get('user')
  if (!hasPermission(user, 'newsletter.manage')) return c.json({ error: 'Forbidden' }, 403)
  const [existing] = await db.select({ id: newsletterCampaigns.id }).from(newsletterCampaigns).where(and(
    eq(newsletterCampaigns.id, c.req.param('id')),
    eq(newsletterCampaigns.farmId, user.farmId),
  )).limit(1)
  if (!existing) return c.json({ error: 'Not found' }, 404)
  const campaign = await dispatchNewsletterCampaign(existing.id, user.farmId)
  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'retry_send',
    entityType: 'newsletter_campaign',
    entityId: campaign.id,
    access: requestAccessMeta((name) => c.req.header(name)),
    metadata: { status: campaign.status },
  })
  if (campaign.status === 'failed') return c.json({ campaign, error: campaign.lastError || 'Campaign delivery failed.' }, 502)
  return c.json({ campaign })
})
