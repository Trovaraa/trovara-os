import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm'
import { db } from '../db/index.js'
import { customerContacts, orderItems, orders, users } from '../db/schema.js'
import type { PreferredLocale, UserRole } from '../db/schema.js'
import { logAudit } from './audit.js'
import { orderReference } from './customer-cart.js'
import { recordFarmEvent } from './farm-events.js'
import { notifyOrderAlertStaff, notifyOrderAlertStaffTelegram } from './farm-notify.js'
import { canTransitionOrder, type OrderStatus } from './state-machines.js'
import { sendTelegramMessage } from './telegram.js'
import { isWhatsAppConfigured, isWhatsAppCustomerConfigured, sendWhatsAppText } from './whatsapp-meta.js'
import {
  customerStatusMessage,
  feedbackStaffSummary,
  feedbackThanksMessage,
  newOrderStaffMessage,
  orderActionResultMessage,
  staffLocale,
} from './order-messages.js'

export { ORDER_STAFF_ROLES, ORDER_ALERT_ALWAYS_ROLES } from './rbac.js'

type Actor = {
  id: string
  farmId: string
  role: UserRole
  name?: string
  preferredLocale?: string | null
}

export function orderConfirmKeyboard(orderId: string) {
  return {
    inline_keyboard: [
      [
        { text: '✅ Confirm', callback_data: `order:confirm:${orderId}` },
        { text: '❌ Cancel', callback_data: `order:cancel:${orderId}` },
      ],
    ],
  }
}

export type OrderStaffAction = 'confirm' | 'cancel' | 'dispatch' | 'deliver'

/** Inline picker for /dispatch or /delivered when no order id is given. */
export function orderPickerKeyboard(
  action: Extract<OrderStaffAction, 'confirm' | 'dispatch' | 'deliver'>,
  rows: Array<{ id: string; label: string }>,
) {
  return {
    inline_keyboard: rows.slice(0, 8).map((row) => [
      {
        text: row.label.slice(0, 64),
        callback_data: `order:${action}:${row.id}`,
      },
    ]),
  }
}

export function languageKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: 'English', callback_data: 'lang:en' },
        { text: 'Yorùbá', callback_data: 'lang:yo' },
      ],
      [
        { text: 'Pidgin', callback_data: 'lang:pcm' },
        { text: 'Français', callback_data: 'lang:fr' },
      ],
    ],
  }
}

export async function setUserPreferredLocale(
  userId: string,
  locale: PreferredLocale,
): Promise<void> {
  await db
    .update(users)
    .set({ preferredLocale: locale })
    .where(eq(users.id, userId))
}

export async function findOrderByReference(farmId: string, rawRef: string | null | undefined) {
  if (!rawRef?.trim()) return null
  const ref = rawRef.trim().toUpperCase()
  const match = ref.match(/^(?:TRV-ORD-)?([A-F0-9]{6})$/i)
  if (!match) return null
  const prefix = match[1]!.toUpperCase()

  const rows = await db.select().from(orders).where(eq(orders.farmId, farmId))
  return rows.find((o) => orderReference(o.id) === `TRV-ORD-${prefix}`) ?? null
}

export async function findOrderById(farmId: string, orderId: string) {
  const [row] = await db
    .select()
    .from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.farmId, farmId)))
    .limit(1)
  return row ?? null
}

async function loadOrderItems(orderId: string) {
  return db.select().from(orderItems).where(eq(orderItems.orderId, orderId))
}

async function notifyCustomerChannel(params: {
  farmId: string
  contactId: string | null
  message: string
}): Promise<void> {
  if (!params.contactId) return
  const [contact] = await db
    .select()
    .from(customerContacts)
    .where(and(eq(customerContacts.id, params.contactId), eq(customerContacts.farmId, params.farmId)))
    .limit(1)
  if (!contact) return

  try {
    if (contact.channel === 'telegram') {
      const chatId = Number(contact.externalId)
      if (!Number.isFinite(chatId)) return
      await sendTelegramMessage(chatId, params.message, { kind: 'customer' })
      return
    }
    if (contact.channel === 'whatsapp') {
      if (!isWhatsAppCustomerConfigured() && !isWhatsAppConfigured()) return
      const phone = contact.phone || contact.externalId
      if (!phone) return
      await sendWhatsAppText(phone, params.message, { kind: 'customer' })
    }
  } catch (err) {
    console.error('Customer order notify failed:', err instanceof Error ? err.message : err)
  }
}

/**
 * Alert order staff on Telegram and WhatsApp.
 * Supervisor + sales always; admin only if subscribed; field workers never.
 */
