import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import {
  customerContacts,
  customerInquiries,
  harvestLots,
  invoices,
  orderItems,
  orders,
  paymentAttempts,
  paymentRefunds,
  products,
  users,
} from '../db/schema.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { canAssignTasks, canManageOrders } from '../lib/rbac.js'
import { logAudit } from '../lib/audit.js'
import type { OrderStatus } from '../lib/state-machines.js'
import { orderReference } from '../lib/customer-cart.js'
import {
  redactContactForRole,
  redactOrderForRole,
  shouldRedactSalesPii,
} from '../lib/sales-redaction.js'
import { createHarvestLotForOrder } from '../lib/harvest-lots.js'
import { transitionOrder } from '../lib/order-fulfillment.js'
import {
  applySuccessfulPayment,
  createPaymentAttemptForOrder,
  initiateRefund,
} from '../lib/order-payments.js'
import {
  authorizationUrlFromAccessCode,
  isPaystackConfigured,
  verifyTransaction,
} from '../lib/paystack.js'
import { renderInvoiceHtml, type InvoiceSnapshot } from '../lib/invoice-html.js'
import { renderInvoicePdf } from '../lib/invoice-pdf.js'
import {
  authorLocaleForUserId,
  authorLocaleHint,
  toCanonicalEnglish,
  toViewerLocaleMany,
} from '../lib/content-locale.js'
import { resolveStaffReplyLocale } from '../lib/reply-locale.js'

const createOrderSchema = z.object({
  customerName: z.string().min(1).max(200),
  customerPhone: z.string().max(30).optional(),
  totalAmount: z.number().int().min(0),
  currency: z.string().max(10).optional(),
  lotId: z.string().uuid().optional(),
  notes: z.string().max(2000).optional(),
})

const updateOrderSchema = z.object({
  customerName: z.string().min(1).max(200).optional(),
  customerPhone: z.string().max(30).optional(),
  totalAmount: z.number().int().min(0).optional(),
  currency: z.string().max(10).optional(),
  lotId: z.string().uuid().nullable().optional(),
  notes: z.string().max(2000).optional(),
  status: z.enum(['pending', 'confirmed', 'dispatched', 'delivered', 'cancelled']).optional(),
})

const refundSchema = z.object({
  amountKobo: z.number().int().positive().optional(),
  reason: z.string().min(1).max(2000),
})

/**
 * Order prose, and the only columns on an order that ever reach a translator.
 *
 * Everything else is identity, money, an enum or an identifier: `customerName`
 * and `customerPhone`, `totalAmount` / `currency` / every kobo figure, the
 * fulfilment and payment status enums, `cancelledBy` (the 'customer' sentinel),
 * `lotCode`, the `TRV-ORD-…` reference and the Paystack references. Line items
 * keep their catalogue `productName` and unit verbatim.
 */
const ORDER_TEXT_FIELDS = ['notes', 'customerFeedback'] as const
type OrderTextField = (typeof ORDER_TEXT_FIELDS)[number]

/** The two columns that say where an order — and so its `notes` — came from. */
type OrderOrigin = {
  source?: string | null
  customerContactId?: string | null
}

/**
 * True when `orders.notes` holds staff prose on this row.
 *
 * A bot checkout writes `Delivery: <address>` into the same column, and
 * `lib/customer-orders.ts` parses that exact string back out to pre-fill the
 * buyer's next order. On a customer order the column is therefore a
 * machine-read address the customer typed and is shown again as their saved
 * details — translating it in either direction would corrupt a delivery
 * address — so only staff-entered orders treat it as prose.
 */
function notesAreStaffProse(order: OrderOrigin): boolean {
  return (order.source ?? 'staff') === 'staff' && !order.customerContactId
}

/**
 * The prose fields of one order row.
 *
 * `customerFeedback` is the buyer's review of a delivered order. It is staff-only
 * (the bot thanks the customer, it never quotes the review back), and the retry
 * job canonicalizes it alongside `notes`, so it is rendered for the viewer on
 * every row.
 */
function orderProseFields(order: OrderOrigin): readonly string[] {
  return notesAreStaffProse(order) ? ORDER_TEXT_FIELDS : ['customerFeedback']
}

/**
 * The viewer's language. A failed lookup degrades to English rather than
 * failing the request it only decorates.
 */
