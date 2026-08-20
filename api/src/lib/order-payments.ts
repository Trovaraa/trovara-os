import { randomBytes } from 'node:crypto'
import { and, count, desc, eq, like, ne, sql } from 'drizzle-orm'
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
import { initializeTransaction, isPaystackConfigured, refundTransaction, safePaystackCheckoutUrl } from './paystack.js'
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

export function webhookPaymentMatchesOrder(params: {
  metadataFarmId: string
  metadataOrderId: string
  orderFarmId: string
  orderId: string
  webhookAmountKobo: number
  orderAmountKobo: number
  currency: string
}): boolean {
  return (
    params.metadataFarmId === params.orderFarmId &&
    params.metadataOrderId === params.orderId &&
    Math.round(params.webhookAmountKobo) === params.orderAmountKobo &&
    params.currency.toUpperCase() === 'NGN'
  )
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

  // Persist our reference before talking to Paystack. A fast webhook can now
  // always resolve the attempt, and a timeout leaves a reconcilable record.
  const [attempt] = await db
    .insert(paymentAttempts)
    .values({
      farmId: params.farmId,
      entityCode: order.entityCode,
      orderId: params.orderId,
      provider: 'paystack',
      providerReference: reference,
      amountKobo,
      currency: 'NGN',
      status: 'initializing',
      metadata: {
        email,
        phone: params.phone ?? null,
        orderReference: ordRef,
      },
    })
    .returning()

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
  if (!init.ok) {
    await db
      .update(paymentAttempts)
      .set({
        status: 'initialization_unknown',
        updatedAt: new Date(),
        metadata: { ...(attempt.metadata ?? {}), initializationError: init.error },
      })
      .where(and(eq(paymentAttempts.id, attempt.id), ne(paymentAttempts.status, 'success')))
    return { error: init.error }
  }
  if (init.data.reference !== reference) {
    await db
      .update(paymentAttempts)
      .set({ status: 'failed', updatedAt: new Date() })
      .where(and(eq(paymentAttempts.id, attempt.id), ne(paymentAttempts.status, 'success')))
    return { error: 'Paystack returned an unexpected payment reference' }
  }

  const [initializedAttempt] = await db
    .update(paymentAttempts)
    .set({ accessCode: init.data.accessCode, status: 'initiated', updatedAt: new Date() })
    .where(and(eq(paymentAttempts.id, attempt.id), ne(paymentAttempts.status, 'success')))
    .returning()

  if (order.paymentStatus === 'not_required' || order.paymentStatus === 'unpaid') {
    await db
      .update(orders)
      .set({ paymentStatus: 'unpaid', updatedAt: new Date() })
      .where(eq(orders.id, params.orderId))
  }

  const authorizationUrl = safePaystackCheckoutUrl(init.data.authorizationUrl, init.data.accessCode)
  if (!authorizationUrl) {
    await db
      .update(paymentAttempts)
      .set({ status: 'failed', updatedAt: new Date() })
      .where(and(eq(paymentAttempts.id, attempt.id), ne(paymentAttempts.status, 'success')))
    return { error: 'Paystack returned an unexpected checkout URL' }
  }

  return {
    attempt: initializedAttempt ?? { ...attempt, accessCode: init.data.accessCode },
    authorizationUrl,
  }
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
  const currency = (params.currency || 'NGN').toUpperCase()
  const [known] = await db
    .select({ id: paymentAttempts.id })
    .from(paymentAttempts)
    .where(eq(paymentAttempts.providerReference, params.reference))
    .limit(1)
  if (!known) {
    // Initialization may have committed at Paystack while our local insert/update
    // failed in an older deployment. A signed webhook can repair that gap, but
    // only when its tenant/order metadata and amount agree with local records.
    const raw = params.raw && typeof params.raw === 'object'
      ? (params.raw as Record<string, unknown>)
      : null
    const metadata =
      raw?.metadata && typeof raw.metadata === 'object'
        ? (raw.metadata as Record<string, unknown>)
        : null
    const farmId = typeof metadata?.farmId === 'string' ? metadata.farmId : ''
    const orderId = typeof metadata?.orderId === 'string' ? metadata.orderId : ''
    const order = farmId && orderId ? await findOrderById(farmId, orderId) : null
    const expectedAmount = order ? await sumOrderItemsKobo(orderId) : 0
    if (
      !order ||
      !webhookPaymentMatchesOrder({
        metadataFarmId: farmId,
        metadataOrderId: orderId,
        orderFarmId: order.farmId,
        orderId: order.id,
        webhookAmountKobo: params.amountKobo,
        orderAmountKobo: expectedAmount,
        currency,
      })
    ) {
      return { ok: false, error: 'Payment attempt not found' }
    }
    await db
      .insert(paymentAttempts)
      .values({
        farmId,
        entityCode: order.entityCode,
        orderId,
        provider: 'paystack',
        providerReference: params.reference,
        amountKobo: expectedAmount,
        currency,
        status: 'initiated',
        providerEventId: params.providerEventId,
        metadata: { reconciledFromWebhook: true, ...metadata },
      })
      .onConflictDoNothing()
  }

  const applied = await db.transaction(async (tx) => {
    // Serialize webhook and manual verification for this provider reference.
    await tx.execute(sql`
      SELECT id FROM payment_attempts
      WHERE provider_reference = ${params.reference}
      FOR UPDATE
    `)
    const [attempt] = await tx
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.providerReference, params.reference))
      .limit(1)
    if (!attempt) return { ok: false as const, error: 'Payment attempt not found' }
    if (currency !== (attempt.currency || 'NGN').toUpperCase()) {
      return { ok: false as const, error: 'Currency mismatch' }
    }
    if (Math.round(params.amountKobo) !== attempt.amountKobo) {
      return { ok: false as const, error: 'Amount mismatch' }
    }

    const [order] = await tx
      .select()
      .from(orders)
      .where(and(eq(orders.id, attempt.orderId), eq(orders.farmId, attempt.farmId)))
      .limit(1)
    if (!order) return { ok: false as const, error: 'Order not found' }

    const now = new Date()
    const [won] = await tx
      .update(paymentAttempts)
      .set({
        status: 'success',
        paidAt: attempt.paidAt ?? now,
        providerEventId: params.providerEventId ?? attempt.providerEventId,
        updatedAt: now,
        metadata: {
          ...(attempt.metadata ?? {}),
          ...(params.raw && typeof params.raw === 'object'
            ? { providerSuccess: params.raw as Record<string, unknown> }
            : {}),
        },
      })
      .where(and(eq(paymentAttempts.id, attempt.id), ne(paymentAttempts.status, 'success')))
      .returning({ id: paymentAttempts.id })
    const alreadyApplied = !won

    if (alreadyApplied && params.providerEventId && !attempt.providerEventId) {
      await tx
        .update(paymentAttempts)
        .set({ providerEventId: params.providerEventId, updatedAt: now })
        .where(eq(paymentAttempts.id, attempt.id))
    }

    await tx
      .update(orders)
      .set({
        paymentStatus: 'paid',
        ...(order.status === 'pending' ? { status: 'confirmed' as const } : {}),
        updatedAt: now,
      })
      .where(and(eq(orders.id, attempt.orderId), eq(orders.farmId, attempt.farmId)))

    // Number allocation and document creation are part of the same commit.
    // The farm lock prevents count-based invoice/receipt sequences colliding.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${attempt.farmId}, 1))`)
    const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, attempt.orderId))
    const year = now.getFullYear()
    const paidAt = attempt.paidAt ?? now

    let [invoice] = await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.farmId, attempt.farmId), eq(invoices.orderId, attempt.orderId)))
      .limit(1)
    if (!invoice) {
      const prefix = `TRV-INV-${year}-`
      const [row] = await tx
        .select({ total: count() })
        .from(invoices)
        .where(and(eq(invoices.farmId, attempt.farmId), like(invoices.invoiceNumber, `${prefix}%`)))
      ;[invoice] = await tx
        .insert(invoices)
        .values({
          farmId: attempt.farmId,
          entityCode: attempt.entityCode,
          orderId: attempt.orderId,
          invoiceNumber: `${prefix}${String(Number(row?.total ?? 0) + 1).padStart(5, '0')}`,
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
        .onConflictDoNothing()
        .returning()
      if (!invoice) {
        ;[invoice] = await tx
          .select()
          .from(invoices)
          .where(and(eq(invoices.farmId, attempt.farmId), eq(invoices.orderId, attempt.orderId)))
          .limit(1)
      }
    }
    if (!invoice) throw new Error('Invoice reconciliation failed')

    let [receipt] = await tx
      .select()
      .from(paymentReceipts)
      .where(eq(paymentReceipts.paymentAttemptId, attempt.id))
      .limit(1)
    if (!receipt) {
      const prefix = `TRV-RCP-${year}-`
      const [row] = await tx
        .select({ total: count() })
        .from(paymentReceipts)
        .where(
          and(eq(paymentReceipts.farmId, attempt.farmId), like(paymentReceipts.receiptNumber, `${prefix}%`)),
        )
      ;[receipt] = await tx
        .insert(paymentReceipts)
        .values({
          farmId: attempt.farmId,
          invoiceId: invoice.id,
          paymentAttemptId: attempt.id,
          receiptNumber: `${prefix}${String(Number(row?.total ?? 0) + 1).padStart(5, '0')}`,
          amountKobo: attempt.amountKobo,
          paidAt,
          publicToken: publicToken(),
        })
        .onConflictDoNothing()
        .returning()
      if (!receipt) {
        ;[receipt] = await tx
          .select()
          .from(paymentReceipts)
          .where(eq(paymentReceipts.paymentAttemptId, attempt.id))
          .limit(1)
      }
    }
    if (!receipt) throw new Error('Receipt reconciliation failed')

    return {
      ok: true as const,
      alreadyApplied,
      attempt,
      invoiceId: invoice.id,
      receiptId: receipt.id,
    }
  })
  if (!applied.ok) return applied

  const { attempt, alreadyApplied, invoiceId, receiptId } = applied

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
  const order =
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
  idempotencyKey: string
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

  const reserved = await db.transaction(async (tx) => {
    // Per-payment serialization makes the remaining-balance check and intent
    // insert one operation. Provider I/O happens only after this commits.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${attempt.id}, 2))`)
    const [replay] = await tx
      .select()
      .from(paymentRefunds)
      .where(
        and(
          eq(paymentRefunds.paymentAttemptId, attempt.id),
          eq(paymentRefunds.idempotencyKey, params.idempotencyKey),
        ),
      )
      .limit(1)
    if (replay) return { ok: true as const, refund: replay, replay: true as const }

    const [prior] = await tx
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
      return { ok: false as const, error: 'Refund would exceed remaining paid amount' }
    }

    const [refund] = await tx
      .insert(paymentRefunds)
      .values({
        farmId: params.farmId,
        entityCode: attempt.entityCode,
        paymentAttemptId: attempt.id,
        orderId: params.orderId,
        amountKobo,
        idempotencyKey: params.idempotencyKey,
        status: 'submitting',
        reason: params.reason.slice(0, 2000),
        createdById: params.userId,
      })
      .returning()
    return { ok: true as const, refund, replay: false as const, alreadyRefunded }
  })
  if (!reserved.ok) return reserved
  if (reserved.replay) return { ok: true, refund: reserved.refund }

  const ps = await refundTransaction({
    reference: attempt.providerReference,
    amountKobo,
    merchantNote: `[${reserved.refund.id}] ${params.reason}`.slice(0, 500),
  })
  if (!ps.ok) {
    // A timeout/network failure is an unknown outcome, not a failed refund.
    // Keep the amount reserved and reconcile from a later provider webhook.
    const [unknown] = await db
      .update(paymentRefunds)
      .set({ status: 'unknown', lastError: ps.error.slice(0, 2000), updatedAt: new Date() })
      .where(eq(paymentRefunds.id, reserved.refund.id))
      .returning()
    return { ok: false, error: `${ps.error}; refund status is being reconciled (${unknown?.id})` }
  }

  const refundStatus =
    ps.data.status === 'processed' || ps.data.status === 'success' ? 'success' : 'pending'

  const [refund] = await db
    .update(paymentRefunds)
    .set({
      providerRefundId: ps.data.id != null ? String(ps.data.id) : null,
      status: refundStatus,
      lastError: null,
      updatedAt: new Date(),
    })
    .where(eq(paymentRefunds.id, reserved.refund.id))
    .returning()

  const [totals] = await db
    .select({
      successful: sql<number>`coalesce(sum(${paymentRefunds.amountKobo}) filter (where ${paymentRefunds.status} = 'success'), 0)`,
      active: sql<number>`coalesce(sum(${paymentRefunds.amountKobo}) filter (where ${paymentRefunds.status} not in ('failed', 'success')), 0)`,
    })
    .from(paymentRefunds)
    .where(eq(paymentRefunds.paymentAttemptId, attempt.id))
  const successful = Number(totals?.successful ?? 0)
  const active = Number(totals?.active ?? 0)
  const nextStatus: PaymentStatus =
    successful >= attempt.amountKobo
      ? 'refunded'
      : active > 0
        ? 'refund_pending'
        : successful > 0
          ? 'partially_refunded'
          : 'paid'

  await db
    .update(orders)
    .set({ paymentStatus: nextStatus, updatedAt: new Date() })
    .where(eq(orders.id, params.orderId))

  return { ok: true, refund }
}

