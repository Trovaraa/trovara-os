import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { harvestLots, orders } from '../db/schema.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { canAssignTasks } from '../lib/rbac.js'
import { logAudit } from '../lib/audit.js'
import { canTransitionOrder, type OrderStatus } from '../lib/state-machines.js'
import { recordFarmEvent } from '../lib/farm-events.js'

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
      notes: orders.notes,
      dispatchedAt: orders.dispatchedAt,
      createdAt: orders.createdAt,
      updatedAt: orders.updatedAt,
    })
    .from(orders)
    .leftJoin(harvestLots, eq(orders.lotId, harvestLots.id))
    .where(eq(orders.farmId, user.farmId))
    .orderBy(desc(orders.updatedAt))

  return c.json({ orders: rows })
})

salesRoutes.post('/', zValidator('json', createOrderSchema), async (c) => {
  const user = c.get('user')
  if (!canAssignTasks(user)) return c.json({ error: 'Forbidden' }, 403)

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
    })
    .returning()

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'create',
    entityType: 'order',
    entityId: order.id,
  })

  return c.json({ order }, 201)
})

salesRoutes.patch('/:id', zValidator('json', updateOrderSchema), async (c) => {
  const user = c.get('user')
  if (!canAssignTasks(user)) return c.json({ error: 'Forbidden' }, 403)

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

  if (body.status) {
    const fromStatus = existing.status as OrderStatus
    const toStatus = body.status as OrderStatus

    if (!canTransitionOrder(fromStatus, toStatus, user.role)) {
      return c.json({ error: 'Invalid status transition' }, 400)
    }

    updates.status = body.status
    if (body.status === 'dispatched') {
      updates.dispatchedAt = new Date()
    }
  }

  const [order] = await db
    .update(orders)
    .set(updates)
    .where(eq(orders.id, orderId))
    .returning()

  if (body.status && body.status !== existing.status) {
    await recordFarmEvent({
      farmId: user.farmId,
      actorUserId: user.id,
      entityType: 'order',
      entityId: orderId,
      eventType: body.status === 'delivered' ? 'sold' : 'other',
      beforeValue: { status: existing.status },
      afterValue: { status: order.status },
      metadata: { lotId: order.lotId ?? undefined, totalAmount: order.totalAmount },
    })
  }

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'update',
    entityType: 'order',
    entityId: orderId,
    metadata: { status: order.status },
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