async function preferredLocaleForUser(userId: string): Promise<string | null> {
  try {
    const [row] = await db
      .select({ preferredLocale: users.preferredLocale })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
    return row?.preferredLocale ?? null
  } catch {
    return null
  }
}

/**
 * Render order prose in the viewer's language with ONE batched translation call
 * per response: every string across every row is collected first, translated
 * together (the service deduplicates and reads its cache in a single query),
 * then mapped back by position. An English viewer short-circuits before any of
 * this work.
 *
 * The fields are chosen per row rather than once per response, because whether
 * `notes` is prose depends on where that order came from.
 */
async function localizeRows<T extends object>(
  rows: T[],
  fieldsFor: (row: T) => readonly string[],
  farmId: string,
  targetLocale: string | null,
): Promise<T[]> {
  if (resolveStaffReplyLocale(targetLocale) === 'en') return rows
  if (rows.length === 0) return rows

  const perRow = rows.map((row) => fieldsFor(row))
  const texts: string[] = []
  rows.forEach((row, index) => {
    for (const field of perRow[index]) {
      const value = (row as Record<string, unknown>)[field]
      if (typeof value === 'string' && value !== '') texts.push(value)
    }
  })
  if (texts.length === 0) return rows

  const translated = await toViewerLocaleMany({ texts, targetLocale, farmId })

  let cursor = 0
  return rows.map((row, index) => {
    const out = { ...row } as Record<string, unknown>
    for (const field of perRow[index]) {
      const value = (row as Record<string, unknown>)[field]
      if (typeof value === 'string' && value !== '') out[field] = translated[cursor++]
    }
    return out as T
  })
}

/**
 * One order rendered for the staff member reading it. Text this author just
 * wrote is echoed in their own words with no round trip; the rest of the row is
 * canonical English rendered for the viewer.
 */
async function orderForViewer<T extends OrderOrigin>(
  order: T,
  farmId: string,
  targetLocale: string | null,
  echo: Partial<Record<OrderTextField, string>> = {},
): Promise<T> {
  const [localized] = await localizeRows(
    [order],
    (row) => orderProseFields(row).filter((field) => !(field in echo)),
    farmId,
    targetLocale,
  )
  return { ...localized, ...echo }
}

type CanonicalProse = {
  /** English text to store; absent when there was nothing to normalize. */
  english?: string
  sourceLocale: string | null
  translationStatus: 'done' | 'pending'
}

/**
 * Normalize one prose column to English for storage.
 *
 * A translation failure stores the author's own words at 'pending' so the write
 * — an order, or a refund that has already moved money — can never fail on a
 * translator, and `lib/translation-retry.ts` repairs the row later.
 *
 * `source_locale` stays null on that path rather than falling back to 'en': it is
 * the hint the retry job feeds back into `toCanonicalEnglish`, and an 'en' hint
 * short-circuits there, which would mark the row 'done' still holding French.
 */
async function canonicalProse(
  text: string | null | undefined,
  farmId: string,
  authorLocale: string | null,
): Promise<CanonicalProse> {
  if (typeof text !== 'string' || text.trim() === '') {
    return { sourceLocale: null, translationStatus: 'done' }
  }
  try {
    const result = await toCanonicalEnglish({ text, farmId, sourceLocale: authorLocale })
    return {
      english: result.english,
      sourceLocale: result.sourceLocale,
      translationStatus: result.status,
    }
  } catch {
    return { english: text, sourceLocale: authorLocale, translationStatus: 'pending' }
  }
}

const orderListSelect = {
  id: orders.id,
  customerName: orders.customerName,
  customerPhone: orders.customerPhone,
  status: orders.status,
  paymentStatus: orders.paymentStatus,
  totalAmount: orders.totalAmount,
  currency: orders.currency,
  lotId: orders.lotId,
  lotCode: harvestLots.lotCode,
  source: orders.source,
  customerContactId: orders.customerContactId,
  notes: orders.notes,
  dispatchedAt: orders.dispatchedAt,
  deliveryPhotoUrl: orders.deliveryPhotoUrl,
  customerFeedback: orders.customerFeedback,
  customerFeedbackAt: orders.customerFeedbackAt,
  cancelledBy: orders.cancelledBy,
  refundRequestedAt: orders.refundRequestedAt,
  createdAt: orders.createdAt,
  updatedAt: orders.updatedAt,
}

export const salesRoutes = new Hono<{ Variables: AppVariables }>()

