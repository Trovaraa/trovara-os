import { and, count, desc, eq, inArray, isNotNull } from 'drizzle-orm'
import { db } from '../db/index.js'
import {
  journalPosts,
  marketingLeads,
  newsletterCampaignDeliveries,
  newsletterCampaigns,
  newsletterSubscribers,
} from '../db/schema.js'
import { emailLayout, escapeEmailHtml } from './email-template.js'
import { sendNewsletterBroadcast } from './newsletter-resend.js'
import { sendEmail } from './notifications.js'
import { normalizeMarketingOrigin } from './public-app-url.js'

export const CAMPAIGN_PRODUCTS = {
  coconut: 'Coconut',
  plantain: 'Plantain',
  poultry: 'Pasture-raised Chicken',
  eggs: 'Pasture-raised Eggs',
  'palm-oil': 'Palm Oil',
} as const

export type CampaignProductKey = keyof typeof CAMPAIGN_PRODUCTS
export type CampaignAudience = 'newsletter' | 'product_waitlist'
export type CampaignType = 'journal' | 'marketing' | 'product_availability'

type CampaignRecord = typeof newsletterCampaigns.$inferSelect

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/re_[A-Za-z0-9_-]+/g, '[redacted]')
    .slice(0, 1_000)
}

function marketingOrigin(): string {
  return normalizeMarketingOrigin(process.env.PUBLIC_MARKETING_URL?.trim() || 'https://trovara.farm')
}

export function newsletterCampaignEmailContent(
  campaign: Pick<CampaignRecord, 'subject' | 'previewText' | 'bodyText' | 'campaignType' | 'ctaLabel' | 'ctaUrl'>,
  options?: { newsletter?: boolean },
): { html: string; text: string } {
  const body = escapeEmailHtml(campaign.bodyText).replaceAll('\n', '<br>')
  const html = emailLayout({
    preheader: campaign.previewText || campaign.subject,
    documentTitle: `${campaign.subject} · Trovara Farm`,
    badge: campaign.campaignType === 'journal' ? 'NEW JOURNAL STORY' : campaign.campaignType === 'product_availability' ? 'NOW AVAILABLE' : 'FROM TROVARA FARM',
    headline: campaign.subject,
    body: `<p style="margin:0;color:#617064;font-size:15px;line-height:1.7">${body}</p>`,
    ...(campaign.ctaLabel && campaign.ctaUrl
      ? { cta: { label: campaign.ctaLabel, href: campaign.ctaUrl } }
      : {}),
    footerVariant: options?.newsletter ? 'newsletter' : 'default',
    ...(options?.newsletter ? { unsubscribeUrl: '{{{RESEND_UNSUBSCRIBE_URL}}}' } : {}),
  })
  const text = [
    campaign.subject,
    '',
    campaign.bodyText,
    campaign.ctaLabel && campaign.ctaUrl ? `\n${campaign.ctaLabel}: ${campaign.ctaUrl}` : '',
    options?.newsletter ? '\nUnsubscribe: {{{RESEND_UNSUBSCRIBE_URL}}}' : '',
  ].filter(Boolean).join('\n')
  return { html, text }
}

export async function campaignAudienceCount(
  farmId: string,
  audienceType: CampaignAudience,
  productKey?: CampaignProductKey,
): Promise<number> {
  if (audienceType === 'newsletter') {
    const [row] = await db
      .select({ count: count() })
      .from(newsletterSubscribers)
      .where(and(
        eq(newsletterSubscribers.farmId, farmId),
        eq(newsletterSubscribers.status, 'confirmed'),
        eq(newsletterSubscribers.resendLastSyncStatus, 'synced'),
      ))
    return Number(row?.count ?? 0)
  }
  if (!productKey) return 0
  const rows = await db
    .select({ email: marketingLeads.email })
    .from(marketingLeads)
    .where(and(
      eq(marketingLeads.farmId, farmId),
      eq(marketingLeads.leadType, 'product_waitlist'),
      eq(marketingLeads.productKey, productKey),
      inArray(marketingLeads.status, ['new', 'in_progress', 'contacted']),
      isNotNull(marketingLeads.email),
      isNotNull(marketingLeads.consentAt),
    ))
  return new Set(rows.map((row) => row.email?.trim().toLowerCase()).filter(Boolean)).size
}

