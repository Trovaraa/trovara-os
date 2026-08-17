import { zValidator } from '@hono/zod-validator'
import { and, count, desc, eq, ilike, inArray, ne, or, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { db } from '../db/index.js'
import { customerSurveyResponses, marketingLeads, users } from '../db/schema.js'
import { clientIpFromHeaders } from '../lib/client-ip.js'
import { resolveCustomerFarm } from '../lib/customer-orders.js'
import {
  CUSTOMER_SURVEY_KEY,
  CUSTOMER_SURVEY_SOURCE,
  DEFAULT_SURVEY_PRIVACY_NOTICE_URL,
  customerSurveySchema,
  parseCustomerSurvey,
  presentSurveyAnswers,
  surveyFollowUpMessage,
  type ParsedCustomerSurvey,
  type SurveyAnswers,
} from '../lib/customer-survey.js'
import {
  escapeEmailHtml,
  marketingLeadEmailContent,
} from '../lib/email-template.js'
import { sendEmail } from '../lib/notifications.js'
import { checkDurableRateLimit } from '../lib/rate-limit.js'
import { getBreakGlassEmail } from '../lib/registration.js'
import { hasPermission } from '../lib/rbac.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import type { SessionUser } from '../lib/session.js'

const PUBLIC_ACCEPTED = { ok: true, accepted: true }
const followUpValues = ['yes', 'maybe', 'no'] as const

export const publicCustomerSurveyRoutes = new Hono()
export const customerSurveyRoutes = new Hono<{ Variables: AppVariables }>()
customerSurveyRoutes.use('*', authMiddleware)

function canManageSurveys(user: SessionUser): boolean {
  return hasPermission(user, 'leads.manage')
}

async function publicRateLimit(c: {
  req: { header: (name: string) => string | undefined }
  header: (name: string, value: string) => void
}): Promise<boolean> {
  const ip = clientIpFromHeaders((name) => c.req.header(name)) ?? 'unknown'
  const result = await checkDurableRateLimit(`customer-surveys:${ip}`, 8, 60_000)
  if (!result.allowed) c.header('Retry-After', String(result.retryAfterSec))
  return result.allowed
}

function surveysUrl(): string {
  const base = process.env.PUBLIC_APP_URL?.trim() || 'https://os.trovara.farm'
  try {
    return new URL('/customer-surveys', base).toString()
  } catch {
    return 'https://os.trovara.farm/customer-surveys'
  }
}

function configuredSurveyRecipients(): Array<{ email: string }> | null {
  const configured = process.env.MARKETING_LEAD_NOTIFICATION_EMAILS?.trim()
  if (!configured) return null
  return [...new Set(
    configured
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  )].map((email) => ({ email }))
}

function asSurveyAnswers(value: unknown): SurveyAnswers | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const answers = value as SurveyAnswers
  if (!answers.location || !answers.household || !answers.oneChange) return null
  return answers
}

function serializeSurvey(row: typeof customerSurveyResponses.$inferSelect) {
  const answers = asSurveyAnswers(row.answers)
  return {
    id: row.id,
    surveyKey: row.surveyKey,
    followUp: row.followUp,
    name: row.name,
    email: row.email,
    phone: row.phone,
    source: row.source,
    utmSource: row.utmSource,
    utmMedium: row.utmMedium,
    utmCampaign: row.utmCampaign,
    referrer: row.referrer,
    leadId: row.leadId,
    consentVersion: row.consentVersion,
    createdAt: row.createdAt,
    answers: answers ? presentSurveyAnswers(answers) : [],
  }
}

async function surveyRecipients(farmId: string): Promise<Array<{ email: string }>> {
  return configuredSurveyRecipients() ?? db
    .select({ email: users.email })
    .from(users)
    .where(
      and(
        eq(users.farmId, farmId),
        eq(users.active, true),
        inArray(users.role, ['owner', 'sales']),
        ne(users.email, getBreakGlassEmail()),
      ),
    )
}

