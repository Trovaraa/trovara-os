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
import { getNewsletterBroadcast, sendNewsletterBroadcast } from './newsletter-resend.js'
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

async function prepareNewsletterDeliveries(campaign: CampaignRecord): Promise<number> {
  const subscribers = await db
    .select({
      id: newsletterSubscribers.id,
      email: newsletterSubscribers.email,
      name: newsletterSubscribers.fullName,
    })
    .from(newsletterSubscribers)
    .where(and(
      eq(newsletterSubscribers.farmId, campaign.farmId),
      eq(newsletterSubscribers.status, 'confirmed'),
      eq(newsletterSubscribers.resendLastSyncStatus, 'synced'),
    ))

  if (subscribers.length) {
    await db.insert(newsletterCampaignDeliveries).values(
      subscribers.map((subscriber) => ({
        campaignId: campaign.id,
        farmId: campaign.farmId,
        newsletterSubscriberId: subscriber.id,
        recipientEmail: subscriber.email.trim().toLowerCase(),
        recipientName: subscriber.name,
      })),
    ).onConflictDoNothing()
  }
  return subscribers.length
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
    const recipientCount = await prepareNewsletterDeliveries(existing)
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
      const provider = await sendNewsletterBroadcast({
        name: `${existing.campaignType}-${existing.id}`,
        subject: existing.subject,
        previewText: existing.previewText,
        html: content.html,
        text: content.text,
      })
      const [sent] = await db.update(newsletterCampaigns).set({
        status: provider.status === 'sent' ? 'sent' : 'sending',
        providerBroadcastId: provider.id,
        providerStatus: provider.status,
        recipientCount,
        // Resend accepted the broadcast for this segment. Per-recipient delivery
        // remains provider-owned; do not mislabel acceptance as inbox delivery.
        deliveredCount: 0,
        failedCount: 0,
        sentAt: provider.sentAt ? new Date(provider.sentAt) : null,
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

async function refreshProviderStatus(campaign: CampaignRecord): Promise<CampaignRecord> {
  if (!campaign.providerBroadcastId) return campaign
  try {
    const provider = await getNewsletterBroadcast(campaign.providerBroadcastId)
    const [updated] = await db.update(newsletterCampaigns).set({
      providerStatus: provider.status,
      status: provider.status === 'sent'
        ? campaign.failedCount > 0 ? 'partial' : 'sent'
        : 'sending',
      sentAt: provider.sentAt ? new Date(provider.sentAt) : campaign.sentAt,
      updatedAt: new Date(),
    }).where(and(
      eq(newsletterCampaigns.id, campaign.id),
      eq(newsletterCampaigns.farmId, campaign.farmId),
    )).returning()
    return updated ?? campaign
  } catch {
    // A provider status lookup must not hide campaign history from the UI.
    return campaign
  }
}

export type NewsletterDeliveryEvent =
  | 'email.sent'
  | 'email.scheduled'
  | 'email.delivered'
  | 'email.delivery_delayed'
  | 'email.failed'
  | 'email.suppressed'
  | 'email.bounced'
  | 'email.complained'

function deliveryStatusForEvent(eventType: NewsletterDeliveryEvent) {
  if (eventType === 'email.delivered') return 'delivered' as const
  if (eventType === 'email.delivery_delayed') return 'delayed' as const
  if (eventType === 'email.sent') return 'sent' as const
  if (eventType === 'email.scheduled') return 'pending' as const
  return 'failed' as const
}

export async function recordNewsletterCampaignDeliveryEvent(params: {
  farmId: string
  broadcastId: string
  eventType: NewsletterDeliveryEvent
  recipients: string[]
}): Promise<void> {
  const [campaign] = await db.select().from(newsletterCampaigns).where(and(
    eq(newsletterCampaigns.farmId, params.farmId),
    eq(newsletterCampaigns.providerBroadcastId, params.broadcastId),
  )).limit(1)
  if (!campaign) return

  const emails = [...new Set(params.recipients.map((email) => email.trim().toLowerCase()).filter(Boolean))]
  if (!emails.length) return
  const subscribers = await db.select({
    id: newsletterSubscribers.id,
    email: newsletterSubscribers.email,
    name: newsletterSubscribers.fullName,
  }).from(newsletterSubscribers).where(and(
    eq(newsletterSubscribers.farmId, params.farmId),
    inArray(newsletterSubscribers.email, emails),
  ))
  const byEmail = new Map(subscribers.map((subscriber) => [subscriber.email, subscriber]))
  const status = deliveryStatusForEvent(params.eventType)
  await db.insert(newsletterCampaignDeliveries).values(emails.map((email) => ({
    campaignId: campaign.id,
    farmId: params.farmId,
    newsletterSubscriberId: byEmail.get(email)?.id ?? null,
    recipientEmail: email,
    recipientName: byEmail.get(email)?.name ?? email,
    status,
    lastError: status === 'failed' ? `Resend reported ${params.eventType}` : null,
    sentAt: status === 'delivered' || status === 'sent' ? new Date() : null,
  }))).onConflictDoNothing()

  const eligiblePriorStatuses = status === 'sent'
    ? ['pending', 'delayed']
    : status === 'delayed'
      ? ['pending', 'sent']
      : ['pending', 'sent', 'delayed', 'delivered', 'failed']
  await db.update(newsletterCampaignDeliveries).set({
    status,
    lastError: status === 'failed' ? `Resend reported ${params.eventType}` : null,
    sentAt: status === 'delivered' || status === 'sent' ? new Date() : null,
    updatedAt: new Date(),
  }).where(and(
    eq(newsletterCampaignDeliveries.campaignId, campaign.id),
    eq(newsletterCampaignDeliveries.farmId, params.farmId),
    inArray(newsletterCampaignDeliveries.recipientEmail, emails),
    inArray(newsletterCampaignDeliveries.status, eligiblePriorStatuses),
  ))

  const counts = await db.select({
    status: newsletterCampaignDeliveries.status,
    count: count(),
  }).from(newsletterCampaignDeliveries).where(and(
    eq(newsletterCampaignDeliveries.campaignId, campaign.id),
    eq(newsletterCampaignDeliveries.farmId, params.farmId),
  )).groupBy(newsletterCampaignDeliveries.status)
  const countFor = (value: string) => Number(counts.find((row) => row.status === value)?.count ?? 0)
  const deliveredCount = countFor('delivered')
  const failedCount = countFor('failed')
  const trackedCount = counts.reduce((total, row) => total + Number(row.count), 0)
  const campaignStatus = failedCount >= Math.max(campaign.recipientCount, trackedCount)
    ? 'failed'
    : failedCount > 0
      ? 'partial'
      : 'sent'
  await db.update(newsletterCampaigns).set({
    status: campaignStatus,
    providerStatus: params.eventType === 'email.scheduled' ? 'queued' : 'sent',
    recipientCount: Math.max(campaign.recipientCount, trackedCount),
    deliveredCount,
    failedCount,
    lastError: failedCount ? `${failedCount} newsletter email(s) failed provider delivery` : null,
    sentAt: campaign.sentAt ?? new Date(),
    updatedAt: new Date(),
  }).where(and(
    eq(newsletterCampaigns.id, campaign.id),
    eq(newsletterCampaigns.farmId, params.farmId),
  ))
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
  const campaigns = await db.select().from(newsletterCampaigns)
    .where(eq(newsletterCampaigns.farmId, farmId))
    .orderBy(desc(newsletterCampaigns.createdAt))
    .limit(100)
  const refreshIds = new Set(campaigns
    .filter((campaign) => campaign.providerBroadcastId && campaign.providerStatus !== 'sent')
    .slice(0, 10)
    .map((campaign) => campaign.id))
  if (!refreshIds.size) return campaigns
  return Promise.all(campaigns.map((campaign) => refreshIds.has(campaign.id)
    ? refreshProviderStatus(campaign)
    : campaign))
}
