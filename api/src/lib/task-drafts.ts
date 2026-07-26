import { and, desc, eq } from 'drizzle-orm'
import { randomBytes } from 'node:crypto'
import { db } from '../db/index.js'
import { actionDrafts } from '../db/schema.js'

export type ActionDraftPayload = Record<string, unknown>

const DRAFT_TTL_MS = 10 * 60 * 1000

export type ContentTranslationStatus = 'done' | 'pending' | 'failed'

/**
 * How a piece of free text was normalized: the language it was authored in and
 * whether it is English yet. Draft rows carry it; every content row written from
 * a draft has to inherit it, or text the LLM could not translate lands in the
 * database claiming to be English and the retry job never sees it again.
 */
export type ContentLocaleMeta = {
  sourceLocale?: string | null
  translationStatus?: ContentTranslationStatus
}

export type StoredActionDraft = {
  id: string
  farmId: string
  userId: string
  channel: string
  externalChatId: string | null
  actionType: string
  payload: ActionDraftPayload
  expiresAt: Date
  sourceLocale: string | null
  translationStatus: ContentTranslationStatus
}

function toStoredDraft(row: typeof actionDrafts.$inferSelect): StoredActionDraft {
  return {
    id: row.id,
    farmId: row.farmId,
    userId: row.userId,
    channel: row.channel,
    externalChatId: row.externalChatId,
    actionType: row.actionType,
    payload: (row.payload ?? {}) as ActionDraftPayload,
    expiresAt: row.expiresAt,
    sourceLocale: row.sourceLocale,
    translationStatus: row.translationStatus,
  }
}

/** The locale metadata of a draft, in the shape executors take. */
export function draftContentLocale(draft: StoredActionDraft): ContentLocaleMeta {
  return { sourceLocale: draft.sourceLocale, translationStatus: draft.translationStatus }
}

/**
 * Locale columns for a row being inserted from a draft. English text that
 * translated cleanly writes nothing so the schema defaults apply.
 *
 * Anything unresolved is written as 'pending' rather than copied verbatim: the
 * retry job only sweeps 'pending', so a draft abandoned as 'failed' would make
 * the new row unreachable. A fresh row gets a fresh attempt — one wasted retry
 * is cheap, a row that wrongly claims 'done' is unrecoverable.
 */
export function contentLocaleValues(meta?: ContentLocaleMeta | null): {
  sourceLocale?: string | null
  translationStatus?: ContentTranslationStatus
} {
  const sourceLocale = meta?.sourceLocale ?? null
  const resolved = (meta?.translationStatus ?? 'done') === 'done'
  if (resolved && sourceLocale == null) return {}
  return { sourceLocale, translationStatus: resolved ? 'done' : 'pending' }
}

/**
 * Locale columns for an update that adds free text to a row that already has
 * some. One pair of columns describes the whole row, so the row is 'done' only
 * while all of its text is: this escalates to 'pending' but never back. A row
 * that already carries debt is left alone — overwriting it would throw away the
 * retry job's own bookkeeping, including a 'failed' it decided on.
 */
export function mergeContentLocale(
  existing: { sourceLocale: string | null; translationStatus: ContentTranslationStatus },
  incoming?: ContentLocaleMeta | null,
): { sourceLocale?: string | null; translationStatus?: ContentTranslationStatus } {
  const values = contentLocaleValues(incoming)
  if (values.translationStatus == null) return {}
  if (existing.translationStatus !== 'done') return {}
  return values.sourceLocale == null
    ? { translationStatus: values.translationStatus }
    : values
}

export async function storeActionDraft(input: {
  userId: string
  farmId: string
  actionType: string
  payload: ActionDraftPayload
  channel?: string
  externalChatId?: string | null
  telegramMessageId?: string | null
  ttlMs?: number
  sourceLocale?: string | null
  translationStatus?: ContentTranslationStatus
}): Promise<StoredActionDraft> {
  const expiresAt = new Date(Date.now() + (input.ttlMs ?? DRAFT_TTL_MS))
  const id = randomBytes(16).toString('hex')

  const [row] = await db
    .insert(actionDrafts)
    .values({
      id,
      farmId: input.farmId,
      userId: input.userId,
      channel: input.channel ?? 'web',
      externalChatId: input.externalChatId ?? null,
      actionType: input.actionType,
      payload: input.payload,
      status: 'pending',
      expiresAt,
      telegramMessageId: input.telegramMessageId ?? null,
      ...contentLocaleValues(input),
    })
    .returning()

  return toStoredDraft(row)
}

export async function getPendingActionDraft(
  draftId: string,
  userId: string,
): Promise<StoredActionDraft | null> {
  const [row] = await db
    .select()
    .from(actionDrafts)
    .where(and(eq(actionDrafts.id, draftId), eq(actionDrafts.userId, userId)))
    .limit(1)

  if (!row) return null
  if (row.status !== 'pending') return null
  if (row.expiresAt.getTime() <= Date.now()) {
    await db
      .update(actionDrafts)
      .set({ status: 'expired' })
      .where(eq(actionDrafts.id, draftId))
    return null
  }

  return toStoredDraft(row)
}

export async function confirmActionDraft(
  draftId: string,
  userId: string,
): Promise<StoredActionDraft | null> {
  const draft = await getPendingActionDraft(draftId, userId)
  if (!draft) return null

  const [updated] = await db
    .update(actionDrafts)
    .set({ status: 'confirmed', confirmedAt: new Date() })
    .where(
      and(
        eq(actionDrafts.id, draftId),
        eq(actionDrafts.userId, userId),
        eq(actionDrafts.status, 'pending'),
      ),
    )
    .returning()

  if (!updated) return null

  return toStoredDraft(updated)
}

