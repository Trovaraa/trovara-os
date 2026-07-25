import { and, desc, eq, inArray, isNotNull, or } from 'drizzle-orm'
import { db } from '../db/index.js'
import { farmEvents, users } from '../db/schema.js'
import type { UserRole } from '../db/schema.js'
import { ORDER_ALERT_ALWAYS_ROLES, WORKER_ALERT_ALWAYS_ROLES } from './rbac.js'
import { recordFarmEvent } from './farm-events.js'
import { isWhatsAppConfigured, sendWhatsAppText } from './whatsapp-meta.js'
import { sendTelegramMessage } from './telegram.js'

type NotifyRecipient = {
  id: string
  phone: string | null
  preferredLocale: string
}

type NotifyOpts = {
  actorUserId?: string
  reason?: string
  kind?: string
  replyMarkup?: Record<string, unknown>
}

type MessageInput = string | ((recipient: NotifyRecipient) => string)

function resolveMessage(message: MessageInput, recipient: NotifyRecipient): string {
  return typeof message === 'function' ? message(recipient) : message
}

/**
 * Push a WhatsApp message to every user on the farm holding one of `roles`.
 * No-op (returns notified: 0) when WhatsApp isn't configured or nobody has a phone.
 * Pass a function as `message` to localize per recipient preferred_locale.
 */
