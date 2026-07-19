import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import {
  customerContacts,
  customerInquiries,
  harvestLots,
  orderItems,
  orders,
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

export const salesRoutes = new Hono<{ Variables: AppVariables }>()

salesRoutes.use('*', authMiddleware)

salesRoutes.get('/', async (c) => {
  const user = c.get('user')

  const rows = await db
    .select({
      id: orders.id,
      customerName: orders.customerName,
      customerPhone: orders.customerPhone,
      status: orders.status,
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
      createdAt: orders.createdAt,
      updatedAt: orders.updatedAt,
    })
    .from(orders)
    .leftJoin(harvestLots, eq(orders.lotId, harvestLots.id))
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

  const result = rows.map((r) =>
    redactOrderForRole(
      {
        ...r,
        reference: orderReference(r.id),
        items: itemsByOrder[r.id] ?? [],
      },
      user,
    ),
  )

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
      totalAmount: orders.totalAmount,
      currency: orders.currency,
      source: orders.source,
      notes: orders.notes,
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
