import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { and, eq, isNotNull } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db/index.js'
import { careerPosts } from '../db/schema.js'
import { resolveCustomerFarm } from '../lib/customer-orders.js'
import { checkDurableRateLimit } from '../lib/rate-limit.js'
import { clientIpFromHeaders } from '../lib/client-ip.js'
import { TALENT_FILE_LIMIT, TALENT_MAILBOX, TALENT_NOTICE_VERSION, TALENT_PRIVACY_NOTICE, digest, prepareTalentDocument } from '../lib/talent-documents.js'
import { ingestTalentApplication } from '../lib/talent.js'

export const publicTalentRoutes = new Hono()
export function talentPublicEnabled() { return process.env.TALENT_PUBLIC_APPLICATIONS_ENABLED === 'true' }

export const publicApplicationSchema = z.object({
  careerPostId: z.string().uuid(), name: z.string().trim().min(2).max(200),
  email: z.string().trim().toLowerCase().email().max(320), phone: z.string().trim().max(80).default(''),
  privacyNoticeVersion: z.literal(TALENT_NOTICE_VERSION), privacyAcknowledged: z.literal('true'),
  requestId: z.string().uuid(), website: z.string().max(0).default(''),
})

export function applicationsClosed(deadline: string | null, now = new Date()) {
  // Public roles use Nigerian calendar dates; the whole deadline day remains open.
  return Boolean(deadline && now.getTime() > new Date(`${deadline}T23:59:59.999+01:00`).getTime())
}

publicTalentRoutes.get('/application-policy', (c) => {
  c.header('Cache-Control', 'no-store')
  return c.json({ enabled: talentPublicEnabled(), noticeVersion: TALENT_NOTICE_VERSION, privacyNotice: TALENT_PRIVACY_NOTICE,
    mailbox: TALENT_MAILBOX, maxFileBytes: TALENT_FILE_LIMIT })
})

publicTalentRoutes.post('/applications', bodyLimit({ maxSize: TALENT_FILE_LIMIT + 64 * 1024,
  onError: (c) => c.json({ error: 'CV must be smaller than 10 MB' }, 413),
}), async (c) => {
  c.header('Cache-Control', 'no-store')
  if (!talentPublicEnabled()) return c.json({ error: `Online applications are unavailable. Please email ${TALENT_MAILBOX}.` }, 503)
  const ip = clientIpFromHeaders((name) => c.req.header(name)) ?? 'unknown'
  const limit = await checkDurableRateLimit(`talent-public:${digest(ip)}`, 5, 60 * 60_000)
  if (!limit.allowed) { c.header('Retry-After', String(limit.retryAfterSec)); return c.json({ error: 'Too many applications. Please try later.' }, 429) }
  let form: FormData
  try { form = await c.req.formData() } catch { return c.json({ error: 'Invalid application form' }, 400) }
  const parsed = publicApplicationSchema.safeParse(Object.fromEntries(form))
  if (!parsed.success) return c.json({ error: 'Check your details and acknowledge the recruitment privacy notice.' }, 400)
  const data = parsed.data
  const file = form.get('cv')
  if (!(file instanceof File) || !file.size || file.size > TALENT_FILE_LIMIT || !/\.(pdf|docx)$/i.test(file.name)) return c.json({ error: 'Upload a PDF or DOCX CV, up to 10 MB.' }, 400)
  const emailLimit = await checkDurableRateLimit(`talent-email:${digest(data.email)}`, 3, 24 * 60 * 60_000)
  if (!emailLimit.allowed) return c.json({ error: 'An application was recently submitted with these details. Please try later or contact hello@trovara.farm.' }, 429)
  const farm = await resolveCustomerFarm()
  if (!farm) return c.json({ error: 'Applications unavailable' }, 503)
  const [job] = await db.select().from(careerPosts).where(and(eq(careerPosts.farmId, farm.id),
    eq(careerPosts.id, data.careerPostId), eq(careerPosts.published, true), isNotNull(careerPosts.publishedAt))).limit(1)
  if (!job || applicationsClosed(job.applicationDeadline)) return c.json({ error: 'This role is not currently accepting applications.' }, 400)
  try {
    const buffer = Buffer.from(await file.arrayBuffer())
    const document = await prepareTalentDocument(farm.id, file.name, buffer, 'cv')
    const result = await ingestTalentApplication({ farmId: farm.id, name: data.name, email: data.email, phone: data.phone,
      careerPostId: job.id, source: 'website', sourceKey: `website:${digest(`${data.requestId}:${data.email}:${job.id}:${digest(buffer)}`)}`,
      privacyNoticeVersion: data.privacyNoticeVersion, documents: [document],
    })
    // No private candidate or application details are exposed through this endpoint.
    return c.json({ reference: result.application.id, message: 'Your application has been received. Please keep this reference.' }, 201)
  } catch {
    return c.json({ error: 'We could not securely accept this CV. Try a standard PDF/DOCX or email hello@trovara.farm.' }, 503)
  }
})
