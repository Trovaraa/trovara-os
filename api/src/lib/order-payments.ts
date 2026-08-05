import { randomBytes } from 'node:crypto'
import { and, count, desc, eq, like, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import {
  invoices,
  orderItems,
  orders,
  paymentAttempts,
  paymentReceipts,
  paymentRefunds,
  users,
  type PaymentStatus,
} from '../db/schema.js'
import { orderReference, formatNaira } from './customer-cart.js'
import {
  findOrderById,
  findOrderByReference,
  transitionOrder,
} from './order-fulfillment.js'
import {
  notifyOrderAlertStaff,
  notifyOrderAlertStaffTelegram,
  type NotifyRenderer,
} from './farm-notify.js'
import type { ReplyLocale } from './reply-locale.js'
import { initializeTransaction, isPaystackConfigured, refundTransaction } from './paystack.js'
import { logAudit } from './audit.js'

const CANCEL_WINDOW_MS = 24 * 60 * 60 * 1000

function publicAppUrl(): string {
  return (process.env.PUBLIC_APP_URL ?? 'https://os.trovara.farm').replace(/\/+$/, '')
}

function publicToken(): string {
  return randomBytes(24).toString('base64url')
}

/** Pay reference: TRV-PAY-{6 hex from order id}-{random}. */
export function makePayReference(orderId: string): string {
  const short = orderId.replace(/-/g, '').slice(0, 6).toUpperCase()
  const rand = randomBytes(4).toString('hex').toUpperCase()
  return `TRV-PAY-${short}-${rand}`
}

export async function sumOrderItemsKobo(orderId: string): Promise<number> {
  const items = await db.select().from(orderItems).where(eq(orderItems.orderId, orderId))
  return items.reduce((sum, i) => sum + (i.lineTotalKobo ?? 0), 0)
}

async function findFarmOwnerActor(farmId: string) {
  const [owner] = await db
    .select()
    .from(users)
    .where(and(eq(users.farmId, farmId), eq(users.role, 'owner'), eq(users.active, true)))
    .limit(1)
  if (!owner) return null
  return {
    id: owner.id,
    farmId: owner.farmId,
    role: owner.role as 'owner',
    name: owner.name,
    preferredLocale: owner.preferredLocale,
  }
}

async function nextInvoiceNumber(farmId: string, year: number): Promise<string> {
  const prefix = `TRV-INV-${year}-`
  const [row] = await db
    .select({ total: count() })
    .from(invoices)
    .where(and(eq(invoices.farmId, farmId), like(invoices.invoiceNumber, `${prefix}%`)))
  const seq = Number(row?.total ?? 0) + 1
  return `${prefix}${String(seq).padStart(5, '0')}`
}

async function nextReceiptNumber(farmId: string, year: number): Promise<string> {
  const prefix = `TRV-RCP-${year}-`
  const [row] = await db
    .select({ total: count() })
    .from(paymentReceipts)
    .where(and(eq(paymentReceipts.farmId, farmId), like(paymentReceipts.receiptNumber, `${prefix}%`)))
  const seq = Number(row?.total ?? 0) + 1
  return `${prefix}${String(seq).padStart(5, '0')}`
}

type MsgTable = Record<ReplyLocale, string>

function pick(locale: ReplyLocale, table: MsgTable): string {
  return table[locale] ?? table.en
}

/**
 * Locale tables for the staff payment alerts, in the style of
 * digest-messages.ts: fixed sentences we wrote ourselves, so a table beats a
 * translation call - instant, and it still works with the LLM off.
 *
 * Everything a staff member might quote back at us stays verbatim in every
 * language: the order reference and the Paystack reference are typed into chat
 * to look an order up, and the amount arrives pre-formatted by `formatNaira`,
 * which renders one en-NG figure for all four locales (matching what the
 * customer's own receipt shows, and what the digest does with its counters -
 * no per-locale number formatting, which Node without full ICU data would
 * silently degrade anyway).
 */
export function renderPaymentReceived(
  locale: ReplyLocale,
  params: { orderRef: string; amount: string; paymentRef: string },
): string {
  const header = pick(locale, {
    en: `💰 Payment received for ${params.orderRef}`,
    fr: `💰 Paiement reçu pour ${params.orderRef}`,
    yo: `💰 A gba owó fún ${params.orderRef}`,
    pcm: `💰 Payment don land for ${params.orderRef}`,
  })
  const amountLabel = pick(locale, {
    en: 'Amount',
    fr: 'Montant',
    yo: 'Owó',
    pcm: 'Amount',
  })
  const refLabel = pick(locale, { en: 'Ref', fr: 'Réf', yo: 'Ref', pcm: 'Ref' })
  const confirmLine = pick(locale, {
    en: 'Order auto-confirmed if it was pending.',
    fr: 'Commande confirmée automatiquement si elle était en attente.',
    yo: 'Òrder náà ti fọwọ́sí fúnra rẹ̀ bí ó ti wà ní ìdúró.',
    pcm: 'Order don auto-confirm if e still dey pending.',
  })

  return (
    `${header}\n` +
    `${amountLabel}: ${params.amount}\n` +
    `${refLabel}: ${params.paymentRef}\n` +
    confirmLine
  )
}

/** "Sales" is the app's own nav label, so it stays untranslated like Trovara OS → Tasks. */
export function renderCustomerCancelRefund(
  locale: ReplyLocale,
  params: { orderRef: string },
): string {
  const header = pick(locale, {
    en: `⚠️ Customer cancelled ${params.orderRef} — initiate refund in Sales.`,
    fr: `⚠️ Le client a annulé ${params.orderRef} — lancez le remboursement dans Sales.`,
    yo: `⚠️ Oníbàárà fagilé ${params.orderRef} — bẹ̀rẹ̀ ìdápadà owó ní Sales.`,
    pcm: `⚠️ Customer don cancel ${params.orderRef} — start refund for Sales.`,
  })
  const note = pick(locale, {
    en: 'Payment was received; refund is not automatic.',
    fr: 'Le paiement a été reçu ; le remboursement n’est pas automatique.',
    yo: 'A ti gba owó; ìdápadà owó kò ṣẹlẹ̀ fúnra rẹ̀.',
    pcm: 'We don collect payment; refund no dey happen by itself.',
  })

  return `${header}\n${note}`
}

/**
 * Fan a payment alert out to order-alert staff on both channels. `render` runs
 * once per distinct language per channel, so a mixed-language sales team costs
 * no more than a single-language one.
 */
async function notifyStaffPaymentMessage(params: {
  farmId: string
  render: (locale: ReplyLocale) => string
  reason: string
  actorUserId?: string
}): Promise<void> {
  const message: NotifyRenderer = ({ locale }) => params.render(locale)
  await notifyOrderAlertStaffTelegram(params.farmId, message, {
    actorUserId: params.actorUserId,
    reason: params.reason,
    kind: 'order_alert',
  })
  await notifyOrderAlertStaff(params.farmId, message, {
    actorUserId: params.actorUserId,
    reason: params.reason,
    kind: 'order_alert',
  })
}

export async function createPaymentAttemptForOrder(params: {
  farmId: string
  orderId: string
  customerEmail?: string
  phone?: string
}): Promise<
  | { attempt: typeof paymentAttempts.$inferSelect; authorizationUrl: string }
  | { error: string }
> {
  if (!isPaystackConfigured()) {
    return { error: 'Paystack is not configured' }
  }

  const order = await findOrderById(params.farmId, params.orderId)
  if (!order) return { error: 'Order not found' }

  const amountKobo = await sumOrderItemsKobo(params.orderId)
  if (amountKobo <= 0) {
    return { error: 'Order has no payable amount (unpriced or empty)' }
  }

  const reference = makePayReference(params.orderId)
  const ordRef = orderReference(params.orderId)
  const email =
    params.customerEmail?.trim() ||
    (params.phone
      ? `${params.phone.replace(/\D/g, '') || 'customer'}@pay.trovara.farm`
      : `order-${ordRef.toLowerCase()}@pay.trovara.farm`)

  const init = await initializeTransaction({
    email,
    amountKobo,
    reference,
    callbackUrl: `${publicAppUrl()}/pay/callback`,
    metadata: {
      farmId: params.farmId,
      orderId: params.orderId,
      orderReference: ordRef,
      custom_fields: [
        { display_name: 'Order', variable_name: 'order_reference', value: ordRef },
      ],
    },
  })
  if (!init.ok) return { error: init.error }

  const [attempt] = await db
    .insert(paymentAttempts)
    .values({
      farmId: params.farmId,
      orderId: params.orderId,
      provider: 'paystack',
      providerReference: init.data.reference,
      accessCode: init.data.accessCode,
      amountKobo,
      currency: 'NGN',
      status: 'initiated',
      metadata: {
        email,
        phone: params.phone ?? null,
        orderReference: ordRef,
      },
    })
    .returning()

  if (order.paymentStatus === 'not_required' || order.paymentStatus === 'unpaid') {
    await db
      .update(orders)
      .set({ paymentStatus: 'unpaid', updatedAt: new Date() })
      .where(eq(orders.id, params.orderId))
  }

  return { attempt, authorizationUrl: init.data.authorizationUrl }
}

export async function applySuccessfulPayment(params: {
  reference: string
  amountKobo: number
  currency: string
  providerEventId?: string
  raw?: unknown
}): Promise<
  | {
      ok: true
      alreadyApplied: boolean
      orderId: string
      farmId: string
      invoiceId?: string
      receiptId?: string
    }
  | { ok: false; error: string }
> {
  const [attempt] = await db
    .select()
    .from(paymentAttempts)
    .where(eq(paymentAttempts.providerReference, params.reference))
    .limit(1)

  if (!attempt) return { ok: false, error: 'Payment attempt not found' }

  const currency = (params.currency || 'NGN').toUpperCase()
  if (currency !== (attempt.currency || 'NGN').toUpperCase()) {
    return { ok: false, error: 'Currency mismatch' }
  }
  if (Math.round(params.amountKobo) !== attempt.amountKobo) {
    return { ok: false, error: 'Amount mismatch' }
  }

  const order = await findOrderById(attempt.farmId, attempt.orderId)
  if (!order) return { ok: false, error: 'Order not found' }

  // Idempotent: already success → skip mutate but still ensure invoice/receipt once.
  const alreadyApplied = attempt.status === 'success'

  if (!alreadyApplied) {
    const now = new Date()
    await db
      .update(paymentAttempts)
      .set({
        status: 'success',
        paidAt: now,
        providerEventId: params.providerEventId ?? attempt.providerEventId,
        updatedAt: now,
        metadata: {
          ...(attempt.metadata ?? {}),
          ...(params.raw && typeof params.raw === 'object'
            ? { webhook: params.raw as Record<string, unknown> }
            : {}),
        },
      })
      .where(eq(paymentAttempts.id, attempt.id))

    await db
      .update(orders)
      .set({ paymentStatus: 'paid', updatedAt: now })
      .where(eq(orders.id, attempt.orderId))
  } else if (params.providerEventId && !attempt.providerEventId) {
    await db
      .update(paymentAttempts)
      .set({ providerEventId: params.providerEventId, updatedAt: new Date() })
      .where(eq(paymentAttempts.id, attempt.id))
  }

  let invoiceId: string | undefined
  let receiptId: string | undefined

  const [existingInvoice] = await db
    .select()
    .from(invoices)
    .where(and(eq(invoices.farmId, attempt.farmId), eq(invoices.orderId, attempt.orderId)))
    .limit(1)

  const [existingReceipt] = await db
    .select()
    .from(paymentReceipts)
    .where(eq(paymentReceipts.paymentAttemptId, attempt.id))
    .limit(1)

  if (existingInvoice) {
    invoiceId = existingInvoice.id
  }
  if (existingReceipt) {
    receiptId = existingReceipt.id
  }

  if (!existingInvoice || !existingReceipt) {
    const items = await db.select().from(orderItems).where(eq(orderItems.orderId, attempt.orderId))
    const year = new Date().getFullYear()
    const paidAt = attempt.paidAt ?? new Date()

    if (!existingInvoice) {
      const invoiceNumber = await nextInvoiceNumber(attempt.farmId, year)
      const [invoice] = await db
        .insert(invoices)
        .values({
          farmId: attempt.farmId,
          orderId: attempt.orderId,
          invoiceNumber,
          currency: attempt.currency,
          amountKobo: attempt.amountKobo,
          publicToken: publicToken(),
          snapshot: {
            orderReference: orderReference(attempt.orderId),
            customerName: order.customerName,
            customerPhone: order.customerPhone,
            source: order.source,
            paymentReference: attempt.providerReference,
            lines: items.map((i) => ({
              productName: i.productName,
              unit: i.unit,
              quantity: i.quantity,
              unitPriceKobo: i.unitPriceKobo,
              lineTotalKobo: i.lineTotalKobo,
            })),
            amountKobo: attempt.amountKobo,
            currency: attempt.currency,
            paidAt: paidAt.toISOString(),
          },
        })
        .returning()
      invoiceId = invoice.id
    }

    if (!existingReceipt && invoiceId) {
      const receiptNumber = await nextReceiptNumber(attempt.farmId, year)
      const [receipt] = await db
        .insert(paymentReceipts)
        .values({
          farmId: attempt.farmId,
          invoiceId,
          paymentAttemptId: attempt.id,
          receiptNumber,
          amountKobo: attempt.amountKobo,
          paidAt,
          publicToken: publicToken(),
        })
        .returning()
      receiptId = receipt.id
    }
  }

  // Auto-confirm pending orders on first successful payment application.
  if (!alreadyApplied && order.status === 'pending') {
    const actor = await findFarmOwnerActor(attempt.farmId)
    if (actor) {
      await transitionOrder({
        farmId: attempt.farmId,
        orderId: attempt.orderId,
        toStatus: 'confirmed',
        actor,
        skipStaffNotify: true,
      })
    } else {
      await db
        .update(orders)
        .set({ status: 'confirmed', updatedAt: new Date() })
        .where(eq(orders.id, attempt.orderId))
    }
  }

  if (!alreadyApplied) {
    const ref = orderReference(attempt.orderId)
    try {
      const amount = formatNaira(attempt.amountKobo)
      await notifyStaffPaymentMessage({
        farmId: attempt.farmId,
        reason: 'payment_received',
        render: (locale) =>
          renderPaymentReceived(locale, {
            orderRef: ref,
            amount,
            paymentRef: attempt.providerReference,
          }),
      })
    } catch (err) {
      console.error('Payment staff-notify failed:', err instanceof Error ? err.message : err)
    }

    await logAudit({
      farmId: attempt.farmId,
      action: 'payment_succeeded',
      entityType: 'payment_attempt',
      entityId: attempt.id,
      metadata: {
        orderId: attempt.orderId,
        reference: attempt.providerReference,
        amountKobo: attempt.amountKobo,
        currency: attempt.currency,
        invoiceId,
        receiptId,
        via: 'paystack_webhook',
      },
    })
  }

  return {
    ok: true,
    alreadyApplied,
    orderId: attempt.orderId,
    farmId: attempt.farmId,
    invoiceId,
    receiptId,
  }
}

export async function requestCustomerCancel(params: {
  farmId: string
  contactId: string
  orderIdOrRef: string
}): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  const raw = params.orderIdOrRef.trim()
  let order =
    (await findOrderById(params.farmId, raw)) ??
    (await findOrderByReference(params.farmId, raw))

  if (!order || order.customerContactId !== params.contactId) {
    return { ok: false, error: 'Order not found' }
  }

  const ageMs = Date.now() - new Date(order.createdAt).getTime()
  if (ageMs > CANCEL_WINDOW_MS) {
    return {
      ok: false,
      error: 'Cancel window has passed (24 hours). Please contact the farm.',
    }
  }

  if (order.status !== 'pending' && order.status !== 'confirmed') {
    return {
      ok: false,
      error: `Cannot cancel an order that is ${order.status}. Please contact the farm.`,
    }
  }

  const actor = await findFarmOwnerActor(params.farmId)
  if (!actor) {
    return { ok: false, error: 'Unable to cancel right now. Please contact the farm.' }
  }

  const result = await transitionOrder({
    farmId: params.farmId,
    orderId: order.id,
    toStatus: 'cancelled',
    actor,
  })
  if (!result.ok) return { ok: false, error: result.error }

  const now = new Date()
  const paid =
    order.paymentStatus === 'paid' ||
    order.paymentStatus === 'refund_pending' ||
    order.paymentStatus === 'partially_refunded'

  const paymentUpdates: {
    cancelledAt: Date
    cancelledBy: string
    updatedAt: Date
    paymentStatus?: PaymentStatus
    refundRequestedAt?: Date
  } = {
    cancelledAt: now,
    cancelledBy: 'customer',
    updatedAt: now,
  }

  if (paid) {
    paymentUpdates.paymentStatus = 'refund_pending'
    paymentUpdates.refundRequestedAt = now
  }

  await db.update(orders).set(paymentUpdates).where(eq(orders.id, order.id))

  if (!paid) {
    await db
      .update(paymentAttempts)
      .set({ status: 'abandoned', updatedAt: now })
      .where(
        and(
          eq(paymentAttempts.orderId, order.id),
          eq(paymentAttempts.status, 'initiated'),
        ),
      )
  }

  const ref = orderReference(order.id)

  if (paid) {
    try {
      await notifyStaffPaymentMessage({
        farmId: params.farmId,
        reason: 'customer_cancel_refund',
        render: (locale) => renderCustomerCancelRefund(locale, { orderRef: ref }),
      })
    } catch (err) {
      console.error('Cancel refund staff-notify failed:', err instanceof Error ? err.message : err)
    }
    return {
      ok: true,
      message: `Order ${ref} cancelled. If you paid, our team will start the refund — it usually lands within about 1 week.`,
    }
  }

  return { ok: true, message: `Order ${ref} cancelled.` }
}