function surveyNotificationHtml(
  parsed: ParsedCustomerSurvey,
  contact: string,
): string {
  const presented = presentSurveyAnswers(parsed.answers)
  const followUpLabel = parsed.followUp === 'no' ? 'No follow-up' : `Follow-up: ${parsed.followUp}`
  return marketingLeadEmailContent({
    badge: 'NEW FOOD SURVEY',
    headline: parsed.followUp === 'no'
      ? 'A new food survey response came in'
      : 'A survey respondent wants a follow-up',
    intro: 'Answers are stored in Trovara OS. Use them to learn how households buy fresh food.',
    preheader: `${followUpLabel}. ${parsed.answers.oneChange}`,
    rows: [
      { label: 'Name', valueHtml: escapeEmailHtml(parsed.name ?? 'Not provided') },
      { label: 'Contact', valueHtml: escapeEmailHtml(contact) },
      { label: 'Follow-up', valueHtml: escapeEmailHtml(followUpLabel) },
      {
        label: 'Where they live',
        valueHtml: escapeEmailHtml(presented.find((row) => row.key === 'location')?.value ?? ''),
      },
      {
        label: 'Biggest problem',
        valueHtml: escapeEmailHtml(presented.find((row) => row.key === 'topFrustration')?.value ?? ''),
      },
    ],
    messageHtml: escapeEmailHtml(parsed.answers.oneChange).replace(/\n/g, '<br>'),
    ctaHref: surveysUrl(),
    ctaLabel: 'Open survey responses',
  })
}

async function notifySurvey(farmId: string, parsed: ParsedCustomerSurvey): Promise<void> {
  const recipients = await surveyRecipients(farmId)
  const contact = parsed.contact?.email ?? parsed.contact?.phone ?? 'Not provided'
  const subject = parsed.followUp === 'no'
    ? 'New Trovara food survey response'
    : `Food survey follow-up (${parsed.followUp}): ${contact}`
  const text = [
    `Follow-up: ${parsed.followUp}`,
    `Name: ${parsed.name ?? 'Not provided'}`,
    `Contact: ${contact}`,
    `One change: ${parsed.answers.oneChange}`,
    `Biggest problem: ${parsed.answers.topFrustration}`,
  ].join('\n\n')
  const html = surveyNotificationHtml(parsed, contact)
  await Promise.all(recipients.map(({ email }) => sendEmail({
    to: email,
    subject,
    text,
    html,
    replyTo: parsed.contact?.email ?? undefined,
  })))
}

function startSurveyNotification(farmId: string, parsed: ParsedCustomerSurvey): void {
  void notifySurvey(farmId, parsed).catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    console.warn('Customer survey notification failed:', message.slice(0, 1000))
  })
}

publicCustomerSurveyRoutes.post('/', zValidator('json', customerSurveySchema), async (c) => {
  if (!(await publicRateLimit(c))) return c.json({ error: 'Too many requests - try again shortly.' }, 429)
  const body = c.req.valid('json')
  if (body.honey?.trim()) return c.json(PUBLIC_ACCEPTED, 202)
  const farm = await resolveCustomerFarm()
  if (!farm) return c.json({ error: 'Form service is temporarily unavailable.' }, 503)

  const parsed = parseCustomerSurvey(body)
  const now = new Date()
  let leadId: string | null = null

  if (parsed.followUp !== 'no' && parsed.contact) {
    const [lead] = await db.insert(marketingLeads).values({
      farmId: farm.id,
      leadType: 'survey_followup',
      name: parsed.name || 'Survey respondent',
      email: parsed.contact.email,
      phone: parsed.contact.phone,
      normalizedContact: parsed.contact.normalized,
      subjectKey: 'survey',
      subjectLabel: 'Customer food survey',
      message: surveyFollowUpMessage(parsed.answers),
      source: CUSTOMER_SURVEY_SOURCE,
      lastSubmittedAt: now,
      consentAt: now,
      consentVersion: parsed.consentVersion,
      privacyNoticeUrl: DEFAULT_SURVEY_PRIVACY_NOTICE_URL,
    }).returning()
    leadId = lead?.id ?? null
  }

  await db.insert(customerSurveyResponses).values({
    farmId: farm.id,
    surveyKey: CUSTOMER_SURVEY_KEY,
    answers: parsed.answers,
    followUp: parsed.followUp,
    name: parsed.name,
    email: parsed.contact?.email ?? null,
    phone: parsed.contact?.phone ?? null,
    normalizedContact: parsed.contact?.normalized ?? null,
    leadId,
    source: CUSTOMER_SURVEY_SOURCE,
    utmSource: parsed.attribution.utmSource,
    utmMedium: parsed.attribution.utmMedium,
    utmCampaign: parsed.attribution.utmCampaign,
    referrer: parsed.attribution.referrer,
    consentAt: now,
    consentVersion: parsed.consentVersion,
    privacyNoticeUrl: DEFAULT_SURVEY_PRIVACY_NOTICE_URL,
  })

  startSurveyNotification(farm.id, parsed)
  return c.json(PUBLIC_ACCEPTED, 202)
})

