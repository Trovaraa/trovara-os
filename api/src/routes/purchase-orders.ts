import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import {
  goodsReceiptLines,
  goodsReceipts,
  inventoryItems,
  inventoryMovements,
  purchaseOrderLines,
  purchaseOrders,
  suppliers,
} from '../db/schema.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { canAssignTasks } from '../lib/rbac.js'
import { logAudit } from '../lib/audit.js'
import {
  purchaseOrderStatusAfterReceipt,
  receiptQuantityIsValid,
} from '../lib/purchase-order-receiving.js'

const UNITS = ['kg', 'bags', 'liters', 'units', 'crates'] as const

const createPurchaseOrderSchema = z.object({
  supplierId: z.string().uuid(),
  notes: z.string().trim().max(2000).nullable().optional(),
  expectedAt: z.string().datetime().nullable().optional(),
  lines: z.array(z.object({
    itemId: z.string().uuid().nullable().optional(),
    itemName: z.string().trim().min(1).max(200),
    unit: z.enum(UNITS),
    quantityOrdered: z.number().int().positive(),
    unitCostMinor: z.number().int().min(0).nullable().optional(),
  })).min(1).max(100),
})

const receiveSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(200),
  notes: z.string().trim().max(2000).nullable().optional(),
  lines: z.array(z.object({
    purchaseOrderLineId: z.string().uuid(),
    quantityReceived: z.number().int().positive(),
  })).min(1).max(100).refine(
    (lines) => new Set(lines.map((line) => line.purchaseOrderLineId)).size === lines.length,
    'Duplicate purchase order line',
  ),
})

async function purchaseOrderDetail(farmId: string, id: string) {
  const [order] = await db
    .select({
      id: purchaseOrders.id,
      farmId: purchaseOrders.farmId,
      supplierId: purchaseOrders.supplierId,
      supplierName: suppliers.name,
      status: purchaseOrders.status,
      createdById: purchaseOrders.createdById,
      approvedById: purchaseOrders.approvedById,
      approvedAt: purchaseOrders.approvedAt,
      notes: purchaseOrders.notes,
      expectedAt: purchaseOrders.expectedAt,
      createdAt: purchaseOrders.createdAt,
      updatedAt: purchaseOrders.updatedAt,
    })
    .from(purchaseOrders)
    .innerJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId))
    .where(and(eq(purchaseOrders.id, id), eq(purchaseOrders.farmId, farmId)))
    .limit(1)
  if (!order) return null

  const lines = await db
    .select()
    .from(purchaseOrderLines)
    .where(eq(purchaseOrderLines.purchaseOrderId, id))
    .orderBy(asc(purchaseOrderLines.createdAt))
  const receipts = await db
    .select()
    .from(goodsReceipts)
    .where(and(eq(goodsReceipts.purchaseOrderId, id), eq(goodsReceipts.farmId, farmId)))
    .orderBy(desc(goodsReceipts.receivedAt))
  return { ...order, lines, receipts }
}

export const purchaseOrderRoutes = new Hono<{ Variables: AppVariables }>()

purchaseOrderRoutes.use('*', authMiddleware)

purchaseOrderRoutes.get('/', async (c) => {
  const user = c.get('user')
  const orders = await db
    .select({
      id: purchaseOrders.id,
      supplierId: purchaseOrders.supplierId,
      supplierName: suppliers.name,
      status: purchaseOrders.status,
      notes: purchaseOrders.notes,
      expectedAt: purchaseOrders.expectedAt,
      approvedById: purchaseOrders.approvedById,
      createdAt: purchaseOrders.createdAt,
      updatedAt: purchaseOrders.updatedAt,
    })
    .from(purchaseOrders)
    .innerJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId))
    .where(eq(purchaseOrders.farmId, user.farmId))
    .orderBy(desc(purchaseOrders.createdAt))
    .limit(100)
  return c.json({ purchaseOrders: orders })
})

purchaseOrderRoutes.get('/:id', async (c) => {
  const order = await purchaseOrderDetail(c.get('user').farmId, c.req.param('id'))
  return order ? c.json({ purchaseOrder: order }) : c.json({ error: 'Purchase order not found' }, 404)
})