async function prepareProductDeliveries(campaign: CampaignRecord): Promise<number> {
  if (!campaign.productKey || !(campaign.productKey in CAMPAIGN_PRODUCTS)) return 0
  const leads = await db
    .select({
      id: marketingLeads.id,
      email: marketingLeads.email,
      name: marketingLeads.name,
    })
    .from(marketingLeads)
    .where(and(
      eq(marketingLeads.farmId, campaign.farmId),
      eq(marketingLeads.leadType, 'product_waitlist'),
      eq(marketingLeads.productKey, campaign.productKey),
      inArray(marketingLeads.status, ['new', 'in_progress', 'contacted']),
      isNotNull(marketingLeads.email),
      isNotNull(marketingLeads.consentAt),
    ))

  const unique = new Map<string, { id: string; email: string; name: string }>()
  for (const lead of leads) {
    const email = lead.email?.trim().toLowerCase()
    if (email && !unique.has(email)) unique.set(email, { id: lead.id, email, name: lead.name })
  }
  if (unique.size) {
    await db.insert(newsletterCampaignDeliveries).values(
      [...unique.values()].map((lead) => ({
        campaignId: campaign.id,
        farmId: campaign.farmId,
        marketingLeadId: lead.id,
        recipientEmail: lead.email,
        recipientName: lead.name,
      })),
    ).onConflictDoNothing()
  }
  return unique.size
}

export async function dispatchNewsletterCampaign(campaignId: string, farmId: string): Promise<CampaignRecord> {
  const [existing] = await db
    .select()
    .from(newsletterCampaigns)
    .where(and(eq(newsletterCampaigns.id, campaignId), eq(newsletterCampaigns.farmId, farmId)))
    .limit(1)
  if (!existing) throw new Error('Campaign not found')
  if (existing.status === 'sent') return existing
  if (existing.status === 'sending') throw new Error('Campaign delivery is already in progress')

  await db.update(newsletterCampaigns).set({
    status: 'sending',
    lastError: null,
    updatedAt: new Date(),
  }).where(and(eq(newsletterCampaigns.id, campaignId), eq(newsletterCampaigns.farmId, farmId)))

  if (existing.audienceType === 'newsletter') {
    const recipientCount = await campaignAudienceCount(farmId, 'newsletter')
    if (!recipientCount) {
      const [failed] = await db.update(newsletterCampaigns).set({
        status: 'failed',
        recipientCount: 0,
        lastError: 'No confirmed newsletter subscribers are available',
        updatedAt: new Date(),
      }).where(and(eq(newsletterCampaigns.id, campaignId), eq(newsletterCampaigns.farmId, farmId))).returning()
      return failed
    }
    try {
      const content = newsletterCampaignEmailContent(existing, { newsletter: true })
      const providerBroadcastId = await sendNewsletterBroadcast({
        name: `${existing.campaignType}-${existing.id}`,
        subject: existing.subject,
        previewText: existing.previewText,
        html: content.html,
        text: content.text,
      })
      const [sent] = await db.update(newsletterCampaigns).set({
        status: 'sent',
        providerBroadcastId,
        recipientCount,
        // Resend accepted the broadcast for this segment. Per-recipient delivery
        // remains provider-owned; do not mislabel acceptance as inbox delivery.
        deliveredCount: 0,
        failedCount: 0,
        sentAt: new Date(),
        updatedAt: new Date(),
      }).where(and(eq(newsletterCampaigns.id, campaignId), eq(newsletterCampaigns.farmId, farmId))).returning()
      return sent
    } catch (error) {
      const [failed] = await db.update(newsletterCampaigns).set({
        status: 'failed',
        recipientCount,
        lastError: safeError(error),
        updatedAt: new Date(),
      }).where(and(eq(newsletterCampaigns.id, campaignId), eq(newsletterCampaigns.farmId, farmId))).returning()
      return failed
    }
  }

  const recipientCount = await prepareProductDeliveries(existing)
  const deliveries = await db
    .select()
    .from(newsletterCampaignDeliveries)
    .where(and(
      eq(newsletterCampaignDeliveries.campaignId, campaignId),
      eq(newsletterCampaignDeliveries.farmId, farmId),
      inArray(newsletterCampaignDeliveries.status, ['pending', 'failed']),
    ))
  if (!recipientCount && !deliveries.length) {
    const [failed] = await db.update(newsletterCampaigns).set({
      status: 'failed',
      recipientCount: 0,
      lastError: 'No opted-in email contacts are available for this product waitlist',
      updatedAt: new Date(),
    }).where(and(eq(newsletterCampaigns.id, campaignId), eq(newsletterCampaigns.farmId, farmId))).returning()
    return failed
  }

  for (let offset = 0; offset < deliveries.length; offset += 20) {
    const batch = deliveries.slice(offset, offset + 20)
    await Promise.all(batch.map(async (delivery) => {
      const content = newsletterCampaignEmailContent(existing)
      const result = await sendEmail({
        to: delivery.recipientEmail,
        subject: existing.subject,
        text: content.text,
        html: content.html,
      })
      const sent = result.status === 'delivered'
      await db.update(newsletterCampaignDeliveries).set({
        status: sent ? 'sent' : 'failed',
        lastError: sent ? null : `Email provider returned ${result.status}`,
        sentAt: sent ? new Date() : null,
        updatedAt: new Date(),
      }).where(and(
        eq(newsletterCampaignDeliveries.id, delivery.id),
        eq(newsletterCampaignDeliveries.farmId, farmId),
      ))
    }))
  }

  const deliveryCounts = await db
    .select({ status: newsletterCampaignDeliveries.status, count: count() })
    .from(newsletterCampaignDeliveries)
    .where(and(eq(newsletterCampaignDeliveries.campaignId, campaignId), eq(newsletterCampaignDeliveries.farmId, farmId)))
    .groupBy(newsletterCampaignDeliveries.status)
  const sentCount = Number(deliveryCounts.find((row) => row.status === 'sent')?.count ?? 0)
  const failedCount = Number(deliveryCounts.find((row) => row.status === 'failed')?.count ?? 0)
  const status = failedCount === 0 && sentCount > 0 ? 'sent' : sentCount > 0 ? 'partial' : 'failed'
  const [campaign] = await db.update(newsletterCampaigns).set({
    status,
    recipientCount: Math.max(recipientCount, sentCount + failedCount),
    deliveredCount: sentCount,
    failedCount,
    lastError: failedCount ? `${failedCount} product availability email(s) failed` : null,
    sentAt: sentCount ? new Date() : null,
    updatedAt: new Date(),
  }).where(and(eq(newsletterCampaigns.id, campaignId), eq(newsletterCampaigns.farmId, farmId))).returning()
  return campaign
}

