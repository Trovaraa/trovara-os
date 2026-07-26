import { and, desc, eq, inArray, isNotNull, or } from 'drizzle-orm'
import { db } from '../db/index.js'
import { farmEvents, users } from '../db/schema.js'
import type { UserRole } from '../db/schema.js'
import { ORDER_ALERT_ALWAYS_ROLES, WORKER_ALERT_ALWAYS_ROLES } from './rbac.js'
import { recordFarmEvent } from './farm-events.js'
import { toViewerLocale } from './content-locale.js'
import { resolveStaffReplyLocale, type ReplyLocale } from './reply-locale.js'
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

/**
 * What a per-recipient renderer receives. `locale` is the normalized language to
 * render in; `preferredLocale` carries the same value unnormalized because
 * renderers written before this type existed read that field.
 *
 * It deliberately carries no recipient identity. A renderer must be a pure
 * function of the language, which is what lets one fan-out call render once per
 * distinct locale rather than once per recipient.
 */
export type NotifyLocaleContext = {
  preferredLocale: string
  locale: ReplyLocale
}

export type NotifyRenderer = (ctx: NotifyLocaleContext) => string | Promise<string>

/** Plain string (rendered as-is for everyone) or a per-locale renderer. */
export type MessageInput = string | NotifyRenderer

/**
 * Renderer for text with no fixed template - a worker-authored report being
 * relayed, generated advice. `toViewerLocale` caches by content hash, so the
 * same English relayed to three French workers costs one translation, and this
 * resolver calls it once per language regardless.
 *
 * Only for canonical English. Text that is already localized (weather alerts
 * leave that layer translated) must be passed as a plain string instead.
 */
export function relayFreeFormEnglish(english: string, farmId: string): NotifyRenderer {
  return ({ locale }) => proseForLocale(english, farmId, locale)
}

/**
 * One piece of canonical English prose rendered for one viewer.
 *
 * Falls back to the English on a translator failure: a supervisor reading the
 * worker's note in English beats an alert that never arrives.
 */
async function proseForLocale(
  english: string,
  farmId: string,
  locale: ReplyLocale,
): Promise<string> {
  if (locale === 'en') return english
  try {
    return await toViewerLocale({ english, targetLocale: locale, farmId })
  } catch {
    return english
  }
}

/**
 * Build the per-recipient message resolver for one fan-out call.
 *
 * Renderers run at most once per language even when they hit the network, and a
 * renderer that throws or returns nothing falls back to English: an urgent
 * mortality alert in English beats no alert at all. Resolves to null only when
 * there is genuinely nothing sendable.
 */
function createMessageResolver(
  message: MessageInput,
): (preferredLocale: string) => Promise<string | null> {
  if (typeof message === 'string') return async () => message

  const rendered = new Map<ReplyLocale, Promise<string | null>>()

  const render = (locale: ReplyLocale): Promise<string | null> => {
    const inFlight = rendered.get(locale)
    if (inFlight) return inFlight
    const pending = (async () => {
      try {
        const text = await message({ preferredLocale: locale, locale })
        return text.trim() ? text : null
      } catch {
        return null
      }
    })()
    rendered.set(locale, pending)
    return pending
  }

  return async (preferredLocale) => {
    const locale = resolveStaffReplyLocale(preferredLocale)
    const text = await render(locale)
    if (text !== null) return text
    return locale === 'en' ? null : render('en')
  }
}

type MsgTable = Record<ReplyLocale, string>

function pick(locale: ReplyLocale, table: MsgTable): string {
  return table[locale] ?? table.en
}

/**
 * Push a WhatsApp message to every user on the farm holding one of `roles`.
 * No-op (returns notified: 0) when WhatsApp isn't configured or nobody has a phone.
 * Pass a renderer as `message` to send each recipient their preferred_locale;
 * it runs once per distinct language, not once per recipient.
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

  const resolve = createMessageResolver(message)
  let notified = 0
  for (const recipient of recipients) {
    if (!recipient.phone) continue
    const text = await resolve(recipient.preferredLocale)
    if (text === null) continue
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
 * Pass a renderer as `message` to send each recipient their preferred_locale;
 * it runs once per distinct language, not once per recipient.
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

  const resolve = createMessageResolver(message)
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
    const text = await resolve(recipient.preferredLocale)
    if (text === null) continue
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
  const resolve = createMessageResolver(message)
  let notified = 0
  for (const recipient of recipients) {
    if (!recipient.phone) continue
    const text = await resolve(recipient.preferredLocale)
    if (text === null) continue
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

  const resolve = createMessageResolver(message)
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
    const text = await resolve(recipient.preferredLocale)
    if (text === null) continue
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
  const resolve = createMessageResolver(message)
  let notified = 0
  for (const recipient of recipients) {
    if (!recipient.phone) continue
    const text = await resolve(recipient.preferredLocale)
    if (text === null) continue
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

  const resolve = createMessageResolver(message)
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
    const text = await resolve(recipient.preferredLocale)
    if (text === null) continue
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

/**
 * Labels for the alerts composed here. The task ref, the worker name, the task
 * title, the timestamp and the /approve and /reject commands are data, so they
 * stay verbatim in every language.
 */
const NOTE_LABEL: MsgTable = {
  en: 'Note',
  fr: 'Remarque',
  yo: 'Àkíyèsí',
  pcm: 'Note',
}