export async function initiateRefund(params: {
  farmId: string
  orderId: string
  amountKobo: number
  reason: string
  userId: string
}): Promise<
  | { ok: true; refund: typeof paymentRefunds.$inferSelect }
  | { ok: false; error: string }
> {
  if (!isPaystackConfigured()) {
    return { ok: false, error: 'Paystack is not configured' }
  }

  const order = await findOrderById(params.farmId, params.orderId)
  if (!order) return { ok: false, error: 'Order not found' }

  const [attempt] = await db
    .select()
    .from(paymentAttempts)
    .where(
      and(
        eq(paymentAttempts.orderId, params.orderId),
        eq(paymentAttempts.farmId, params.farmId),
        eq(paymentAttempts.status, 'success'),
      ),
    )
    .orderBy(desc(paymentAttempts.paidAt))
    .limit(1)

  if (!attempt) return { ok: false, error: 'No successful payment to refund' }

  const amountKobo = Math.round(params.amountKobo)
  if (!Number.isFinite(amountKobo) || amountKobo <= 0) {
    return { ok: false, error: 'Refund amount must be positive' }
  }
  if (amountKobo > attempt.amountKobo) {
    return { ok: false, error: 'Refund amount exceeds payment' }
  }

  const [prior] = await db
    .select({ total: sql<number>`coalesce(sum(${paymentRefunds.amountKobo}), 0)` })
    .from(paymentRefunds)
    .where(
      and(
        eq(paymentRefunds.paymentAttemptId, attempt.id),
        sql`${paymentRefunds.status} <> 'failed'`,
      ),
    )
  const alreadyRefunded = Number(prior?.total ?? 0)
  if (alreadyRefunded + amountKobo > attempt.amountKobo) {
    return { ok: false, error: 'Refund would exceed remaining paid amount' }
  }

  const ps = await refundTransaction({
    reference: attempt.providerReference,
    amountKobo,
    merchantNote: params.reason.slice(0, 500),
  })
  if (!ps.ok) return { ok: false, error: ps.error }

  const refundStatus =
    ps.data.status === 'processed' || ps.data.status === 'success' ? 'success' : 'pending'

  const [refund] = await db
    .insert(paymentRefunds)
    .values({
      farmId: params.farmId,
      paymentAttemptId: attempt.id,
      orderId: params.orderId,
      amountKobo,
      providerRefundId: ps.data.id != null ? String(ps.data.id) : null,
      status: refundStatus,
      reason: params.reason.slice(0, 2000),
      createdById: params.userId,
    })
    .returning()

  const inFlight = alreadyRefunded + amountKobo
  let nextStatus: PaymentStatus
  if (refundStatus === 'success' && inFlight >= attempt.amountKobo) {
    nextStatus = 'refunded'
  } else if (refundStatus === 'success') {
    nextStatus = 'partially_refunded'
  } else {
    nextStatus = 'refund_pending'
  }

  await db
    .update(orders)
    .set({ paymentStatus: nextStatus, updatedAt: new Date() })
    .where(eq(orders.id, params.orderId))

  return { ok: true, refund }
}
