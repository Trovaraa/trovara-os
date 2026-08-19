import { zValidator } from '@hono/zod-validator'
import { and, count, countDistinct, desc, eq, isNotNull, ne, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { db } from '../db/index.js'
import {
  customerCreditInvitations,
  customerCreditLedger,
  customerSurveyResponses,
} from '../db/schema.js'
import { logAudit } from '../lib/audit.js'
import {
  createOrRefreshCreditInvitation,
  markCreditInvitationSent,
} from '../lib/customer-credits.js'
import {
  trovaraCreditInvitationEmailContent,
  trovaraCreditsReadyEmailContent,
} from '../lib/email-template.js'
import { emailProviderReady, sendEmail } from '../lib/notifications.js'
import { requestAccessMeta } from '../lib/request-access-meta.js'
import { shopAccountUrl, shopCreditClaimUrl } from '../lib/public-app-url.js'
import { hasPermission } from '../lib/rbac.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'

const sendSchema = z.object({ confirm: z.literal(true) }).strict()
const sendOneSchema = z.object({
  confirm: z.literal(true),
  email: z.string().trim().email().max(254),
}).strict()

export const customerCreditRoutes = new Hono<{ Variables: AppVariables }>()
customerCreditRoutes.use('*', authMiddleware)

function canManageCredits(user: Parameters<typeof hasPermission>[0]): boolean {
  return hasPermission(user, 'newsletter.manage') || hasPermission(user, 'leads.manage')
}

async function creditSummary(farmId: string) {
  const [[eligible], [sent], [claimed], [credited]] = await Promise.all([
    db
      .select({ count: countDistinct(customerSurveyResponses.email) })
      .from(customerSurveyResponses)
      .where(
        and(
          eq(customerSurveyResponses.farmId, farmId),
          ne(customerSurveyResponses.followUp, 'no'),
          isNotNull(customerSurveyResponses.email),
        ),
      ),
    db
      .select({ count: count() })
      .from(customerCreditInvitations)
      .where(
        and(
          eq(customerCreditInvitations.farmId, farmId),
          isNotNull(customerCreditInvitations.sentAt),
        ),
      ),
    db
      .select({ count: count() })
      .from(customerCreditInvitations)
      .where(
        and(
          eq(customerCreditInvitations.farmId, farmId),
          isNotNull(customerCreditInvitations.claimedAt),
        ),
      ),
    db
      .select({ count: countDistinct(customerCreditLedger.accountId) })
      .from(customerCreditLedger)
      .where(
        and(
          eq(customerCreditLedger.farmId, farmId),
          eq(customerCreditLedger.eventType, 'welcome'),
        ),
      ),
  ])
  return {
    eligible: eligible?.count ?? 0,
    invitationsSent: sent?.count ?? 0,
    invitationsClaimed: claimed?.count ?? 0,
    accountsCredited: credited?.count ?? 0,
  }
}

async function eligibleCreditRecipients(farmId: string, onlyEmail?: string) {
  const filters = [
    eq(customerSurveyResponses.farmId, farmId),
    ne(customerSurveyResponses.followUp, 'no'),
    isNotNull(customerSurveyResponses.email),
  ]
  if (onlyEmail) {
    filters.push(sql`lower(${customerSurveyResponses.email}) = ${onlyEmail.trim().toLowerCase()}`)
  }

  return db
    .selectDistinctOn([customerSurveyResponses.email], {
      id: customerSurveyResponses.id,
      email: customerSurveyResponses.email,
      name: customerSurveyResponses.name,
      leadId: customerSurveyResponses.leadId,
      createdAt: customerSurveyResponses.createdAt,
    })
    .from(customerSurveyResponses)
    .where(and(...filters))
    .orderBy(customerSurveyResponses.email, desc(customerSurveyResponses.createdAt))
}

type CreditRecipient = Awaited<ReturnType<typeof eligibleCreditRecipients>>[number]

async function deliverCreditInvitations(
  rows: CreditRecipient[],
  user: AppVariables['user'],
) {
  const result = {
    eligible: rows.length,
    invitationsSent: 0,
    accountsCredited: 0,
    alreadyProcessed: 0,
    failed: 0,
  }

  for (const row of rows) {
    if (!row.email) continue
    try {
      const invitation = await createOrRefreshCreditInvitation({
        farmId: user.farmId,
        email: row.email,
        name: row.name,
        surveyResponseId: row.id,
        marketingLeadId: row.leadId,
        createdById: user.id,
      })
      if (invitation.kind === 'already_invited') {
        result.alreadyProcessed += 1
        continue
      }
      if (invitation.kind === 'account_ready') {
        if (!invitation.awarded) {
          result.alreadyProcessed += 1
          continue
        }
        const mail = trovaraCreditsReadyEmailContent(invitation.name, shopAccountUrl())
        const delivery = await sendEmail({
          to: invitation.email,
          subject: mail.subject,
          text: mail.text,
          html: mail.html,
        })
        result.accountsCredited += 1
        if (delivery.status !== 'delivered') result.failed += 1
        continue
      }

      const mail = trovaraCreditInvitationEmailContent(
        invitation.name,
        shopCreditClaimUrl(invitation.rawToken),
      )
      const delivery = await sendEmail({
        to: invitation.email,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      })
      if (delivery.status === 'delivered') {
        await markCreditInvitationSent(invitation.id)
        result.invitationsSent += 1
      } else {
        result.failed += 1
      }
    } catch (error) {
      result.failed += 1
      const message = error instanceof Error ? error.message : String(error)
      console.warn('Trovara Credits invitation failed:', message.slice(0, 500))
    }
  }

  return result
}

customerCreditRoutes.get('/summary', async (c) => {
  const user = c.get('user')
  if (!canManageCredits(user)) return c.json({ error: 'Forbidden' }, 403)
  return c.json({ summary: await creditSummary(user.farmId) })
})

customerCreditRoutes.post('/invitations/send', zValidator('json', sendSchema), async (c) => {
  const user = c.get('user')
  if (!canManageCredits(user)) return c.json({ error: 'Forbidden' }, 403)
  if (!emailProviderReady()) {
    return c.json({ error: 'Email delivery is not configured.' }, 503)
  }

  const result = await deliverCreditInvitations(
    await eligibleCreditRecipients(user.farmId),
    user,
  )

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'trovara_credits_invitation_send',
    entityType: 'customer_credit_invitation',
    access: requestAccessMeta((name) => c.req.header(name)),
    metadata: result,
  })
  return c.json({ result, summary: await creditSummary(user.farmId) })
})

customerCreditRoutes.post('/invitations/send-one', zValidator('json', sendOneSchema), async (c) => {
  const user = c.get('user')
  if (!canManageCredits(user)) return c.json({ error: 'Forbidden' }, 403)
  if (!emailProviderReady()) {
    return c.json({ error: 'Email delivery is not configured.' }, 503)
  }

  const { email } = c.req.valid('json')
  const rows = await eligibleCreditRecipients(user.farmId, email)
  if (!rows.length) {
    return c.json({ error: 'That email is not an eligible survey respondent.' }, 404)
  }

  const result = await deliverCreditInvitations(rows, user)
  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'trovara_credits_invitation_send',
    entityType: 'customer_credit_invitation',
    entityId: rows[0]?.id,
    access: requestAccessMeta((name) => c.req.header(name)),
    metadata: { ...result, mode: 'single' },
  })
  return c.json({ result, summary: await creditSummary(user.farmId) })
})
