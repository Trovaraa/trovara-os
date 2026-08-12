import { and, asc, desc, eq, isNull } from 'drizzle-orm'
import { db } from '../db/index.js'
import { aiConversations, aiMessages } from '../db/schema.js'
import type { SessionUser } from './session.js'
import { deleteEvidenceByUrl } from './evidence-store.js'

const MAX_MESSAGES = 100
const MAX_CONTEXT_MESSAGES = 12

export type AiConversationSummary = {
  id: string
  title: string
  archivedAt: string | null
  createdAt: string
  updatedAt: string
}

export type AiConversationMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  attachmentUrl: string | null
  model: string | null
  metadata: Record<string, unknown> | null
  createdAt: string
}

function summary(row: typeof aiConversations.$inferSelect): AiConversationSummary {
  return {
    id: row.id,
    title: row.title,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

function message(row: typeof aiMessages.$inferSelect): AiConversationMessage {
  return {
    id: row.id,
    role: row.role === 'assistant' ? 'assistant' : 'user',
    content: row.content,
    attachmentUrl: row.attachmentUrl,
    model: row.model,
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    createdAt: row.createdAt.toISOString(),
  }
}

function ownedConversationWhere(user: SessionUser, conversationId: string) {
  return and(
    eq(aiConversations.id, conversationId),
    eq(aiConversations.farmId, user.farmId),
    eq(aiConversations.userId, user.id),
  )
}

export async function listAiConversations(user: SessionUser, includeArchived = false) {
  const where = includeArchived
    ? and(eq(aiConversations.farmId, user.farmId), eq(aiConversations.userId, user.id))
    : and(
        eq(aiConversations.farmId, user.farmId),
        eq(aiConversations.userId, user.id),
        isNull(aiConversations.archivedAt),
      )
  const rows = await db
    .select()
    .from(aiConversations)
    .where(where)
    .orderBy(desc(aiConversations.updatedAt))
    .limit(50)
  return rows.map(summary)
}

export async function createAiConversation(user: SessionUser, title?: string) {
  const cleanTitle = title?.trim().slice(0, 100) || 'New conversation'
  const [row] = await db
    .insert(aiConversations)
    .values({ farmId: user.farmId, userId: user.id, title: cleanTitle })
    .returning()
  return summary(row)
}

export async function getAiConversation(user: SessionUser, conversationId: string) {
  const [conversation] = await db
    .select()
    .from(aiConversations)
    .where(ownedConversationWhere(user, conversationId))
    .limit(1)
  if (!conversation) return null

  const rows = await db
    .select()
    .from(aiMessages)
    .where(
      and(
        eq(aiMessages.conversationId, conversationId),
        eq(aiMessages.farmId, user.farmId),
        eq(aiMessages.userId, user.id),
      ),
    )
    .orderBy(asc(aiMessages.createdAt))
    .limit(MAX_MESSAGES)
  return { conversation: summary(conversation), messages: rows.map(message) }
}

export async function requireAiConversation(user: SessionUser, conversationId?: string | null) {
  if (conversationId) {
    const existing = await getAiConversation(user, conversationId)
    if (existing && !existing.conversation.archivedAt) return existing.conversation
    return null
  }
  return createAiConversation(user)
}

export async function appendAiMessage(input: {
  user: SessionUser
  conversationId: string
  role: 'user' | 'assistant'
  content: string
  attachmentUrl?: string | null
  model?: string | null
  metadata?: Record<string, unknown>
}) {
  const [conversation] = await db
    .select({ id: aiConversations.id, title: aiConversations.title })
    .from(aiConversations)
    .where(ownedConversationWhere(input.user, input.conversationId))
    .limit(1)
  if (!conversation) return null

  const now = new Date()
  const [row] = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(aiMessages)
      .values({
        conversationId: input.conversationId,
        farmId: input.user.farmId,
        userId: input.user.id,
        role: input.role,
        content: input.content.slice(0, 12_000),
        attachmentUrl: input.attachmentUrl ?? null,
        model: input.model ?? null,
        metadata: input.metadata,
      })
      .returning()

    const title =
      input.role === 'user' && conversation.title === 'New conversation'
        ? input.content.trim().replace(/\s+/g, ' ').slice(0, 72) || 'Photo question'
        : undefined
    await tx
      .update(aiConversations)
      .set({ updatedAt: now, ...(title ? { title } : {}) })
      .where(ownedConversationWhere(input.user, input.conversationId))
    return [created]
  })
  return message(row)
}

/** History for the model, excluding the latest user turn supplied separately. */
export async function loadAiConversationContext(user: SessionUser, conversationId: string) {
  const rows = await db
    .select({ role: aiMessages.role, content: aiMessages.content })
    .from(aiMessages)
    .where(
      and(
        eq(aiMessages.conversationId, conversationId),
        eq(aiMessages.farmId, user.farmId),
        eq(aiMessages.userId, user.id),
      ),
    )
    .orderBy(desc(aiMessages.createdAt))
    .limit(MAX_CONTEXT_MESSAGES)
  return rows.reverse().map((row) => ({
    role: row.role === 'assistant' ? ('assistant' as const) : ('user' as const),
    content: row.content,
  }))
}

export async function clearAiConversation(user: SessionUser, conversationId: string) {
  const [owned] = await db
    .select({ id: aiConversations.id })
    .from(aiConversations)
    .where(ownedConversationWhere(user, conversationId))
    .limit(1)
  if (!owned) return false
  const attachments = await db
    .select({ url: aiMessages.attachmentUrl })
    .from(aiMessages)
    .where(eq(aiMessages.conversationId, conversationId))
  await db.transaction(async (tx) => {
    await tx.delete(aiMessages).where(eq(aiMessages.conversationId, conversationId))
    await tx
      .update(aiConversations)
      .set({ title: 'New conversation', updatedAt: new Date() })
      .where(ownedConversationWhere(user, conversationId))
  })
  await Promise.all(attachments.map((row) => deleteEvidenceByUrl(row.url).catch(() => false)))
  return true
}

export async function archiveAiConversation(user: SessionUser, conversationId: string) {
  const [row] = await db
    .update(aiConversations)
    .set({ archivedAt: new Date(), updatedAt: new Date() })
    .where(ownedConversationWhere(user, conversationId))
    .returning({ id: aiConversations.id })
  return Boolean(row)
}
