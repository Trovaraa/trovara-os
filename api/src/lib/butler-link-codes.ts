import { randomBytes } from 'node:crypto'
import { and, desc, eq, gt, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { farmEvents, users } from '../db/schema.js'
import { recordFarmEvent } from './farm-events.js'

const ENTITY_TYPE = 'butler_link_code'
const LINK_ENTITY = 'telegram_link'
const UNLINK_ENTITY = 'telegram_unlink'
const CODE_TTL_MS = 15 * 60 * 1000
const CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'

type LinkCodeValue = {
  userId: string
  farmId: string
  expiresAt: string
  usedAt: string | null
}

function randomCode(): string {
  const bytes = randomBytes(8)
  let code = ''
  for (let i = 0; i < 8; i += 1) {
    code += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length]
  }
  return code
}

async function markPriorCodesUsed(userId: string): Promise<void> {
  const rows = await db
    .select()
    .from(farmEvents)
    .where(
      and(
        eq(farmEvents.entityType, ENTITY_TYPE),
        sql`${farmEvents.afterValue}->>'userId' = ${userId}`,
        sql`(${farmEvents.afterValue}->>'usedAt') IS NULL`,
      ),
    )

  const usedAt = new Date().toISOString()
  for (const row of rows) {
    const val = row.afterValue as LinkCodeValue
    await db
      .update(farmEvents)
      .set({ afterValue: { ...val, usedAt } })
      .where(eq(farmEvents.id, row.id))
  }
}

export async function generateLinkCode(
  userId: string,
  farmId: string,
): Promise<{ code: string; expiresAt: Date }> {
  await markPriorCodesUsed(userId)

  const code = randomCode()
  const expiresAt = new Date(Date.now() + CODE_TTL_MS)

  await recordFarmEvent({
    farmId,
    actorUserId: userId,
    entityType: ENTITY_TYPE,
    entityId: code,
    eventType: 'other',
    source: 'web',
    afterValue: {
      userId,
      farmId,
      expiresAt: expiresAt.toISOString(),
      usedAt: null,
    },
  })

  return { code, expiresAt }
}

export async function verifyAndConsumeLinkCode(
  code: string,
): Promise<(typeof users.$inferSelect) | null> {
  const normalized = code.trim().toUpperCase()
  const [row] = await db
    .select()
    .from(farmEvents)
    .where(and(eq(farmEvents.entityType, ENTITY_TYPE), eq(farmEvents.entityId, normalized)))
    .limit(1)

  if (!row) return null

  const val = row.afterValue as LinkCodeValue
  if (val.usedAt) return null
  if (new Date(val.expiresAt) < new Date()) return null

  const [user] = await db.select().from(users).where(eq(users.id, val.userId)).limit(1)
  if (!user || !user.active) return null

  await db
    .update(farmEvents)
    .set({ afterValue: { ...val, usedAt: new Date().toISOString() } })
    .where(eq(farmEvents.id, row.id))

  return user
}

async function isChatUnlinked(chatId: string, linkCreatedAt: Date): Promise<boolean> {
  // Use drizzle `gt()` so the timestamp binds correctly (raw sql`${date}` breaks postgres.js).
  const [unlink] = await db
    .select()
    .from(farmEvents)
    .where(
      and(
        eq(farmEvents.entityType, UNLINK_ENTITY),
        eq(farmEvents.entityId, String(chatId)),
        gt(farmEvents.createdAt, linkCreatedAt),
      ),
    )
    .limit(1)
  return !!unlink
}

export async function isTelegramLinked(userId: string): Promise<boolean> {
  const links = await db
    .select()
    .from(farmEvents)
    .where(
      and(
        eq(farmEvents.entityType, LINK_ENTITY),
        sql`${farmEvents.afterValue}->>'userId' = ${userId}`,
      ),
    )
    .orderBy(desc(farmEvents.createdAt))

  for (const link of links) {
    const chatId = (link.afterValue as { chatId?: number } | null)?.chatId ?? link.entityId
    if (!(await isChatUnlinked(String(chatId), link.createdAt))) {
      return true
    }
  }
  return false
}

export async function revokeTelegramLink(userId: string): Promise<void> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1)
  if (!user) return

  const links = await db
    .select()
    .from(farmEvents)
    .where(
      and(
        eq(farmEvents.entityType, LINK_ENTITY),
        sql`${farmEvents.afterValue}->>'userId' = ${userId}`,
      ),
    )

  for (const link of links) {
    const chatId = (link.afterValue as { chatId?: number } | null)?.chatId ?? link.entityId
    await recordFarmEvent({
      farmId: user.farmId,
      actorUserId: userId,
      entityType: UNLINK_ENTITY,
      entityId: String(chatId),
      eventType: 'other',
      source: 'web',
      metadata: { revoked: true, userId },
    })
  }
}

export async function resolveActiveTelegramLink(
  chatId: number,
): Promise<(typeof users.$inferSelect) | undefined> {
  const [link] = await db
    .select()
    .from(farmEvents)
    .where(and(eq(farmEvents.entityType, LINK_ENTITY), eq(farmEvents.entityId, String(chatId))))
    .orderBy(desc(farmEvents.createdAt))
    .limit(1)

  if (!link) return undefined
  if (await isChatUnlinked(String(chatId), link.createdAt)) return undefined

  const userId = (link.afterValue as { userId?: string } | null)?.userId
  if (!userId) return undefined

  const [u] = await db.select().from(users).where(eq(users.id, userId)).limit(1)
  if (!u || !u.active) return undefined
  return u
}