/**
 * The note is worker prose held in canonical English, so it is translated for
 * the reader rather than pasted in. Truncation happens before translation to
 * cap what reaches the model, which also keeps the cut at the same point in the
 * text it is today.
 */
async function noteLine(
  locale: ReplyLocale,
  farmId: string,
  note?: string | null,
): Promise<string> {
  const trimmed = note?.trim()
  if (!trimmed) return ''
  const shown = await proseForLocale(trimmed.slice(0, 200), farmId, locale)
  return `\n${pick(locale, NOTE_LABEL)}: ${shown}`
}

async function taskApprovalMessage(
  locale: ReplyLocale,
  farmId: string,
  params: { ref: string; taskTitle: string; workerName: string; note?: string | null },
): Promise<string> {
  const header = pick(locale, {
    en: '✅ Task submitted for approval',
    fr: '✅ Tâche soumise pour approbation',
    yo: '✅ Iṣẹ́ tí a fi sílẹ̀ fún ìfọwọ́sí',
    pcm: '✅ Work don submit for approval',
  })
  const byLabel = pick(locale, { en: 'By', fr: 'Par', yo: 'Láti ọwọ́', pcm: 'Na' })
  const replyLine = pick(locale, {
    en: `Reply in Telegram: /approve ${params.ref} · /reject ${params.ref}`,
    fr: `Répondez dans Telegram : /approve ${params.ref} · /reject ${params.ref}`,
    yo: `Dáhùn ní Telegram: /approve ${params.ref} · /reject ${params.ref}`,
    pcm: `Reply for Telegram: /approve ${params.ref} · /reject ${params.ref}`,
  })
  const reviewLine = pick(locale, {
    en: 'Or review in Trovara OS → Tasks.',
    fr: 'Ou examinez dans Trovara OS → Tâches.',
    yo: 'Tàbí wo ó ní Trovara OS → Tasks.',
    pcm: 'Or check am for Trovara OS → Tasks.',
  })

  // The task title is stored in English too, so an approver reading in French
  // would otherwise get a French frame around an English task.
  const [title, note] = await Promise.all([
    proseForLocale(params.taskTitle, farmId, locale),
    noteLine(locale, farmId, params.note),
  ])

  return (
    `${header}\n` +
    `${params.ref} · ${title}\n` +
    `${byLabel}: ${params.workerName}${note}\n\n` +
    `${replyLine}\n` +
    reviewLine
  )
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

  await notifyWorkerAlertChannels(
    params.farmId,
    ({ locale }) =>
      taskApprovalMessage(locale, params.farmId, {
        ref,
        taskTitle: params.taskTitle,
        workerName: params.workerName,
        note: params.note,
      }),
    {
      actorUserId: params.actorUserId,
      reason: 'task_awaiting_approval',
      kind: 'worker_alert',
    },
  )
}

/** Alert supervisors (and opted-in owners) when a field worker clocks in. */
export async function notifyWorkerClockIn(params: {
  farmId: string
  workerName: string
  clockInAt: Date
  actorUserId?: string
  notes?: string | null
}): Promise<void> {
  // One clock format for every locale: Node may ship without full ICU data, so
  // a localized pattern would silently degrade to English anyway.
  const when = new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(params.clockInAt)

  const render = async ({ locale }: NotifyLocaleContext) => {
    const header = pick(locale, {
      en: '🟢 Worker clocked in',
      fr: '🟢 Ouvrier pointé à l’arrivée',
      yo: '🟢 Òṣìṣẹ́ ti wọlé sí iṣẹ́',
      pcm: '🟢 Worker don clock in',
    })
    const footer = pick(locale, {
      en: 'See Trovara OS → Today → Attendance.',
      fr: 'Voir Trovara OS → Aujourd’hui → Présence.',
      yo: 'Wo Trovara OS → Today → Attendance.',
      pcm: 'Check Trovara OS → Today → Attendance.',
    })
    const note = await noteLine(locale, params.farmId, params.notes)
    return `${header}\n${params.workerName} · ${when}${note}\n\n${footer}`
  }

  await notifyWorkerAlertChannels(params.farmId, render, {
    actorUserId: params.actorUserId,
    reason: 'attendance_clock_in',
    kind: 'worker_alert',
  })
}

/** WhatsApp alert to the farm owner(s). */
export function notifyOwner(
  farmId: string,
  message: MessageInput,
  opts?: { actorUserId?: string; reason?: string },
): Promise<{ notified: number }> {
  return notifyRoles(farmId, ['owner'], message, { ...opts, kind: 'owner_alert' })
}

/** Telegram alert to the farm owner(s). */
export function notifyOwnerTelegram(
  farmId: string,
  message: MessageInput,
  opts?: { actorUserId?: string; reason?: string },
): Promise<{ notified: number }> {
  return notifyRolesTelegram(farmId, ['owner'], message, { ...opts, kind: 'owner_alert' })
}

/** Telegram alert to the farm supervisor(s) - used for field-ops reminders. */
export function notifySupervisorsTelegram(
  farmId: string,
  message: MessageInput,
  opts?: { actorUserId?: string; reason?: string },
): Promise<{ notified: number }> {
  return notifyRolesTelegram(farmId, ['supervisor'], message, { ...opts, kind: 'supervisor_alert' })
}

/** WhatsApp alert to the farm supervisor(s). */
export function notifySupervisors(
  farmId: string,
  message: MessageInput,
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