export async function notifyStaffNewOrder(params: {
  farmId: string
  orderId: string
  reference: string
  channel: string
  customerName: string
  phone: string
  address: string
  lotCode?: string
  itemLines: string
  totalLine?: string
  actorUserId?: string
}): Promise<void> {
  const buildMessage = (recipient: { preferredLocale: string }) =>
    newOrderStaffMessage({
      locale: staffLocale(recipient.preferredLocale),
      reference: params.reference,
      channel: params.channel,
      itemLines: params.itemLines,
      totalLine: params.totalLine,
      lotCode: params.lotCode,
      customerName: params.customerName,
      phone: params.phone,
      address: params.address,
    })

  await notifyOrderAlertStaffTelegram(params.farmId, buildMessage, {
    actorUserId: params.actorUserId,
    reason: 'new_customer_order',
    kind: 'order_alert',
    replyMarkup: orderConfirmKeyboard(params.orderId),
  })
  await notifyOrderAlertStaff(params.farmId, buildMessage, {
    actorUserId: params.actorUserId,
    reason: 'new_customer_order',
    kind: 'order_alert',
  })
}

export async function transitionOrder(params: {
  farmId: string
  orderId: string
  toStatus: OrderStatus
  actor: Actor
  deliveryPhotoUrl?: string | null
  skipCustomerNotify?: boolean
  skipStaffNotify?: boolean
}): Promise<{ ok: true; order: typeof orders.$inferSelect } | { ok: false; error: string }> {
  const existing = await findOrderById(params.farmId, params.orderId)
  if (!existing) return { ok: false, error: 'Order not found' }

  const fromStatus = existing.status as OrderStatus
  if (!canTransitionOrder(fromStatus, params.toStatus, params.actor.role)) {
    return { ok: false, error: 'Invalid status transition' }
  }

  // Payment gate: unpaid orders cannot leave the farm (dispatch/deliver).
  // not_required, paid, refunded, etc. are allowed; only unpaid blocks.
  if (
    (params.toStatus === 'dispatched' || params.toStatus === 'delivered') &&
    existing.paymentStatus === 'unpaid'
  ) {
    return { ok: false, error: 'Cannot dispatch or deliver an unpaid order' }
  }

  const updates: Partial<typeof existing> = {
    status: params.toStatus,
    updatedAt: new Date(),
  }
  if (params.toStatus === 'dispatched') {
    updates.dispatchedAt = new Date()
  }
  if (params.toStatus === 'delivered') {
    if (params.deliveryPhotoUrl) updates.deliveryPhotoUrl = params.deliveryPhotoUrl
    updates.feedbackRequestedAt = new Date()
  }

  const [order] = await db
    .update(orders)
    .set(updates)
    .where(eq(orders.id, params.orderId))
    .returning()

  await recordFarmEvent({
    farmId: params.farmId,
    actorUserId: params.actor.id,
    entityType: 'order',
    entityId: params.orderId,
    eventType: params.toStatus === 'delivered' ? 'sold' : 'other',
    beforeValue: { status: fromStatus },
    afterValue: {
      status: order.status,
      deliveryPhotoUrl: order.deliveryPhotoUrl ?? undefined,
    },
    metadata: { lotId: order.lotId ?? undefined, totalAmount: order.totalAmount },
  })

  await logAudit({
    farmId: params.farmId,
    userId: params.actor.id,
    action: 'update',
    entityType: 'order',
    entityId: params.orderId,
    metadata: { status: order.status },
  })

  const reference = orderReference(order.id)

  if (
    !params.skipCustomerNotify &&
    order.customerContactId &&
    (params.toStatus === 'confirmed' ||
      params.toStatus === 'dispatched' ||
      params.toStatus === 'delivered' ||
      params.toStatus === 'cancelled')
  ) {
    await notifyCustomerChannel({
      farmId: params.farmId,
      contactId: order.customerContactId,
      message: customerStatusMessage({
        locale: 'en',
        reference,
        status: params.toStatus,
      }),
    })
  }

  return { ok: true, order }
}

