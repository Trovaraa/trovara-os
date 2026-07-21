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

  return c.json({ orders: result })
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
    orders: orderRows.map((o) =>
      redactOrderForRole(
        {
          ...o,
          reference: orderReference(o.id),
          items: itemsByOrder[o.id] ?? [],
        },
        user,
      ),
    ),
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

  const [order] = await db
    .insert(orders)
    .values({
      farmId: user.farmId,
      customerName: body.customerName,
      customerPhone: body.customerPhone,
      totalAmount: body.totalAmount,
      currency: body.currency,
      lotId: body.lotId,
      notes: body.notes,
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
            productName: body.notes?.trim() || 'Staff order',
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
  return c.json({ order: fresh ?? order, lot }, 201)
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
  return c.json({
    ok: true,
    alreadyApplied: applied.alreadyApplied,
    order,
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

  const result = await initiateRefund({
    farmId: user.farmId,
    orderId,
    amountKobo,
    reason: body.reason,
    userId: user.id,
  })
  if (!result.ok) return c.json({ error: result.error }, 400)

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
  return c.json({ ok: true, refund: result.refund, order })
})

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

  const updates: Partial<typeof existing> = { updatedAt: new Date() }

  if (body.customerName !== undefined) updates.customerName = body.customerName
  if (body.customerPhone !== undefined) updates.customerPhone = body.customerPhone
  if (body.totalAmount !== undefined) updates.totalAmount = body.totalAmount
  if (body.currency !== undefined) updates.currency = body.currency
  if (body.notes !== undefined) updates.notes = body.notes

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

    const [freshUser] = await db
      .select({ preferredLocale: users.preferredLocale })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1)

    const result = await transitionOrder({
      farmId: user.farmId,
      orderId,
      toStatus: body.status as OrderStatus,
      actor: {
        id: user.id,
        farmId: user.farmId,
        role: user.role,
        preferredLocale: freshUser?.preferredLocale,
      },
    })
    if (!result.ok) return c.json({ error: result.error }, 400)
    return c.json({ order: result.order })
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

  return c.json({ order })
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
