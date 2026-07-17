import { and, eq } from 'drizzle-orm'
import { randomBytes } from 'node:crypto'
import { db } from '../db/index.js'
import { actionDrafts } from '../db/schema.js'

export type ActionDraftPayload = Record<string, unknown>

const DRAFT_TTL_MS = 10 * 60 * 1000

export type StoredActionDraft = {
  id: string
  farmId: string
  userId: string
  channel: string
  externalChatId: string | null
  actionType: string
  payload: ActionDraftPayload
  expiresAt: Date
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
    })
    .returning()

  return {
    id: row.id,
    farmId: row.farmId,
    userId: row.userId,
    channel: row.channel,
    externalChatId: row.externalChatId,
    actionType: row.actionType,
    payload: (row.payload ?? {}) as ActionDraftPayload,
    expiresAt: row.expiresAt,
  }
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

  return {
    id: row.id,
    farmId: row.farmId,
    userId: row.userId,
    channel: row.channel,
    externalChatId: row.externalChatId,
    actionType: row.actionType,
    payload: (row.payload ?? {}) as ActionDraftPayload,
    expiresAt: row.expiresAt,
  }
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

  return {
    id: updated.id,
    farmId: updated.farmId,
    userId: updated.userId,
    channel: updated.channel,
    externalChatId: updated.externalChatId,
    actionType: updated.actionType,
    payload: (updated.payload ?? {}) as ActionDraftPayload,
    expiresAt: updated.expiresAt,
  }
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
): Promise<(TaskDraftFields & { userId: string; farmId: string; expiresAt: number }) | null> {
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