salesRoutes.use('*', authMiddleware)

salesRoutes.get('/', async (c) => {
  const user = c.get('user')

  const rows = await db
    .select({
      ...orderListSelect,
      invoiceId: invoices.id,
    })
    .from(orders)
    .leftJoin(harvestLots, eq(orders.lotId, harvestLots.id))
    .leftJoin(invoices, eq(invoices.orderId, orders.id))
    .where(eq(orders.farmId, user.farmId))
    .orderBy(desc(orders.updatedAt))

  // Attach line items (for bot orders; staff orders usually have none).
  // Prefer live catalogue name when productId still links — renames show immediately.
  const orderIds = rows.map((r) => r.id)
  const itemsByOrder: Record<string, unknown[]> = {}
  if (orderIds.length) {
    const itemRows = await db
      .select({
        orderId: orderItems.orderId,
        productName: sql<string>`coalesce(${products.name}, ${orderItems.productName})`,
        unit: orderItems.unit,
        quantity: orderItems.quantity,
        unitPriceKobo: orderItems.unitPriceKobo,
        lineTotalKobo: orderItems.lineTotalKobo,
      })
      .from(orderItems)
      .leftJoin(products, eq(orderItems.productId, products.id))
      .where(inArray(orderItems.orderId, orderIds))
    for (const it of itemRows) {
      ;(itemsByOrder[it.orderId] ??= []).push(it)
    }
  }

  const result = rows.map((r) => {
    const { invoiceId, ...rest } = r
    return redactOrderForRole(
      {
        ...rest,
        hasInvoice: Boolean(invoiceId),
        reference: orderReference(r.id),
        items: itemsByOrder[r.id] ?? [],
      },
      user,
    )
  })

  // Redaction runs before localization, so text this viewer may not see is
  // never handed to a translator.
  const viewerLocale = await preferredLocaleForUser(user.id)
  const localized = await localizeRows(result, orderProseFields, user.farmId, viewerLocale)

  return c.json({ orders: localized })
})