export async function notifyRoles(
  farmId: string,
  roles: UserRole[],
  message: MessageInput,
  opts?: NotifyOpts,
): Promise<{ notified: number }> {
  if (!isWhatsAppConfigured() || roles.length === 0) return { notified: 0 }

  const recipients = await db
    .select({
      id: users.id,
      phone: users.phone,
      preferredLocale: users.preferredLocale,
    })
    .from(users)
    .where(and(eq(users.farmId, farmId), inArray(users.role, roles), isNotNull(users.phone)))

  let notified = 0
  for (const recipient of recipients) {
    if (!recipient.phone) continue
    const text = resolveMessage(message, recipient)
    try {
      const res = await sendWhatsAppText(recipient.phone, text)
      notified++
      await recordFarmEvent({
        farmId,
        actorUserId: opts?.actorUserId,
        entityType: 'whatsapp_message',
        entityId: res.messageId,
        eventType: 'other',
        source: 'butler',
        afterValue: { to: recipient.phone, text, role: 'assistant' },
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
 * Pass a function as `message` to localize per recipient preferred_locale.
 */
export async function notifyRolesTelegram(
  farmId: string,
  roles: UserRole[],
  message: MessageInput,
  opts?: NotifyOpts,
): Promise<{ notified: number }> {
  if (roles.length === 0) return { notified: 0 }

  const recipients = await db
    .select({
      id: users.id,
      phone: users.phone,
      preferredLocale: users.preferredLocale,
    })
    .from(users)
    .where(and(eq(users.farmId, farmId), inArray(users.role, roles)))
  if (!recipients.length) return { notified: 0 }

  const byId = new Map(recipients.map((r) => [r.id, r]))

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
    const recipient = byId.get(v.userId)
    if (!recipient) continue
    const text = resolveMessage(message, recipient)
    try {
      await sendTelegramMessage(v.chatId, text, {
        replyMarkup: opts?.replyMarkup,
      })
      notified += 1
      await recordFarmEvent({
        farmId,
        actorUserId: opts?.actorUserId,
        entityType: 'telegram_message',
        entityId: `alert-${Date.now()}-${v.chatId}`,
        eventType: 'other',
        source: 'butler',
        afterValue: { text, role: 'assistant' },
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

/**
 * Staff who should get customer-order alerts:
 * - supervisor + sales: always
 * - owner: only if order_alerts_subscribed
 * - field_worker: never
 */
export async function listOrderAlertRecipients(farmId: string): Promise<NotifyRecipient[]> {
  return db
    .select({
      id: users.id,
      phone: users.phone,
      preferredLocale: users.preferredLocale,
    })
    .from(users)
    .where(
      and(
        eq(users.farmId, farmId),
        eq(users.active, true),
        or(
          inArray(users.role, ORDER_ALERT_ALWAYS_ROLES),
          and(eq(users.role, 'owner'), eq(users.orderAlertsSubscribed, true)),
        ),
      ),
    )
}

/** WhatsApp customer-order alerts (respects admin subscribe + always roles). */
export async function notifyOrderAlertStaff(
  farmId: string,
  message: MessageInput,
  opts?: NotifyOpts,
): Promise<{ notified: number }> {
  if (!isWhatsAppConfigured()) return { notified: 0 }
  const recipients = (await listOrderAlertRecipients(farmId)).filter((r) => r.phone)
  let notified = 0
  for (const recipient of recipients) {
    if (!recipient.phone) continue
    const text = resolveMessage(message, recipient)
    try {
      const res = await sendWhatsAppText(recipient.phone, text)
      notified++
      await recordFarmEvent({
        farmId,
        actorUserId: opts?.actorUserId,
        entityType: 'whatsapp_message',
        entityId: res.messageId,
        eventType: 'other',
        source: 'butler',
        afterValue: { to: recipient.phone, text, role: 'assistant' },
        metadata: {
          direction: 'outbound',
          kind: opts?.kind ?? 'order_alert',
          reason: opts?.reason ?? null,
        },
      })
    } catch {
      // best-effort
    }
  }
  return { notified }
}

/** Telegram customer-order alerts (respects admin subscribe + always roles). */
export async function notifyOrderAlertStaffTelegram(
  farmId: string,
  message: MessageInput,
  opts?: NotifyOpts,
): Promise<{ notified: number }> {
  const recipients = await listOrderAlertRecipients(farmId)
  if (!recipients.length) return { notified: 0 }

  const byId = new Map(recipients.map((r) => [r.id, r]))
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
    const recipient = byId.get(v.userId)
    if (!recipient) continue
    const text = resolveMessage(message, recipient)
    try {
      await sendTelegramMessage(v.chatId, text, {
        replyMarkup: opts?.replyMarkup,
      })
      notified += 1
      await recordFarmEvent({
        farmId,
        actorUserId: opts?.actorUserId,
        entityType: 'telegram_message',
        entityId: `alert-${Date.now()}-${v.chatId}`,
        eventType: 'other',
        source: 'butler',
        afterValue: { text, role: 'assistant' },
        metadata: {
          direction: 'outbound',
          kind: opts?.kind ?? 'order_alert',
          reason: opts?.reason ?? null,
        },
      })
    } catch {
      // best-effort
    }
  }

  return { notified }
}

/**
 * Staff who should get field-worker alerts:
 * - supervisor: always
 * - owner: only if worker_alerts_subscribed
 */
export async function listWorkerAlertRecipients(farmId: string): Promise<NotifyRecipient[]> {
  return db
    .select({
      id: users.id,
      phone: users.phone,
      preferredLocale: users.preferredLocale,
    })
    .from(users)
    .where(
      and(
        eq(users.farmId, farmId),
        eq(users.active, true),
        or(
          inArray(users.role, WORKER_ALERT_ALWAYS_ROLES),
          and(eq(users.role, 'owner'), eq(users.workerAlertsSubscribed, true)),
        ),
      ),
    )
}

export async function notifyWorkerAlertStaff(
  farmId: string,
  message: MessageInput,
  opts?: NotifyOpts,
): Promise<{ notified: number }> {
  if (!isWhatsAppConfigured()) return { notified: 0 }
  const recipients = (await listWorkerAlertRecipients(farmId)).filter((r) => r.phone)
  let notified = 0
  for (const recipient of recipients) {
    if (!recipient.phone) continue
    const text = resolveMessage(message, recipient)
    try {
      const res = await sendWhatsAppText(recipient.phone, text)
      notified++
      await recordFarmEvent({
        farmId,
        actorUserId: opts?.actorUserId,
        entityType: 'whatsapp_message',
        entityId: res.messageId,
        eventType: 'other',
        source: 'butler',
        afterValue: { to: recipient.phone, text, role: 'assistant' },
        metadata: {
          direction: 'outbound',
          kind: opts?.kind ?? 'worker_alert',
          reason: opts?.reason ?? null,
        },
      })
    } catch {
      // best-effort
    }
  }
  return { notified }
}

export async function notifyWorkerAlertStaffTelegram(
  farmId: string,
  message: MessageInput,
  opts?: NotifyOpts,
): Promise<{ notified: number }> {
  const recipients = await listWorkerAlertRecipients(farmId)
  if (!recipients.length) return { notified: 0 }

  const byId = new Map(recipients.map((r) => [r.id, r]))
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
    const recipient = byId.get(v.userId)
    if (!recipient) continue
    const text = resolveMessage(message, recipient)
    try {
      await sendTelegramMessage(v.chatId, text, {
        replyMarkup: opts?.replyMarkup,
      })
      notified += 1
      await recordFarmEvent({
        farmId,
        actorUserId: opts?.actorUserId,
        entityType: 'telegram_message',
        entityId: `alert-${Date.now()}-${v.chatId}`,
        eventType: 'other',
        source: 'butler',
        afterValue: { text, role: 'assistant' },
        metadata: {
          direction: 'outbound',
          kind: opts?.kind ?? 'worker_alert',
          reason: opts?.reason ?? null,
        },
      })
    } catch {
      // best-effort
    }
  }

  return { notified }
}

/** Fire Telegram + WhatsApp worker alerts (best-effort). */
export async function notifyWorkerAlertChannels(
  farmId: string,
  message: MessageInput,
  opts?: NotifyOpts,
): Promise<void> {
  await Promise.all([
    notifyWorkerAlertStaffTelegram(farmId, message, opts).catch(() => undefined),
    notifyWorkerAlertStaff(farmId, message, opts).catch(() => undefined),
  ])
}

export async function notifyTaskSubmittedForApproval(params: {
  farmId: string
  taskId: string
  taskTitle: string
  workerName: string
  note?: string | null
  actorUserId?: string
}): Promise<void> {
  const ref = `TSK-${params.taskId.replace(/-/g, '').slice(0, 6).toUpperCase()}`
  const noteLine = params.note?.trim() ? `\nNote: ${params.note.trim().slice(0, 200)}` : ''
  const text =
    `✅ Task submitted for approval\n` +
    `${ref} · ${params.taskTitle}\n` +
    `By: ${params.workerName}${noteLine}\n\n` +
    `Reply in Telegram: /approve ${ref} · /reject ${ref}\n` +
    `Or review in Trovara OS → Tasks.`

  await notifyWorkerAlertChannels(params.farmId, text, {
    actorUserId: params.actorUserId,
    reason: 'task_awaiting_approval',
    kind: 'worker_alert',
  })
}

/** Alert supervisors (and opted-in owners) when a field worker clocks in. */
export async function notifyWorkerClockIn(params: {
  farmId: string
  workerName: string
  clockInAt: Date
  actorUserId?: string
  notes?: string | null
}): Promise<void> {
  const when = new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(params.clockInAt)
  const noteLine = params.notes?.trim() ? `\nNote: ${params.notes.trim().slice(0, 200)}` : ''
  const text =
    `🟢 Worker clocked in\n` +
    `${params.workerName} · ${when}${noteLine}\n\n` +
    `See Trovara OS → Today → Attendance.`

  await notifyWorkerAlertChannels(params.farmId, text, {
    actorUserId: params.actorUserId,
    reason: 'attendance_clock_in',
    kind: 'worker_alert',
  })
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