purchaseOrderRoutes.post('/', zValidator('json', createPurchaseOrderSchema), async (c) => {
  const user = c.get('user')
  if (!canAssignTasks(user)) return c.json({ error: 'Forbidden' }, 403)
  const body = c.req.valid('json')
  const [supplier] = await db
    .select({ id: suppliers.id })
    .from(suppliers)
    .where(and(
      eq(suppliers.id, body.supplierId),
      eq(suppliers.farmId, user.farmId),
      eq(suppliers.active, true),
    ))
    .limit(1)
  if (!supplier) return c.json({ error: 'Active supplier not found' }, 404)

  const itemIds = body.lines.flatMap((line) => line.itemId ? [line.itemId] : [])
  if (itemIds.length) {
    const farmItems = await db
      .select({ id: inventoryItems.id })
      .from(inventoryItems)
      .where(and(
        eq(inventoryItems.farmId, user.farmId),
        inArray(inventoryItems.id, [...new Set(itemIds)]),
      ))
    if (farmItems.length !== new Set(itemIds).size) {
      return c.json({ error: 'One or more inventory items were not found' }, 404)
    }
  }

  const orderId = await db.transaction(async (tx) => {
    const [order] = await tx
      .insert(purchaseOrders)
      .values({
        farmId: user.farmId,
        supplierId: body.supplierId,
        createdById: user.id,
        notes: body.notes ?? null,
        expectedAt: body.expectedAt ? new Date(body.expectedAt) : null,
      })
      .returning({ id: purchaseOrders.id })
    await tx.insert(purchaseOrderLines).values(body.lines.map((line) => ({
      purchaseOrderId: order.id,
      itemId: line.itemId ?? null,
      itemName: line.itemName,
      unit: line.unit,
      quantityOrdered: line.quantityOrdered,
      unitCostMinor: line.unitCostMinor ?? null,
    })))
    return order.id
  })
  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'create',
    entityType: 'purchase_order',
    entityId: orderId,
  })
  return c.json({ purchaseOrder: await purchaseOrderDetail(user.farmId, orderId) }, 201)
})

purchaseOrderRoutes.post('/:id/approve', async (c) => {
  const user = c.get('user')
  if (user.role !== 'owner') return c.json({ error: 'Forbidden' }, 403)
  const [order] = await db
    .update(purchaseOrders)
    .set({
      status: 'approved',
      approvedById: user.id,
      approvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(
      eq(purchaseOrders.id, c.req.param('id')),
      eq(purchaseOrders.farmId, user.farmId),
      eq(purchaseOrders.status, 'draft'),
    ))
    .returning()
  if (!order) return c.json({ error: 'Draft purchase order not found' }, 404)
  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'approve',
    entityType: 'purchase_order',
    entityId: order.id,
  })
  return c.json({ purchaseOrder: await purchaseOrderDetail(user.farmId, order.id) })
})

purchaseOrderRoutes.post('/:id/send', async (c) => {
  const user = c.get('user')
  if (!canAssignTasks(user)) return c.json({ error: 'Forbidden' }, 403)
  const [order] = await db
    .update(purchaseOrders)
    .set({ status: 'sent', updatedAt: new Date() })
    .where(and(
      eq(purchaseOrders.id, c.req.param('id')),
      eq(purchaseOrders.farmId, user.farmId),
      eq(purchaseOrders.status, 'approved'),
    ))
    .returning()
  if (!order) return c.json({ error: 'Approved purchase order not found' }, 404)
  return c.json({ purchaseOrder: await purchaseOrderDetail(user.farmId, order.id) })
})

purchaseOrderRoutes.post('/:id/cancel', async (c) => {
  const user = c.get('user')
  if (user.role !== 'owner') return c.json({ error: 'Forbidden' }, 403)
  const [order] = await db
    .update(purchaseOrders)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(and(
      eq(purchaseOrders.id, c.req.param('id')),
      eq(purchaseOrders.farmId, user.farmId),
      inArray(purchaseOrders.status, ['draft', 'approved', 'sent']),
    ))
    .returning()
  if (!order) return c.json({ error: 'Cancellable purchase order not found' }, 404)
  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'cancel',
    entityType: 'purchase_order',
    entityId: order.id,
  })
  return c.json({ purchaseOrder: await purchaseOrderDetail(user.farmId, order.id) })
})