const listSchema = z.object({
  followUp: z.enum(followUpValues).optional(),
  search: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(10).max(100).default(50),
})

type SurveyListQuery = z.infer<typeof listSchema>

function listFilters(farmId: string, query: Pick<SurveyListQuery, 'followUp' | 'search'>) {
  const filters = [eq(customerSurveyResponses.farmId, farmId)]
  if (query.followUp) filters.push(eq(customerSurveyResponses.followUp, query.followUp))
  if (query.search) {
    const term = `%${query.search.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`
    const search = or(
      ilike(customerSurveyResponses.name, term),
      ilike(customerSurveyResponses.email, term),
      ilike(customerSurveyResponses.phone, term),
      sql`${customerSurveyResponses.answers}::text ilike ${term}`,
    )
    if (search) filters.push(search)
  }
  return filters
}

function csvCell(value: unknown): string {
  let text = value == null ? '' : String(value)
  // User-entered survey text must not become an executable spreadsheet formula.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return `"${text.replaceAll('"', '""')}"`
}

function surveysCsv(rows: Array<typeof customerSurveyResponses.$inferSelect>): string {
  const serialized = rows.map(serializeSurvey)
  const answerColumns = new Map<string, string>()
  for (const row of serialized) {
    for (const answer of row.answers) answerColumns.set(answer.key, answer.label)
  }
  const answerEntries = [...answerColumns.entries()]
  const header = [
    'Created at',
    'Follow-up',
    'Name',
    'Email',
    'Phone',
    'Source',
    ...answerEntries.map(([, label]) => label),
  ]
  const lines = [header.map(csvCell).join(',')]
  for (const row of serialized) {
    const answers = new Map(row.answers.map((answer) => [answer.key, answer.value]))
    lines.push([
      row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
      row.followUp,
      row.name,
      row.email,
      row.phone,
      row.source,
      ...answerEntries.map(([key]) => answers.get(key) ?? ''),
    ].map(csvCell).join(','))
  }
  return `\uFEFF${lines.join('\n')}`
}

customerSurveyRoutes.get('/export', zValidator('query', listSchema.omit({ page: true, pageSize: true })), async (c) => {
  const user = c.get('user')
  if (!canManageSurveys(user)) return c.json({ error: 'Forbidden' }, 403)
  const query = c.req.valid('query')
  const rows = await db
    .select()
    .from(customerSurveyResponses)
    .where(and(...listFilters(user.farmId, query)))
    .orderBy(desc(customerSurveyResponses.createdAt))

  c.header('Content-Type', 'text/csv; charset=utf-8')
  c.header('Content-Disposition', `attachment; filename="food-surveys-${new Date().toISOString().slice(0, 10)}.csv"`)
  return c.body(surveysCsv(rows))
})

customerSurveyRoutes.get('/', zValidator('query', listSchema), async (c) => {
  const user = c.get('user')
  if (!canManageSurveys(user)) return c.json({ error: 'Forbidden' }, 403)
  const query = c.req.valid('query')
  const filters = listFilters(user.farmId, query)
  const offset = (query.page - 1) * query.pageSize

  const rows = await db
    .select()
    .from(customerSurveyResponses)
    .where(and(...filters))
    .orderBy(desc(customerSurveyResponses.createdAt))
    .limit(query.pageSize + 1)
    .offset(offset)

  const [followUpCounts] = await Promise.all([
    db
      .select({ value: customerSurveyResponses.followUp, count: count() })
      .from(customerSurveyResponses)
      .where(eq(customerSurveyResponses.farmId, user.farmId))
      .groupBy(customerSurveyResponses.followUp),
  ])

  const byFollowUp = { yes: 0, maybe: 0, no: 0 }
  for (const row of followUpCounts) {
    if (row.value === 'yes' || row.value === 'maybe' || row.value === 'no') {
      byFollowUp[row.value] = Number(row.count)
    }
  }

  return c.json({
    responses: rows.slice(0, query.pageSize).map(serializeSurvey),
    page: query.page,
    pageSize: query.pageSize,
    hasMore: rows.length > query.pageSize,
    summary: {
      total: byFollowUp.yes + byFollowUp.maybe + byFollowUp.no,
      byFollowUp,
    },
  })
})
