import { and, eq, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db/index.js'
import { talentApplications, talentCandidates, talentEvents, talentMailCursors } from '../db/schema.js'
import { TALENT_FILE_LIMIT, TALENT_MAILBOX } from './talent-documents.js'
import { importTalentEmail } from './talent.js'

const regions = {
  com: ['https://accounts.zoho.com', 'https://mail.zoho.com'],
  eu: ['https://accounts.zoho.eu', 'https://mail.zoho.eu'],
  in: ['https://accounts.zoho.in', 'https://mail.zoho.in'],
  'com.au': ['https://accounts.zoho.com.au', 'https://mail.zoho.com.au'],
  jp: ['https://accounts.zoho.jp', 'https://mail.zoho.jp'],
  ca: ['https://accounts.zohocloud.ca', 'https://mail.zohocloud.ca'],
} as const

export function talentZohoConfig() {
  const region = process.env.TALENT_ZOHO_REGION?.trim() || 'com'
  if (!(region in regions)) throw new Error('Unsupported Zoho region')
  const [accountsOrigin, mailOrigin] = regions[region as keyof typeof regions]
  const folderIds = (process.env.TALENT_ZOHO_FOLDER_IDS ?? '').split(',').map((id) => id.trim()).filter(Boolean)
  if (folderIds.some((id) => !/^\d+$/.test(id)) || folderIds.length > 10) throw new Error('Invalid recruitment folder IDs')
  return {
    accountsOrigin, mailOrigin, folderIds,
    farmId: process.env.TALENT_FARM_ID?.trim() || '',
    accountId: process.env.TALENT_ZOHO_ACCOUNT_ID?.trim() || '',
    clientId: process.env.TALENT_ZOHO_CLIENT_ID?.trim() || '',
    clientSecret: process.env.TALENT_ZOHO_CLIENT_SECRET?.trim() || '',
    refreshToken: process.env.TALENT_ZOHO_REFRESH_TOKEN?.trim() || '',
  }
}

export function talentZohoStatus(farmId: string) {
  const config = talentZohoConfig()
  const configured = config.farmId === farmId && /^\d+$/.test(config.accountId) &&
    Boolean(config.clientId && config.clientSecret && config.refreshToken && config.folderIds.length)
  return { provider: 'Zoho', mailbox: TALENT_MAILBOX, configured,
    automaticIntake: configured && process.env.TALENT_ZOHO_ENABLED === 'true',
    sendingEnabled: configured && process.env.TALENT_ZOHO_SEND_ENABLED === 'true',
    folderCount: config.farmId === farmId ? config.folderIds.length : 0 }
}

let cachedToken: { value: string; expiresAt: number } | null = null
export async function readBoundedResponse(response: Response, limit = TALENT_FILE_LIMIT * 2): Promise<string> {
  if (!response.body) throw new Error('Zoho returned an empty response')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) throw new Error('Zoho response exceeds the import size limit')
      chunks.push(value)
    }
  } finally { await reader.cancel().catch(() => undefined) }
  return Buffer.concat(chunks).toString('utf8')
}

async function zohoToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.value
  const config = talentZohoConfig()
  const response = await fetch(`${config.accountsOrigin}/oauth/v2/token`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: config.clientId,
      client_secret: config.clientSecret, refresh_token: config.refreshToken }),
  })
  const body = JSON.parse(await readBoundedResponse(response, 64 * 1024)) as { access_token?: string; expires_in?: number }
  if (!response.ok || !body.access_token) throw new Error('Zoho authorisation failed. Check the server-side OAuth configuration.')
  cachedToken = { value: body.access_token, expiresAt: Date.now() + Math.min(Number(body.expires_in) || 3600, 3600) * 1000 - 60_000 }
  return cachedToken.value
}

