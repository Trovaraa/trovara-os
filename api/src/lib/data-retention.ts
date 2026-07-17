import { and, eq, inArray, isNotNull, lt, or, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { customerContacts, farmEvents, sessions, tasks, users } from '../db/schema.js'
import { deleteEvidenceByUrl } from './evidence-store.js'

const CHAT_ENTITY_TYPES = ['whatsapp_message', 'telegram_message'] as const
const REDACTED_TEXT = '[redacted]'

function parseDays(raw: string | undefined, fallback: number): number {
  const n = Number(raw ?? String(fallback))
  if (!Number.isFinite(n) || n < 1) return fallback
  return Math.floor(n)
}

function retentionDays(): number {
  return parseDays(process.env.DATA_RETENTION_DAYS, 365)
}

function sessionRetentionDays(): number {
  return parseDays(process.env.SESSION_RETENTION_DAYS, 7)
}

function customerContactRetentionDays(): number {
  return parseDays(
    process.env.CUSTOMER_CONTACT_RETENTION_DAYS ?? process.env.DATA_RETENTION_DAYS,
    365,
  )
}

export type RetentionConfig = {
  retentionDays: number
  sessionRetentionDays: number
  customerContactRetentionDays: number
}

export function getRetentionConfig(): RetentionConfig {
  return {
    retentionDays: retentionDays(),
    sessionRetentionDays: sessionRetentionDays(),
    customerContactRetentionDays: customerContactRetentionDays(),
  }
}

export async function getRetentionPreview(farmId: string): Promise<{
  config: RetentionConfig
  pendingTaskEvidence: number
  pendingExpiredSessions: number
  pendingChatMessages: number
  pendingContactPhones: number
}> {
  const config = getRetentionConfig()
  const evidenceCutoff = new Date(Date.now() - config.retentionDays * 24 * 60 * 60 * 1000)
  const sessionCutoff = new Date(Date.now() - config.sessionRetentionDays * 24 * 60 * 60 * 1000)
  const contactCutoff = new Date(
    Date.now() - config.customerContactRetentionDays * 24 * 60 * 60 * 1000,
  )

  const farmUserRows = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.farmId, farmId))
  const farmUserIds = farmUserRows.map((row) => row.id)

  const [taskEvidenceRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(tasks)
    .where(
      and(
        eq(tasks.farmId, farmId),
        lt(tasks.updatedAt, evidenceCutoff),
        or(isNotNull(tasks.photoUrl), isNotNull(tasks.voiceUrl)),
      ),
    )

  let pendingExpiredSessions = 0
  if (farmUserIds.length > 0) {
    const [sessionRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(sessions)
      .where(and(lt(sessions.expiresAt, sessionCutoff), inArray(sessions.userId, farmUserIds)))
    pendingExpiredSessions = sessionRow?.count ?? 0
  }

  const [chatRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(farmEvents)
    .where(
      and(
        eq(farmEvents.farmId, farmId),
        inArray(farmEvents.entityType, [...CHAT_ENTITY_TYPES]),
        lt(farmEvents.createdAt, evidenceCutoff),
        sql`(${farmEvents.afterValue}->>'text') IS NOT NULL`,
        sql`(${farmEvents.afterValue}->>'text') <> ${REDACTED_TEXT}`,
      ),
    )

  const [contactRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(customerContacts)
    .where(
      and(
        eq(customerContacts.farmId, farmId),
        isNotNull(customerContacts.phone),
        lt(customerContacts.updatedAt, contactCutoff),
      ),
    )

  return {
    config,
    pendingTaskEvidence: taskEvidenceRow?.count ?? 0,
    pendingExpiredSessions,
    pendingChatMessages: chatRow?.count ?? 0,
    pendingContactPhones: contactRow?.count ?? 0,
  }
}

export async function runDataRetention(farmId?: string): Promise<{
  farmId?: string
  retentionDays: number
  sessionRetentionDays: number
  customerContactRetentionDays: number
  purgedTaskEvidence: number
  deletedEvidenceFiles: number
  purgedExpiredSessions: number
  redactedChatMessages: number
  nulledContactPhones: number
}> {
  const config = getRetentionConfig()
  const evidenceCutoff = new Date(Date.now() - config.retentionDays * 24 * 60 * 60 * 1000)
  const sessionCutoff = new Date(Date.now() - config.sessionRetentionDays * 24 * 60 * 60 * 1000)
  const contactCutoff = new Date(
    Date.now() - config.customerContactRetentionDays * 24 * 60 * 60 * 1000,
  )

  const taskWhere = farmId
    ? and(
        eq(tasks.farmId, farmId),
        lt(tasks.updatedAt, evidenceCutoff),
        or(isNotNull(tasks.photoUrl), isNotNull(tasks.voiceUrl)),
      )
    : and(
        lt(tasks.updatedAt, evidenceCutoff),
        or(isNotNull(tasks.photoUrl), isNotNull(tasks.voiceUrl)),
      )

  const evidenceRows = await db
    .select({
      id: tasks.id,
      photoUrl: tasks.photoUrl,
      voiceUrl: tasks.voiceUrl,
    })
    .from(tasks)
    .where(taskWhere)

  const purgedRows = await db
    .update(tasks)
    .set({
      photoUrl: null,
      voiceUrl: null,
      updatedAt: new Date(),
    })
    .where(taskWhere)
    .returning({ id: tasks.id })

  const evidenceDeleteResults = await Promise.allSettled(
    evidenceRows.flatMap((row) => [
      deleteEvidenceByUrl(row.photoUrl),
      deleteEvidenceByUrl(row.voiceUrl),
    ]),
  )
  let deletedEvidenceFiles = 0
  for (const result of evidenceDeleteResults) {
    if (result.status === 'fulfilled' && result.value) {
      deletedEvidenceFiles += 1
    } else if (result.status === 'rejected') {
      console.error('Failed to delete retained evidence file:', result.reason)
    }
  }

  let purgedExpiredSessions = 0
  if (farmId) {
    const farmUserRows = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.farmId, farmId))
    const farmUserIds = farmUserRows.map((row) => row.id)
    if (farmUserIds.length > 0) {
      const deletedSessions = await db
        .delete(sessions)
        .where(and(lt(sessions.expiresAt, sessionCutoff), inArray(sessions.userId, farmUserIds)))
        .returning({ id: sessions.id })
      purgedExpiredSessions = deletedSessions.length
    }
  } else {
    const deletedSessions = await db
      .delete(sessions)
      .where(lt(sessions.expiresAt, sessionCutoff))
      .returning({ id: sessions.id })
    purgedExpiredSessions = deletedSessions.length
  }

  const chatWhere = farmId
    ? and(
        eq(farmEvents.farmId, farmId),
        inArray(farmEvents.entityType, [...CHAT_ENTITY_TYPES]),
        lt(farmEvents.createdAt, evidenceCutoff),
        sql`(${farmEvents.afterValue}->>'text') IS NOT NULL`,
        sql`(${farmEvents.afterValue}->>'text') <> ${REDACTED_TEXT}`,
      )
    : and(
        inArray(farmEvents.entityType, [...CHAT_ENTITY_TYPES]),
        lt(farmEvents.createdAt, evidenceCutoff),
        sql`(${farmEvents.afterValue}->>'text') IS NOT NULL`,
        sql`(${farmEvents.afterValue}->>'text') <> ${REDACTED_TEXT}`,
      )

  const redactedRows = await db
    .update(farmEvents)
    .set({
      afterValue: sql`jsonb_set(COALESCE(${farmEvents.afterValue}, '{}'::jsonb), '{text}', to_jsonb(${REDACTED_TEXT}::text))`,
    })
    .where(chatWhere)
    .returning({ id: farmEvents.id })

  const contactWhere = farmId
    ? and(
        eq(customerContacts.farmId, farmId),
        isNotNull(customerContacts.phone),
        lt(customerContacts.updatedAt, contactCutoff),
      )
    : and(isNotNull(customerContacts.phone), lt(customerContacts.updatedAt, contactCutoff))

  const nulledContacts = await db
    .update(customerContacts)
    .set({ phone: null, updatedAt: new Date() })
    .where(contactWhere)
    .returning({ id: customerContacts.id })

  // audit_events rows are append-only and never deleted by retention (legal hold safe).

  return {
    farmId,
    retentionDays: config.retentionDays,
    sessionRetentionDays: config.sessionRetentionDays,
    customerContactRetentionDays: config.customerContactRetentionDays,
    purgedTaskEvidence: purgedRows.length,
    deletedEvidenceFiles,
    purgedExpiredSessions,
    redactedChatMessages: redactedRows.length,
    nulledContactPhones: nulledContacts.length,
  }
}
