import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm'
import { db } from '../db/index.js'
import { farmEvents, users } from '../db/schema.js'
import type { UserRole } from '../db/schema.js'
import { recordFarmEvent } from './farm-events.js'
import { isWhatsAppConfigured, sendWhatsAppText } from './whatsapp-meta.js'
import { sendTelegramMessage } from './telegram.js'

type NotifyOpts = { actorUserId?: string; reason?: string; kind?: string }

/**
 * Push a WhatsApp message to every user on the farm holding one of `roles`.
 * No-op (returns notified: 0) when WhatsApp isn't configured or nobody has a phone.
 */
export async function notifyRoles(
  farmId: string,
  roles: UserRole[],
  message: string,
  opts?: NotifyOpts,
): Promise<{ notified: number }> {
  if (!isWhatsAppConfigured() || roles.length === 0) return { notified: 0 }

  const recipients = await db
    .select()
    .from(users)
    .where(and(eq(users.farmId, farmId), inArray(users.role, roles), isNotNull(users.phone)))

  let notified = 0
  for (const recipient of recipients) {
    if (!recipient.phone) continue
    try {
      const res = await sendWhatsAppText(recipient.phone, message)
      notified++
      await recordFarmEvent({
        farmId,
        actorUserId: opts?.actorUserId,
        entityType: 'whatsapp_message',
        entityId: res.messageId,
        eventType: 'other',
        source: 'butler',
        afterValue: { to: recipient.phone, text: message, role: 'assistant' },
        metadata: {
          direction: 'outbound',
          kind: opts?.kind ?? 'role_alert',
          reason: opts?.reason ?? null,
        },
      })
    } catch {
      // recipient offline / quota - alert is best-effort
    }
  }

  return { notified }
}

/**
 * Send a Telegram alert to every user on the farm holding one of `roles`.
 * Uses Telegram chat links stored in farm_events (entityType: telegram_link).
 */
export async function notifyRolesTelegram(
  farmId: string,
  roles: UserRole[],
  message: string,
  opts?: NotifyOpts,
): Promise<{ notified: number }> {
  if (roles.length === 0) return { notified: 0 }

  const recipients = await db
    .select()
    .from(users)
    .where(and(eq(users.farmId, farmId), inArray(users.role, roles)))
  if (!recipients.length) return { notified: 0 }

  const links = await db
    .select()
    .from(farmEvents)
    .where(and(eq(farmEvents.farmId, farmId), eq(farmEvents.entityType, 'telegram_link')))
    .orderBy(desc(farmEvents.createdAt))

  const recipientIds = new Set(recipients.map((r) => r.id))
  const seen = new Set<string>()
  let notified = 0

  for (const link of links) {
    const v = link.afterValue as { userId?: string; chatId?: number } | null
    if (!v?.userId || !v.chatId || !recipientIds.has(v.userId) || seen.has(v.userId)) continue
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
          kind: opts?.kind ?? 'role_alert',
          reason: opts?.reason ?? null,
        },
      })
    } catch {
      // best-effort
    }
  }

  return { notified }
}

/** WhatsApp alert to the farm owner(s). */
export function notifyOwner(
  farmId: string,
  message: string,
  opts?: { actorUserId?: string; reason?: string },
): Promise<{ notified: number }> {
  return notifyRoles(farmId, ['owner'], message, { ...opts, kind: 'owner_alert' })
}

/** Telegram alert to the farm owner(s). */
export function notifyOwnerTelegram(
  farmId: string,
  message: string,
  opts?: { actorUserId?: string; reason?: string },
): Promise<{ notified: number }> {
  return notifyRolesTelegram(farmId, ['owner'], message, { ...opts, kind: 'owner_alert' })
}

/** Telegram alert to the farm supervisor(s) - used for field-ops reminders. */
export function notifySupervisorsTelegram(
  farmId: string,
  message: string,
  opts?: { actorUserId?: string; reason?: string },
): Promise<{ notified: number }> {
  return notifyRolesTelegram(farmId, ['supervisor'], message, { ...opts, kind: 'supervisor_alert' })
}

/** WhatsApp alert to the farm supervisor(s). */
export function notifySupervisors(
  farmId: string,
  message: string,
  opts?: { actorUserId?: string; reason?: string },
): Promise<{ notified: number }> {
  return notifyRoles(farmId, ['supervisor'], message, { ...opts, kind: 'supervisor_alert' })
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