// Customer profile: identity (channel + handle) plus their full order history and
// inquiry count for this farm. Powers the Sales drill-down for bot customers.
salesRoutes.get('/contacts/:id', async (c) => {
  const user = c.get('user')
  if (shouldRedactSalesPii(user)) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  const contactId = c.req.param('id')

  const [contact] = await db
    .select()
    .from(customerContacts)
    .where(and(eq(customerContacts.id, contactId), eq(customerContacts.farmId, user.farmId)))
    .limit(1)

  if (!contact) return c.json({ error: 'Not found' }, 404)

  const orderRows = await db
    .select({
      id: orders.id,
      customerName: orders.customerName,
      customerPhone: orders.customerPhone,
      status: orders.status,
      paymentStatus: orders.paymentStatus,
      totalAmount: orders.totalAmount,
      currency: orders.currency,
      source: orders.source,
      notes: orders.notes,
      cancelledBy: orders.cancelledBy,
      refundRequestedAt: orders.refundRequestedAt,
      createdAt: orders.createdAt,
    })
    .from(orders)
    .where(and(eq(orders.farmId, user.farmId), eq(orders.customerContactId, contactId)))
    .orderBy(desc(orders.createdAt))

  const orderIds = orderRows.map((o) => o.id)
  const itemsByOrder: Record<string, unknown[]> = {}
  if (orderIds.length) {
    const itemRows = await db
      .select({
        orderId: orderItems.orderId,
        productName: sql<string>`coalesce(${products.name}, ${orderItems.productName})`,
        unit: orderItems.unit,
        quantity: orderItems.quantity,
        unitPriceKobo: orderItems.unitPriceKobo,
        lineTotalKobo: orderItems.lineTotalKobo,
      })
      .from(orderItems)
      .leftJoin(products, eq(orderItems.productId, products.id))
      .where(inArray(orderItems.orderId, orderIds))
    for (const it of itemRows) {
      ;(itemsByOrder[it.orderId] ??= []).push(it)
    }
  }

  const [{ count: inquiryCount } = { count: 0 }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(customerInquiries)
    .where(
      and(eq(customerInquiries.farmId, user.farmId), eq(customerInquiries.contactId, contactId)),
    )

  // Lifetime value counts only orders that reached delivered (money in the door).
  const lifetimeValue = orderRows
    .filter((o) => o.status === 'delivered')
    .reduce((sum, o) => sum + (o.totalAmount ?? 0), 0)

  const shaped = orderRows.map((o) =>
    redactOrderForRole(
      {
        ...o,
        reference: orderReference(o.id),
        items: itemsByOrder[o.id] ?? [],
      },
      user,
    ),
  )

  // Every order here reached the farm through the bot, so its `notes` is the
  // customer's own delivery address and stays verbatim; the contact's name and
  // phone are identity. In practice that leaves nothing to translate and the
  // batch never runs, but the same rule decides it as everywhere else.
  const viewerLocale = await preferredLocaleForUser(user.id)
  const localized = await localizeRows(shaped, orderProseFields, user.farmId, viewerLocale)

  return c.json({
    contact: redactContactForRole(
      {
        id: contact.id,
        channel: contact.channel,
        externalId: contact.externalId,
        name: contact.name,
        phone: contact.phone,
        firstSeen: contact.createdAt,
        lastSeen: contact.updatedAt,
      },
      user,
    ),
    stats: {
      orderCount: orderRows.length,
      inquiryCount,
      lifetimeValue,
      currency: orderRows[0]?.currency ?? 'NGN',
    },
    orders: localized,
  })
})

salesRoutes.post('/', zValidator('json', createOrderSchema), async (c) => {
  const user = c.get('user')
  if (!canManageOrders(user)) return c.json({ error: 'Forbidden' }, 403)

  const body = c.req.valid('json')

  if (body.lotId) {
    const [lot] = await db
      .select()
      .from(harvestLots)
      .where(and(eq(harvestLots.id, body.lotId), eq(harvestLots.farmId, user.farmId)))
      .limit(1)
    if (!lot) return c.json({ error: 'Invalid harvest lot' }, 400)
  }

  // A staff order's notes are the author's own prose, so the row stores the
  // English. The customer's name, phone and the amount are never translated.
  const canonical = await canonicalProse(
    body.notes,
    user.farmId,
    await authorLocaleForUserId(user.id),
  )
  const notes = canonical.english ?? body.notes ?? null

  const [order] = await db
    .insert(orders)
    .values({
      farmId: user.farmId,
      customerName: body.customerName,
      customerPhone: body.customerPhone,
      totalAmount: body.totalAmount,
      currency: body.currency,
      lotId: body.lotId,
      notes,
      sourceLocale: canonical.sourceLocale,
      translationStatus: canonical.translationStatus,
      status: 'pending',
      source: 'staff',
    })
    .returning()

  let lot = null
  if (!body.lotId) {
    try {
      lot = await createHarvestLotForOrder({
        farmId: user.farmId,
        orderId: order.id,
        reportedById: user.id,
        lines: [
          {
            // `harvest_lots.product_name` is a label column the retry job never
            // sweeps, so the derived lot takes the canonical English the order
            // row just stored: text left here in another language is text
            // nothing would ever come back and fix.
            productName: notes?.trim() || 'Staff order',
            unit: 'kg',
            quantity: 1,
          },
        ],
      })
    } catch (err) {
      console.error('Auto harvest lot (staff order) failed:', err instanceof Error ? err.message : err)
    }
  }

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'create',
    entityType: 'order',
    entityId: order.id,
    metadata: lot ? { lotCode: lot.lotCode } : undefined,
  })

  const [fresh] = await db.select().from(orders).where(eq(orders.id, order.id)).limit(1)
  const stored = fresh ?? order
  // The author reads back their own words; the row holds the English.
  return c.json({ order: { ...stored, notes: body.notes ?? stored.notes }, lot }, 201)
})