purchaseOrderRoutes.post('/:id/receipts', zValidator('json', receiveSchema), async (c) => {
  const user = c.get('user')
  if (!canAssignTasks(user)) return c.json({ error: 'Forbidden' }, 403)
  const orderId = c.req.param('id')
  const body = c.req.valid('json')

  try {
    const receiptId = await db.transaction(async (tx) => {
      await tx.execute(sql`
        SELECT id FROM purchase_orders
        WHERE id = ${orderId} AND farm_id = ${user.farmId}
        FOR UPDATE
      `)
      const [order] = await tx
        .select()
        .from(purchaseOrders)
        .where(and(eq(purchaseOrders.id, orderId), eq(purchaseOrders.farmId, user.farmId)))
        .limit(1)
      if (!order) throw new Error('PO_NOT_FOUND')
      if (!['approved', 'sent', 'partially_received'].includes(order.status)) {
        throw new Error('PO_NOT_RECEIVABLE')
      }

      const [existing] = await tx
        .select({ id: goodsReceipts.id })
        .from(goodsReceipts)
        .where(and(
          eq(goodsReceipts.purchaseOrderId, orderId),
          eq(goodsReceipts.idempotencyKey, body.idempotencyKey),
        ))
        .limit(1)
      if (existing) return existing.id

      const lines = await tx
        .select()
        .from(purchaseOrderLines)
        .where(eq(purchaseOrderLines.purchaseOrderId, orderId))
      const byId = new Map(lines.map((line) => [line.id, line]))
      for (const received of body.lines) {
        const line = byId.get(received.purchaseOrderLineId)
        if (!line) throw new Error('PO_LINE_NOT_FOUND')
        if (!line.itemId) throw new Error('PO_LINE_ITEM_REQUIRED')
        if (!receiptQuantityIsValid(line, received.quantityReceived)) {
          throw new Error('PO_LINE_OVER_RECEIPT')
        }
      }

      const [receipt] = await tx
        .insert(goodsReceipts)
        .values({
          farmId: user.farmId,
          purchaseOrderId: orderId,
          idempotencyKey: body.idempotencyKey,
          receivedById: user.id,
          notes: body.notes ?? null,
        })
        .returning({ id: goodsReceipts.id })

      for (const received of body.lines) {
        const line = byId.get(received.purchaseOrderLineId)!
        const [receiptLine] = await tx
          .insert(goodsReceiptLines)
          .values({
            goodsReceiptId: receipt.id,
            purchaseOrderLineId: line.id,
            itemId: line.itemId!,
            quantityReceived: received.quantityReceived,
          })
          .returning({ id: goodsReceiptLines.id })
        const [movement] = await tx
          .insert(inventoryMovements)
          .values({
            farmId: user.farmId,
            itemId: line.itemId!,
            delta: received.quantityReceived,
            reason: 'goods_receipt',
            sourceType: 'goods_receipt_line',
            sourceId: receiptLine.id,
            recordedById: user.id,
          })
          .returning({ id: inventoryMovements.id })
        await tx
          .update(goodsReceiptLines)
          .set({ inventoryMovementId: movement.id })
          .where(eq(goodsReceiptLines.id, receiptLine.id))
        await tx
          .update(inventoryItems)
          .set({
            quantity: sql`${inventoryItems.quantity} + ${received.quantityReceived}`,
            updatedAt: new Date(),
          })
          .where(and(
            eq(inventoryItems.id, line.itemId!),
            eq(inventoryItems.farmId, user.farmId),
          ))
        line.quantityReceived += received.quantityReceived
        await tx
          .update(purchaseOrderLines)
          .set({ quantityReceived: line.quantityReceived })
          .where(eq(purchaseOrderLines.id, line.id))
      }

      await tx
        .update(purchaseOrders)
        .set({
          status: purchaseOrderStatusAfterReceipt(lines),
          updatedAt: new Date(),
        })
        .where(eq(purchaseOrders.id, orderId))
      return receipt.id
    })

    const [receipt] = await db
      .select()
      .from(goodsReceipts)
      .where(and(eq(goodsReceipts.id, receiptId), eq(goodsReceipts.farmId, user.farmId)))
      .limit(1)
    const lines = await db
      .select()
      .from(goodsReceiptLines)
      .where(eq(goodsReceiptLines.goodsReceiptId, receiptId))
    await logAudit({
      farmId: user.farmId,
      userId: user.id,
      action: 'receive',
      entityType: 'goods_receipt',
      entityId: receiptId,
      metadata: { purchaseOrderId: orderId },
    })
    return c.json({
      receipt: { ...receipt, lines },
      purchaseOrder: await purchaseOrderDetail(user.farmId, orderId),
    }, 201)
  } catch (error) {
    const code = error instanceof Error ? error.message : ''
    if (code === 'PO_NOT_FOUND') return c.json({ error: 'Purchase order not found' }, 404)
    if (code === 'PO_NOT_RECEIVABLE') return c.json({ error: 'Purchase order is not approved for receiving' }, 409)
    if (code === 'PO_LINE_NOT_FOUND') return c.json({ error: 'Purchase order line not found' }, 404)
    if (code === 'PO_LINE_ITEM_REQUIRED') return c.json({ error: 'Receipt line must be linked to an inventory item' }, 400)
    if (code === 'PO_LINE_OVER_RECEIPT') return c.json({ error: 'Received quantity exceeds the outstanding quantity' }, 409)
    throw error
  }
})