export async function createJournalAnnouncement(params: {
  farmId: string
  journalPostId: string
  userId: string
}): Promise<{ campaignId: string; created: boolean } | null> {
  const [post] = await db.select().from(journalPosts).where(and(
    eq(journalPosts.id, params.journalPostId),
    eq(journalPosts.farmId, params.farmId),
    eq(journalPosts.published, true),
  )).limit(1)
  if (!post) return null

  const journalUrl = `${marketingOrigin()}/journal/${encodeURIComponent(post.slug)}`
  const inserted = await db.insert(newsletterCampaigns).values({
    farmId: params.farmId,
    campaignType: 'journal',
    audienceType: 'newsletter',
    journalPostId: post.id,
    subject: `New from the Trovara Journal: ${post.title}`,
    previewText: post.excerpt,
    bodyText: post.excerpt,
    ctaLabel: 'Read the story',
    ctaUrl: journalUrl,
    createdById: params.userId,
  }).onConflictDoNothing().returning({ id: newsletterCampaigns.id })
  if (inserted[0]) return { campaignId: inserted[0].id, created: true }

  const [existing] = await db.select({ id: newsletterCampaigns.id }).from(newsletterCampaigns).where(and(
    eq(newsletterCampaigns.farmId, params.farmId),
    eq(newsletterCampaigns.journalPostId, post.id),
  )).limit(1)
  return existing ? { campaignId: existing.id, created: false } : null
}

export async function listNewsletterCampaigns(farmId: string) {
  return db.select().from(newsletterCampaigns)
    .where(eq(newsletterCampaigns.farmId, farmId))
    .orderBy(desc(newsletterCampaigns.createdAt))
    .limit(100)
}