salesRoutes.post('/:id/resend-pay-link', async (c) => {
  const user = c.get('user')
  if (!canManageOrders(user)) return c.json({ error: 'Forbidden' }, 403)

  const orderId = c.req.param('id')
  const [existing] = await db
    .select()
    .from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.farmId, user.farmId)))
    .limit(1)

  if (!existing) return c.json({ error: 'Not found' }, 404)

  if (!isPaystackConfigured()) {
    return c.json({ error: 'Paystack is not configured' }, 501)
  }

  const [initiated] = await db
    .select()
    .from(paymentAttempts)
    .where(
      and(
        eq(paymentAttempts.orderId, orderId),
        eq(paymentAttempts.farmId, user.farmId),
        eq(paymentAttempts.status, 'initiated'),
      ),
    )
    .orderBy(desc(paymentAttempts.createdAt))
    .limit(1)

  if (initiated?.accessCode) {
    const authorizationUrl = authorizationUrlFromAccessCode(initiated.accessCode)
    await logAudit({
      farmId: user.farmId,
      userId: user.id,
      action: 'update',
      entityType: 'order',
      entityId: orderId,
      metadata: { action: 'resend_pay_link', reused: true, reference: initiated.providerReference },
    })
    return c.json({
      authorizationUrl,
      reference: initiated.providerReference,
      reused: true,
    })
  }

  const created = await createPaymentAttemptForOrder({
    farmId: user.farmId,
    orderId,
    phone: existing.customerPhone ?? undefined,
  })
  if ('error' in created) return c.json({ error: created.error }, 400)

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'update',
    entityType: 'order',
    entityId: orderId,
    metadata: {
      action: 'resend_pay_link',
      reused: false,
      reference: created.attempt.providerReference,
    },
  })

  return c.json({
    authorizationUrl: created.authorizationUrl,
    reference: created.attempt.providerReference,
    reused: false,
  })
})

salesRoutes.post('/:id/verify-payment', async (c) => {
  const user = c.get('user')
  if (!canManageOrders(user)) return c.json({ error: 'Forbidden' }, 403)

  const orderId = c.req.param('id')
  const [existing] = await db
    .select()
    .from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.farmId, user.farmId)))
    .limit(1)

  if (!existing) return c.json({ error: 'Not found' }, 404)

  if (!isPaystackConfigured()) {
    return c.json({ error: 'Paystack is not configured' }, 501)
  }

  const [attempt] = await db
    .select()
    .from(paymentAttempts)
    .where(and(eq(paymentAttempts.orderId, orderId), eq(paymentAttempts.farmId, user.farmId)))
    .orderBy(desc(paymentAttempts.createdAt))
    .limit(1)

  if (!attempt) return c.json({ error: 'No payment attempt found for this order' }, 404)

  const verified = await verifyTransaction(attempt.providerReference)
  if (!verified.ok) return c.json({ error: verified.error }, 400)

  if (verified.data.status !== 'success') {
    return c.json(
      {
        ok: false,
        error: `Payment not successful (${verified.data.status})`,
        providerStatus: verified.data.status,
        gatewayResponse: verified.data.gatewayResponse,
      },
      400,
    )
  }

  const applied = await applySuccessfulPayment({
    reference: verified.data.reference,
    amountKobo: Math.round(verified.data.amount),
    currency: verified.data.currency,
    raw: verified.data.raw,
  })
  if (!applied.ok) return c.json({ error: applied.error }, 400)

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'update',
    entityType: 'order',
    entityId: orderId,
    metadata: {
      action: 'verify_payment',
      reference: verified.data.reference,
      alreadyApplied: applied.alreadyApplied,
    },
  })

  const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1)
  const viewerLocale = await preferredLocaleForUser(user.id)
  return c.json({
    ok: true,
    alreadyApplied: applied.alreadyApplied,
    order: order ? await orderForViewer(order, user.farmId, viewerLocale) : order,
    invoiceId: applied.invoiceId,
    receiptId: applied.receiptId,
  })
})