export async function recordCustomerFeedback(params: {
  farmId: string
  contactId: string
  text: string
}): Promise<{ handled: boolean; message?: string }> {
  const feedback = params.text.trim()
  if (!feedback || feedback.length > 2000) return { handled: false }

  const [order] = await db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.farmId, params.farmId),
        eq(orders.customerContactId, params.contactId),
        eq(orders.status, 'delivered'),
        isNotNull(orders.feedbackRequestedAt),
        isNull(orders.customerFeedback),
      ),
    )
    .orderBy(desc(orders.feedbackRequestedAt))
    .limit(1)

  if (!order) return { handled: false }

  await db
    .update(orders)
    .set({
      customerFeedback: feedback.slice(0, 2000),
      customerFeedbackAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(orders.id, order.id))

  await recordFarmEvent({
    farmId: params.farmId,
    entityType: 'order',
    entityId: order.id,
    eventType: 'other',
    source: 'customer',
    afterValue: { feedback: feedback.slice(0, 500) },
    metadata: { kind: 'customer_feedback' },
  })

  const reference = orderReference(order.id)
  const feedbackSummary = (recipient: { preferredLocale: string }) =>
    feedbackStaffSummary({
      locale: staffLocale(recipient.preferredLocale),
      reference,
      customerName: order.customerName,
      feedback: feedback.slice(0, 400),
    })

  await notifyOrderAlertStaffTelegram(params.farmId, feedbackSummary, {
    reason: 'customer_feedback',
    kind: 'order_alert',
  })
  await notifyOrderAlertStaff(params.farmId, feedbackSummary, {
    reason: 'customer_feedback',
    kind: 'order_alert',
  })

  return { handled: true, message: feedbackThanksMessage('en') }
}

/**
 * Parse staff order commands from text/voice/slash commands.
 * Examples:
 *   "confirm TRV-ORD-3F20EC"
 *   "/dispatch"
 *   "/delivered TRV-ORD-3F20EC"
 *   "delivered TRV-ORD-3F20EC"
 */
export function parseStaffOrderCommand(
  text: string,
): { action: OrderStaffAction; ref?: string } | null {
  const trimmed = text.trim()
  const match = trimmed.match(
    /^\/?(confirm|dispatch|dispatched|delivered|deliver|cancel)(?:\s+(\S+))?$/i,
  )
  if (!match) return null

  const raw = match[1]!.toLowerCase()
  let action: OrderStaffAction
  if (raw === 'confirm') action = 'confirm'
  else if (raw === 'dispatch' || raw === 'dispatched') action = 'dispatch'
  else if (raw === 'delivered' || raw === 'deliver') action = 'deliver'
  else action = 'cancel'

  const ref = match[2]?.trim()
  return { action, ref: ref || undefined }
}

export async function listOrdersForAction(
  farmId: string,
  action: Extract<OrderStaffAction, 'confirm' | 'dispatch' | 'deliver'>,
): Promise<Array<{ id: string; label: string; reference: string }>> {
  const statusFilter =
    action === 'confirm' ? 'pending' : action === 'dispatch' ? 'confirmed' : 'dispatched'

  const rows = await db
    .select({
      id: orders.id,
      customerName: orders.customerName,
      status: orders.status,
    })
    .from(orders)
    .where(and(eq(orders.farmId, farmId), eq(orders.status, statusFilter)))
    .orderBy(desc(orders.updatedAt))
    .limit(8)

  return rows.map((row) => {
    const reference = orderReference(row.id)
    return {
      id: row.id,
      reference,
      label: `${reference} · ${row.customerName}`,
    }
  })
}

/**
 * Parse staff order commands from text/voice.
 * When action is given without an order id, returns a picker keyboard (Telegram).
 */
export async function tryHandleStaffOrderCommand(params: {
  actor: Actor
  text: string
  deliveryPhotoUrl?: string | null
}): Promise<{
  handled: boolean
  reply?: string
  replyMarkup?: Record<string, unknown>
}> {
  const locale = staffLocale(params.actor.preferredLocale)
  const parsed = parseStaffOrderCommand(params.text)
  if (!parsed) return { handled: false }

  const { action } = parsed

  if (!parsed.ref) {
    if (action === 'cancel') {
      return {
        handled: true,
        reply: pickLocaleHelp(locale, 'cancel_needs_ref'),
      }
    }
    const eligible = await listOrdersForAction(params.actor.farmId, action)
    if (!eligible.length) {
      return {
        handled: true,
        reply: pickLocaleHelp(locale, `none_${action}`),
      }
    }
    return {
      handled: true,
      reply: pickLocaleHelp(locale, `pick_${action}`),
      replyMarkup: orderPickerKeyboard(action, eligible),
    }
  }

  const order = await findOrderByReference(params.actor.farmId, parsed.ref)
  if (!order) {
    return {
      handled: true,
      reply: orderActionResultMessage({
        locale,
        reference: parsed.ref,
        status: '',
        ok: false,
        error: 'order not found',
      }),
    }
  }

  const toStatus: OrderStatus =
    action === 'confirm'
      ? 'confirmed'
      : action === 'dispatch'
        ? 'dispatched'
        : action === 'deliver'
          ? 'delivered'
          : 'cancelled'

  const result = await transitionOrder({
    farmId: params.actor.farmId,
    orderId: order.id,
    toStatus,
    actor: params.actor,
    deliveryPhotoUrl: toStatus === 'delivered' ? params.deliveryPhotoUrl : undefined,
  })

  const reference = orderReference(order.id)
  if (!result.ok) {
    return {
      handled: true,
      reply: orderActionResultMessage({
        locale,
        reference,
        status: toStatus,
        ok: false,
        error: result.error,
      }),
    }
  }

  return {
    handled: true,
    reply: orderActionResultMessage({
      locale,
      reference,
      status: toStatus,
      ok: true,
    }),
  }
}