/** Reconcile a Paystack refund webhook with an intent, including timed-out calls. */
export async function reconcileRefund(params: {
  providerRefundId: string
  transactionReference: string
  amountKobo: number
  providerStatus: string
}): Promise<{ ok: true; refundId: string } | { ok: false; error: string }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      SELECT id FROM payment_attempts
      WHERE provider_reference = ${params.transactionReference}
      FOR UPDATE
    `)
    const [attempt] = await tx
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.providerReference, params.transactionReference))
      .limit(1)
    if (!attempt) return { ok: false as const, error: 'Payment attempt not found' }

    let [refund] = await tx
      .select()
      .from(paymentRefunds)
      .where(eq(paymentRefunds.providerRefundId, params.providerRefundId))
      .limit(1)
    if (!refund) {
      ;[refund] = await tx
        .select()
        .from(paymentRefunds)
        .where(
          and(
            eq(paymentRefunds.paymentAttemptId, attempt.id),
            eq(paymentRefunds.amountKobo, Math.round(params.amountKobo)),
            sql`${paymentRefunds.status} IN ('submitting', 'unknown', 'pending')`,
          ),
        )
        .orderBy(paymentRefunds.createdAt)
        .limit(1)
    }
    if (!refund) return { ok: false as const, error: 'Refund intent not found' }

    const status =
      params.providerStatus === 'processed' || params.providerStatus === 'success'
        ? 'success'
        : params.providerStatus === 'failed'
          ? 'failed'
          : 'pending'
    await tx
      .update(paymentRefunds)
      .set({ providerRefundId: params.providerRefundId, status, updatedAt: new Date() })
      .where(eq(paymentRefunds.id, refund.id))

    const [totals] = await tx
      .select({
        successful: sql<number>`coalesce(sum(${paymentRefunds.amountKobo}) filter (where ${paymentRefunds.status} = 'success'), 0)`,
        active: sql<number>`coalesce(sum(${paymentRefunds.amountKobo}) filter (where ${paymentRefunds.status} not in ('failed', 'success')), 0)`,
      })
      .from(paymentRefunds)
      .where(eq(paymentRefunds.paymentAttemptId, attempt.id))
    const successful = Number(totals?.successful ?? 0)
    const active = Number(totals?.active ?? 0)
    const paymentStatus: PaymentStatus =
      successful >= attempt.amountKobo
        ? 'refunded'
        : active > 0
          ? 'refund_pending'
          : successful > 0
            ? 'partially_refunded'
            : 'paid'
    await tx
      .update(orders)
      .set({ paymentStatus, updatedAt: new Date() })
      .where(and(eq(orders.id, attempt.orderId), eq(orders.farmId, attempt.farmId)))
    return { ok: true as const, refundId: refund.id }
  })
}