salesRoutes.post('/:id/refund', zValidator('json', refundSchema), async (c) => {
  const user = c.get('user')
  if (!canManageOrders(user)) return c.json({ error: 'Forbidden' }, 403)

  const orderId = c.req.param('id')
  const body = c.req.valid('json')

  const [existing] = await db
    .select()
    .from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.farmId, user.farmId)))
    .limit(1)

  if (!existing) return c.json({ error: 'Not found' }, 404)

  let amountKobo = body.amountKobo
  if (amountKobo == null) {
    const [attempt] = await db
      .select()
      .from(paymentAttempts)
      .where(
        and(
          eq(paymentAttempts.orderId, orderId),
          eq(paymentAttempts.farmId, user.farmId),
          eq(paymentAttempts.status, 'success'),
        ),
      )
      .orderBy(desc(paymentAttempts.paidAt))
      .limit(1)

    if (!attempt) return c.json({ error: 'No successful payment to refund' }, 400)

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
    amountKobo = attempt.amountKobo - alreadyRefunded
    if (amountKobo <= 0) {
      return c.json({ error: 'Nothing left to refund' }, 400)
    }
  }

  // The refund reason is staff prose, normalized before the money moves because
  // `initiateRefund` both sends it to Paystack as the merchant note and stores
  // it on the refund row: the English is the record of truth on both sides. The
  // amount and every reference stay exactly as they are.
  const viewerLocale = await preferredLocaleForUser(user.id)
  const authorLocale = authorLocaleHint(viewerLocale)
  const canonical = await canonicalProse(body.reason, user.farmId, authorLocale)

  const result = await initiateRefund({
    farmId: user.farmId,
    orderId,
    amountKobo,
    reason: canonical.english ?? body.reason,
    userId: user.id,
  })
  if (!result.ok) return c.json({ error: result.error }, 400)

  // `initiateRefund` inserts on the schema defaults ('done', no locale), so a
  // row holding anything else says so here. The patch is best-effort on purpose:
  // the money has already moved, and failing this response would invite a retry
  // that refunds again.
  if (
    canonical.translationStatus === 'pending' ||
    (canonical.sourceLocale != null && canonical.sourceLocale !== 'en')
  ) {
    try {
      await db
        .update(paymentRefunds)
        .set({
          sourceLocale: canonical.sourceLocale,
          translationStatus: canonical.translationStatus,
        })
        .where(eq(paymentRefunds.id, result.refund.id))
    } catch (err) {
      console.error(
        'Refund locale metadata write failed:',
        err instanceof Error ? err.message : err,
      )
    }
  }

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'update',
    entityType: 'order',
    entityId: orderId,
    metadata: {
      action: 'refund',
      amountKobo,
      refundId: result.refund.id,
      status: result.refund.status,
    },
  })

  const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1)
  return c.json({
    ok: true,
    // The author reads their own reason back; the row holds the English.
    refund: { ...result.refund, reason: body.reason },
    order: order ? await orderForViewer(order, user.farmId, viewerLocale) : order,
  })
})

/**
 * The invoice is an immutable financial artifact: its snapshot holds the
 * customer's name, the line items and the amounts as they stood when it was
 * issued, and the same document is served to staff and to the customer. Nothing
 * in it is translated, in either direction.
 */
async function loadFarmInvoice(farmId: string, orderId: string) {
  const [row] = await db
    .select({
      invoiceNumber: invoices.invoiceNumber,
      amountKobo: invoices.amountKobo,
      currency: invoices.currency,
      createdAt: invoices.createdAt,
      snapshot: invoices.snapshot,
      publicToken: invoices.publicToken,
      orderId: invoices.orderId,
    })
    .from(invoices)
    .innerJoin(orders, eq(invoices.orderId, orders.id))
    .where(and(eq(invoices.orderId, orderId), eq(orders.farmId, farmId)))
    .limit(1)
  return row ?? null
}

salesRoutes.get('/:id/invoice', async (c) => {
  const user = c.get('user')
  if (!canManageOrders(user)) return c.json({ error: 'Forbidden' }, 403)

  const row = await loadFarmInvoice(user.farmId, c.req.param('id'))
  if (!row) return c.json({ error: 'Invoice not found' }, 404)

  const html = renderInvoiceHtml({
    invoiceNumber: row.invoiceNumber,
    amountKobo: row.amountKobo,
    currency: row.currency,
    createdAt: row.createdAt,
    snapshot: (row.snapshot ?? {}) as InvoiceSnapshot,
    autoPrint: c.req.query('autoprint') === '1',
  })

  c.header('Content-Type', 'text/html; charset=utf-8')
  c.header('Content-Disposition', `inline; filename="${row.invoiceNumber}.html"`)
  return c.body(html)
})

salesRoutes.get('/:id/invoice/pdf', async (c) => {
  const user = c.get('user')
  if (!canManageOrders(user)) return c.json({ error: 'Forbidden' }, 403)

  const row = await loadFarmInvoice(user.farmId, c.req.param('id'))
  if (!row) return c.json({ error: 'Invoice not found' }, 404)

  const pdf = await renderInvoicePdf({
    invoiceNumber: row.invoiceNumber,
    amountKobo: row.amountKobo,
    currency: row.currency,
    createdAt: row.createdAt,
    snapshot: (row.snapshot ?? {}) as InvoiceSnapshot,
  })

  c.header('Content-Type', 'application/pdf')
  c.header('Content-Disposition', `attachment; filename="${row.invoiceNumber}.pdf"`)
  return c.body(new Uint8Array(pdf))
})