function pickLocaleHelp(
  locale: ReturnType<typeof staffLocale>,
  key:
    | 'cancel_needs_ref'
    | 'none_confirm'
    | 'none_dispatch'
    | 'none_deliver'
    | 'pick_confirm'
    | 'pick_dispatch'
    | 'pick_deliver',
): string {
  const table: Record<typeof key, Record<typeof locale, string>> = {
    cancel_needs_ref: {
      en: 'To cancel, include the order id: /cancel TRV-ORD-…',
      fr: 'Pour annuler, ajoutez l’id : /cancel TRV-ORD-…',
      yo: 'Láti fagilé, fi id kún un: /cancel TRV-ORD-…',
      pcm: 'To cancel, add di order id: /cancel TRV-ORD-…',
    },
    none_confirm: {
      en: 'No pending orders to confirm.',
      fr: 'Aucune commande en attente à confirmer.',
      yo: 'Kò sí àṣẹ tí ó ń dúró fún ìjẹ́rìí.',
      pcm: 'No pending order to confirm.',
    },
    none_dispatch: {
      en: 'No confirmed orders ready to dispatch.',
      fr: 'Aucune commande confirmée à expédier.',
      yo: 'Kò sí àṣẹ tí a jẹ́rìí sí fún ìfihàn.',
      pcm: 'No confirmed order ready to dispatch.',
    },
    none_deliver: {
      en: 'No dispatched orders ready to mark delivered.',
      fr: 'Aucune commande en livraison à marquer livrée.',
      yo: 'Kò sí àṣẹ tó ti jáde láti sàmì pé ó ti dé.',
      pcm: 'No dispatched order ready to mark delivered.',
    },
    pick_confirm: {
      en: 'Select an order to confirm:',
      fr: 'Choisissez une commande à confirmer :',
      yo: 'Yan àṣẹ láti jẹ́rìí:',
      pcm: 'Select order to confirm:',
    },
    pick_dispatch: {
      en: 'Select an order to mark dispatched:',
      fr: 'Choisissez une commande à marquer expédiée :',
      yo: 'Yan àṣẹ láti sàmì pé ó ti jáde:',
      pcm: 'Select order to mark dispatched:',
    },
    pick_deliver: {
      en: 'Select an order to mark delivered:',
      fr: 'Choisissez une commande à marquer livrée :',
      yo: 'Yan àṣẹ láti sàmì pé ó ti dé:',
      pcm: 'Select order to mark delivered:',
    },
  }
  return table[key][locale] ?? table[key].en
}

export async function transitionOrderFromCallback(params: {
  actor: Actor
  orderId: string
  action: OrderStaffAction
}): Promise<{ handled: boolean; reply: string }> {
  const locale = staffLocale(params.actor.preferredLocale)
  const toStatus: OrderStatus =
    params.action === 'confirm'
      ? 'confirmed'
      : params.action === 'dispatch'
        ? 'dispatched'
        : params.action === 'deliver'
          ? 'delivered'
          : 'cancelled'
  const result = await transitionOrder({
    farmId: params.actor.farmId,
    orderId: params.orderId,
    toStatus,
    actor: params.actor,
  })
  const order = result.ok ? result.order : await findOrderById(params.actor.farmId, params.orderId)
  const reference = order ? orderReference(order.id) : params.orderId
  if (!result.ok) {
    return {
      handled: true,
      reply: orderActionResultMessage({
        locale,
        reference,
        status: toStatus,
        ok: false,
        error: result.error,
      }),
    }
  }
  return {
    handled: true,
    reply: orderActionResultMessage({
      locale,
      reference,
      status: toStatus,
      ok: true,
    }),
  }
}

/** Used when creating orders — builds item lines for staff alerts. */
export async function formatOrderItemLines(orderId: string): Promise<string> {
  const items = await loadOrderItems(orderId)
  if (!items.length) return '• (no line items)'
  return items.map((i) => `• ${i.quantity} × ${i.productName}`).join('\n')
}
