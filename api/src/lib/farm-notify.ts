import { and, desc, eq, isNotNull } from 'drizzle-orm'
import { db } from '../db/index.js'
import { farmEvents, users } from '../db/schema.js'
import { recordFarmEvent } from './farm-events.js'
import { isWhatsAppConfigured, sendWhatsAppText } from './whatsapp-meta.js'
import { sendTelegramMessage } from './telegram.js'

/**
 * Push a WhatsApp message to the farm owner(s). Used by the butler to escalate
 * urgent issues (sick animals, incidents, low stock) reported by workers.
 * No-op (returns notified: 0) when WhatsApp isn't configured or no owner phone.
 */
export async function notifyOwner(
  farmId: string,
  message: string,
  opts?: { actorUserId?: string; reason?: string },
): Promise<{ notified: number }> {
  if (!isWhatsAppConfigured()) return { notified: 0 }

  const owners = await db
    .select()
    .from(users)
    .where(and(eq(users.farmId, farmId), eq(users.role, 'owner'), isNotNull(users.phone)))

  let notified = 0
  for (const owner of owners) {
    if (!owner.phone) continue
    try {
      const res = await sendWhatsAppText(owner.phone, message)
      notified++
      await recordFarmEvent({
        farmId,
        actorUserId: opts?.actorUserId,
        entityType: 'whatsapp_message',
        entityId: res.messageId,
        eventType: 'other',
        source: 'butler',
        afterValue: { to: owner.phone, text: message, role: 'assistant' },
        metadata: { direction: 'outbound', kind: 'owner_alert', reason: opts?.reason ?? null },
      })
    } catch {
      // owner offline / quota — alert is best-effort
    }
  }

  return { notified }
}

/**
 * Send a Telegram alert to all linked farm owners. Uses Telegram chat links
 * stored in farm_events (entityType: telegram_link).
 */
export async function notifyOwnerTelegram(
  farmId: string,
  message: string,
  opts?: { actorUserId?: string; reason?: string },
): Promise<{ notified: number }> {
  const owners = await db
    .select()
    .from(users)
    .where(and(eq(users.farmId, farmId), eq(users.role, 'owner')))
  if (!owners.length) return { notified: 0 }

  const links = await db
    .select()
    .from(farmEvents)
    .where(and(eq(farmEvents.farmId, farmId), eq(farmEvents.entityType, 'telegram_link')))
    .orderBy(desc(farmEvents.createdAt))

  const ownerIds = new Set(owners.map((o) => o.id))
  const seen = new Set<string>()
  let notified = 0

  for (const link of links) {
    const v = link.afterValue as { userId?: string; chatId?: number } | null
    if (!v?.userId || !v.chatId || !ownerIds.has(v.userId) || seen.has(v.userId)) continue
    seen.add(v.userId)
    try {
      await sendTelegramMessage(v.chatId, message)
      notified += 1
      await recordFarmEvent({
        farmId,
        actorUserId: opts?.actorUserId,
        entityType: 'telegram_message',
        entityId: `alert-${Date.now()}-${v.chatId}`,
        eventType: 'other',
        source: 'butler',
        afterValue: { text: message, role: 'assistant' },
        metadata: {
          direction: 'outbound',
          kind: 'owner_alert',
          reason: opts?.reason ?? null,
        },
      })
    } catch {
      // best-effort
    }
  }

  return { notified }
}

/** Keywords that suggest a worker message should be escalated to the owner. */
const URGENT_PATTERNS = [
  /\bdied?\b/i,
  /\bdead\b/i,
  /\bdying\b/i,
  /\bsick\b/i,
  /\bdisease\b/i,
  /\boutbreak\b/i,
  /\btheft|stolen|thief\b/i,
  /\bfire\b/i,
  /\bflood\b/i,
  /\bemergency\b/i,
  /\bmany (birds|animals|chickens|died)\b/i,
]

export function looksUrgent(text: string): boolean {
  return URGENT_PATTERNS.some((p) => p.test(text))
}