salesRoutes.patch('/:id', zValidator('json', updateOrderSchema), async (c) => {
  const user = c.get('user')
  if (!canManageOrders(user)) return c.json({ error: 'Forbidden' }, 403)

  const orderId = c.req.param('id')
  const body = c.req.valid('json')

  const [existing] = await db
    .select()
    .from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.farmId, user.farmId)))
    .limit(1)

  if (!existing) return c.json({ error: 'Not found' }, 404)

  // One lookup serves all three needs: the hint the author's text is normalized
  // with, the language the response is rendered in, and the actor locale the
  // status transition notifies staff in.
  const viewerLocale = await preferredLocaleForUser(user.id)
  const authorLocale = authorLocaleHint(viewerLocale)

  const updates: Partial<typeof existing> = { updatedAt: new Date() }
  const echo: Partial<Record<OrderTextField, string>> = {}

  if (body.customerName !== undefined) updates.customerName = body.customerName
  if (body.customerPhone !== undefined) updates.customerPhone = body.customerPhone
  if (body.totalAmount !== undefined) updates.totalAmount = body.totalAmount
  if (body.currency !== undefined) updates.currency = body.currency

  if (body.notes !== undefined) {
    if (notesAreStaffProse(existing)) {
      const canonical = await canonicalProse(body.notes, user.farmId, authorLocale)
      updates.notes = canonical.english ?? body.notes
      if (canonical.english !== undefined) {
        // Never downgrade a row the retry job still owes work on, and keep it
        // labelled with the locale of the text that failed: `source_locale` is
        // the hint that retry uses.
        if (existing.translationStatus === 'done' || canonical.translationStatus === 'pending') {
          updates.sourceLocale = canonical.sourceLocale ?? existing.sourceLocale
        }
        if (canonical.translationStatus === 'pending') updates.translationStatus = 'pending'
      }
      echo.notes = body.notes
    } else {
      // Verbatim: on a bot order this column is the customer's delivery address,
      // parsed back out by the checkout and shown to them as their saved
      // details. The locale columns are left alone for the same reason.
      updates.notes = body.notes
    }
  }

  if (body.lotId !== undefined) {
    if (body.lotId === null) {
      updates.lotId = null
    } else {
      const [lot] = await db
        .select()
        .from(harvestLots)
        .where(and(eq(harvestLots.id, body.lotId), eq(harvestLots.farmId, user.farmId)))
        .limit(1)
      if (!lot) return c.json({ error: 'Invalid harvest lot' }, 400)
      updates.lotId = body.lotId
    }
  }

  const hasFieldUpdates = Object.keys(updates).length > 1 // more than updatedAt
  if (hasFieldUpdates) {
    await db.update(orders).set(updates).where(eq(orders.id, orderId))
  }

  if (body.status && body.status !== existing.status) {
    if (
      (body.status === 'dispatched' || body.status === 'delivered') &&
      existing.paymentStatus === 'unpaid'
    ) {
      return c.json({ error: 'Cannot dispatch or deliver an unpaid order' }, 400)
    }

    const result = await transitionOrder({
      farmId: user.farmId,
      orderId,
      toStatus: body.status as OrderStatus,
      actor: {
        id: user.id,
        farmId: user.farmId,
        role: user.role,
        preferredLocale: viewerLocale,
      },
    })
    if (!result.ok) return c.json({ error: result.error }, 400)
    return c.json({
      order: await orderForViewer(result.order, user.farmId, viewerLocale, echo),
    })
  }

  const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1)

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'update',
    entityType: 'order',
    entityId: orderId,
    metadata: { status: order?.status },
  })

  return c.json({
    order: order ? await orderForViewer(order, user.farmId, viewerLocale, echo) : order,
  })
})

salesRoutes.delete('/:id', async (c) => {
  const user = c.get('user')
  if (!canAssignTasks(user)) return c.json({ error: 'Forbidden' }, 403)

  const orderId = c.req.param('id')

  const [existing] = await db
    .select()
    .from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.farmId, user.farmId)))
    .limit(1)

  if (!existing) return c.json({ error: 'Not found' }, 404)

  await db.delete(orders).where(eq(orders.id, orderId))

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'delete',
    entityType: 'order',
    entityId: orderId,
  })

  return c.json({ ok: true })
})