export async function cancelActionDraft(draftId: string, userId: string): Promise<boolean> {
  const [updated] = await db
    .update(actionDrafts)
    .set({ status: 'cancelled' })
    .where(
      and(
        eq(actionDrafts.id, draftId),
        eq(actionDrafts.userId, userId),
        eq(actionDrafts.status, 'pending'),
      ),
    )
    .returning({ id: actionDrafts.id })

  return Boolean(updated)
}

export async function clearActionDraftsForUser(userId: string): Promise<number> {
  const result = await db
    .update(actionDrafts)
    .set({ status: 'cancelled' })
    .where(and(eq(actionDrafts.userId, userId), eq(actionDrafts.status, 'pending')))
    .returning({ id: actionDrafts.id })
  return result.length
}

export async function getLatestPendingDraft(
  userId: string,
  actionType: string,
): Promise<StoredActionDraft | null> {
  const [row] = await db
    .select()
    .from(actionDrafts)
    .where(
      and(
        eq(actionDrafts.userId, userId),
        eq(actionDrafts.actionType, actionType),
        eq(actionDrafts.status, 'pending'),
      ),
    )
    .orderBy(desc(actionDrafts.expiresAt))
    .limit(1)

  if (!row) return null
  if (row.expiresAt.getTime() <= Date.now()) {
    await db.update(actionDrafts).set({ status: 'expired' }).where(eq(actionDrafts.id, row.id))
    return null
  }

  return toStoredDraft(row)
}

/** Latest pending draft of any type (WhatsApp CONFIRM / CANCEL without buttons). */
export async function getLatestPendingDraftAny(userId: string): Promise<StoredActionDraft | null> {
  const [row] = await db
    .select()
    .from(actionDrafts)
    .where(and(eq(actionDrafts.userId, userId), eq(actionDrafts.status, 'pending')))
    .orderBy(desc(actionDrafts.createdAt))
    .limit(1)

  if (!row) return null
  if (row.expiresAt.getTime() <= Date.now()) {
    await db.update(actionDrafts).set({ status: 'expired' }).where(eq(actionDrafts.id, row.id))
    return null
  }

  return toStoredDraft(row)
}

export async function mergeActionDraftPayload(
  draftId: string,
  userId: string,
  patch: ActionDraftPayload,
): Promise<StoredActionDraft | null> {
  const draft = await getPendingActionDraft(draftId, userId)
  if (!draft) return null
  const payload = { ...draft.payload, ...patch }
  const [updated] = await db
    .update(actionDrafts)
    .set({ payload })
    .where(and(eq(actionDrafts.id, draftId), eq(actionDrafts.userId, userId)))
    .returning()
  if (!updated) return null
  return toStoredDraft(updated)
}

/** Compatibility helpers matching the old in-memory task-drafts API. */
export type TaskDraftFields = {
  title: string
  description?: string
  plotId?: string
  assignedToId?: string
}

export async function storeTaskDraft(
  userId: string,
  farmId: string,
  fields: TaskDraftFields,
  opts?: { channel?: string; externalChatId?: string | null },
): Promise<{ draftId: string; draft: TaskDraftFields; expiresAt: number }> {
  const stored = await storeActionDraft({
    userId,
    farmId,
    actionType: 'create_task',
    payload: fields as ActionDraftPayload,
    channel: opts?.channel ?? 'web',
    externalChatId: opts?.externalChatId ?? null,
  })
  return {
    draftId: stored.id,
    draft: fields,
    expiresAt: stored.expiresAt.getTime(),
  }
}

export async function takeTaskDraft(
  draftId: string,
  userId: string,
): Promise<
  | (TaskDraftFields & {
      userId: string
      farmId: string
      expiresAt: number
      sourceLocale: string | null
      translationStatus: ContentTranslationStatus
    })
  | null
> {
  const confirmed = await confirmActionDraft(draftId, userId)
  if (!confirmed || confirmed.actionType !== 'create_task') return null
  const payload = confirmed.payload as TaskDraftFields
  return {
    title: payload.title,
    description: payload.description,
    plotId: payload.plotId,
    assignedToId: payload.assignedToId,
    userId: confirmed.userId,
    farmId: confirmed.farmId,
    expiresAt: confirmed.expiresAt.getTime(),
    sourceLocale: confirmed.sourceLocale,
    translationStatus: confirmed.translationStatus,
  }
}

export async function clearTaskDraftsForUser(userId: string): Promise<number> {
  return clearActionDraftsForUser(userId)
}

export async function markTelegramUpdateProcessed(
  botKey: string,
  updateId: number,
): Promise<boolean> {
  const { telegramProcessedUpdates } = await import('../db/schema.js')
  try {
    await db.insert(telegramProcessedUpdates).values({ botKey, updateId })
    return true
  } catch {
    return false
  }
}

export async function wasTelegramUpdateProcessed(
  botKey: string,
  updateId: number,
): Promise<boolean> {
  const { telegramProcessedUpdates } = await import('../db/schema.js')
  const [row] = await db
    .select({ id: telegramProcessedUpdates.id })
    .from(telegramProcessedUpdates)
    .where(
      and(
        eq(telegramProcessedUpdates.botKey, botKey),
        eq(telegramProcessedUpdates.updateId, updateId),
      ),
    )
    .limit(1)
  return Boolean(row)
}