export async function zohoRequest<T>(path: string, body?: Record<string, string>): Promise<T> {
  const config = talentZohoConfig()
  const response = await fetch(`${config.mailOrigin}/api/accounts/${encodeURIComponent(config.accountId)}${path}`, {
    method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Zoho-oauthtoken ${await zohoToken()}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const result = JSON.parse(await readBoundedResponse(response)) as { status?: { code?: number }; data: T }
  if (!response.ok || !result.status?.code || result.status.code < 200 || result.status.code >= 300 || result.data === undefined) {
    if (response.status === 401) cachedToken = null
    throw new Error(`Zoho request failed (${response.status}). Check permissions and retry later.`)
  }
  return result.data
}

const messageSchema = z.object({
  messageId: z.string().regex(/^\d+$/), folderId: z.string().regex(/^\d+$/),
  receivedTime: z.string().regex(/^\d+$/), size: z.string().optional(),
})

/** One bounded page per folder. Full rescans de-duplicate by Message-ID and recover moved mail. */
export async function syncTalentZoho(farmId: string, actorId?: string) {
  if (!talentZohoStatus(farmId).configured) throw new Error('Zoho recruitment intake is not configured for this farm')
  const config = talentZohoConfig()
  return db.transaction(async (lock) => {
    const rows = await lock.execute(sql`select pg_try_advisory_xact_lock(hashtext(${`talent-zoho:${farmId}`})) as acquired`)
    if (!rows[0]?.acquired) return { imported: 0, duplicates: 0, failed: 0, busy: true }
    let imported = 0; let duplicates = 0; let failed = 0
    for (const folderId of config.folderIds) {
      const id = `${farmId}:${config.accountId}:${folderId}`
      const [cursor] = await db.select().from(talentMailCursors).where(eq(talentMailCursors.id, id)).limit(1)
      const start = Math.max(1, cursor?.startAt ?? 1)
      try {
        const data = await zohoRequest<unknown>(`/messages/view?${new URLSearchParams({ folderId, start: String(start), limit: '5', sortorder: 'true', includeto: 'true' })}`)
        const messages = z.array(messageSchema).parse(data)
        for (const message of messages) {
          try {
            if (message.folderId !== folderId) throw new Error('Message was outside the configured recruitment folder')
            if (message.size && Number(message.size) > TALENT_FILE_LIMIT) throw new Error('Email is larger than 10 MB')
            const original = await zohoRequest<{ content: string }>(`/messages/${message.messageId}/originalmessage`)
            if (typeof original.content !== 'string') throw new Error('Zoho did not return the original email')
            const receivedAt = new Date(Number(message.receivedTime))
            if (!Number.isFinite(receivedAt.getTime())) throw new Error('Invalid received date')
            const result = await importTalentEmail({ farmId, actorId, source: 'zoho',
              filename: `application-${message.messageId}.eml`, buffer: Buffer.from(original.content), receivedAt })
            if (result.duplicate) duplicates++; else imported++
          } catch (error) {
            if (error instanceof Error && error.message.includes('previously deleted')) duplicates++
            else failed++
          }
        }
        await db.insert(talentMailCursors).values({ id, farmId,
          startAt: messages.length < 5 ? 1 : start + messages.length, lastSyncedAt: new Date(),
          lastError: failed ? 'Some emails could not be imported. Review size/type/scanner settings; the next full pass retries them.' : null,
        }).onConflictDoUpdate({ target: talentMailCursors.id, set: {
          startAt: messages.length < 5 ? 1 : start + messages.length, lastSyncedAt: new Date(),
          lastError: failed ? 'Some emails could not be imported. They will be retried on the next pass.' : null,
        } })
      } catch {
        failed++
        await db.insert(talentMailCursors).values({ id, farmId, startAt: start, lastError: 'Zoho sync failed. Check OAuth, account and folder configuration.' })
          .onConflictDoUpdate({ target: talentMailCursors.id, set: { lastError: 'Zoho sync failed. Check OAuth, account and folder configuration.' } })
      }
    }
    return { imported, duplicates, failed, busy: false }
  })
}

export async function sendTalentMessage(input: { farmId: string; applicationId: string; actorId?: string; subject: string; body: string; requestId: string }) {
  if (!talentZohoStatus(input.farmId).sendingEnabled) throw new Error('Zoho sending is not enabled for Talent')
  const [record] = await db.select({ application: talentApplications, candidate: talentCandidates }).from(talentApplications)
    .innerJoin(talentCandidates, eq(talentCandidates.id, talentApplications.candidateId))
    .where(and(eq(talentApplications.farmId, input.farmId), eq(talentApplications.id, input.applicationId), isNull(talentApplications.deletedAt))).limit(1)
  if (!record?.candidate.email) throw new Error('Application has no confirmed email address')
  if (record.application.source !== 'website' && record.application.needsReview) throw new Error('Review imported contact details before sending email')
  const subject = `[Trovara ${input.applicationId}] ${input.subject}`
  // Claim before sending. Do not automatically resend after an ambiguous network failure.
  const [event] = await db.insert(talentEvents).values({ farmId: input.farmId, applicationId: input.applicationId,
    actorId: input.actorId, kind: 'email_sending', messageKey: `outbound:${input.applicationId}:${input.requestId}`,
    body: `To: ${record.candidate.email}\nSubject: ${subject}\n\n${input.body}`,
  }).onConflictDoNothing().returning()
  if (!event) return { duplicate: true }
  try {
    const sent = await zohoRequest<{ messageId?: string | number }>('/messages', { fromAddress: TALENT_MAILBOX, toAddress: record.candidate.email,
      subject, content: input.body, mailFormat: 'plaintext' })
    if (!sent?.messageId) throw new Error('Zoho did not confirm a sent message')
    await db.update(talentEvents).set({ kind: 'email_sent' }).where(eq(talentEvents.id, event.id))
    return { duplicate: false }
  } catch {
    await db.update(talentEvents).set({ kind: 'email_delivery_uncertain' }).where(eq(talentEvents.id, event.id))
    throw new Error('Email delivery could not be confirmed. Check Zoho Sent before sending again.')
  }
}

export async function sendNextTalentReceipt(farmId: string) {
  if (!talentZohoStatus(farmId).sendingEnabled) return false
  const [application] = await db.select().from(talentApplications).where(and(
    eq(talentApplications.farmId, farmId), eq(talentApplications.source, 'website'), isNull(talentApplications.deletedAt),
    isNull(talentApplications.acknowledgedAt),
    sql`not exists (select 1 from talent_events e where e.application_id = ${talentApplications.id} and e.message_key = 'outbound:' || ${talentApplications.id}::text || ':receipt')`,
  )).limit(1)
  if (!application) return false
  await sendTalentMessage({ farmId, applicationId: application.id, requestId: 'receipt',
    subject: `Trovara application received — ${application.id}`,
    body: `Thank you for applying to Trovara Farm. We received your application for ${application.roleLabel}.\n\nReference: ${application.id}\nOur hiring team will review it. You can reply to hello@trovara.farm with questions or requests about your application.`,
  })
  await db.update(talentApplications).set({ acknowledgedAt: new Date() }).where(eq(talentApplications.id, application.id))
  return true
}
