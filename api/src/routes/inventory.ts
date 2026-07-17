import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, desc, eq, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import {
  inventoryCountLines,
  inventoryCountSessions,
  inventoryItems,
  inventoryMovements,
} from '../db/schema.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { canApproveTasks, canAssignTasks } from '../lib/rbac.js'
import { logAudit } from '../lib/audit.js'

const INVENTORY_UNITS = ['kg', 'bags', 'liters', 'units', 'crates'] as const

const createItemSchema = z.object({
  name: z.string().trim().min(1).max(200),
  category: z.string().trim().min(1).max(100),
  unit: z.enum(INVENTORY_UNITS),
  quantity: z.number().int().min(0).default(0),
  reorderLevel: z.number().int().min(0).default(10),
  costPerUnit: z.number().int().min(0).nullable().optional(),
  supplier: z.string().trim().max(200).nullable().optional(),
  expiryDate: z.string().datetime().nullable().optional(),
  storageLocation: z.string().trim().max(200).nullable().optional(),
  batchNumber: z.string().trim().max(100).nullable().optional(),
})

const movementSchema = z.object({
  itemId: z.string().uuid(),
  delta: z.number().int().refine((n) => n !== 0, 'Delta must be non-zero'),
  reason: z.string().min(1).max(500),
})

const openingCountSchema = z.object({
  items: z
    .array(
      z.object({
        itemId: z.string().uuid(),
        countedQuantity: z.number().int().min(0),
        notes: z.string().max(500).optional(),
      }),
    )
    .min(1),
})

const countSessionSchema = z.object({
  taskId: z.string().uuid().nullable().optional(),
  locationText: z.string().trim().max(500).nullable().optional(),
  lines: z
    .array(
      z.object({
        itemId: z.string().uuid().nullable().optional(),
        itemName: z.string().trim().min(1).max(200),
        category: z.string().trim().min(1).max(100).default('supplies'),
        unit: z.enum(INVENTORY_UNITS).default('units'),
        countedQuantity: z.number().int().min(0),
        notes: z.string().max(500).nullable().optional(),
      }),
    )
    .min(1)
    .max(200),
})

const verifyCountSchema = z.object({
  status: z.enum(['verified', 'rejected']),
  rejectionReason: z.string().trim().min(5).max(2000).nullable().optional(),
})

export const inventoryRoutes = new Hono<{ Variables: AppVariables }>()

inventoryRoutes.use('*', authMiddleware)

inventoryRoutes.get('/', async (c) => {
  const user = c.get('user')
  const items = await db
    .select()
    .from(inventoryItems)
    .where(eq(inventoryItems.farmId, user.farmId))
    .orderBy(inventoryItems.name)

  const enriched = items.map((item) => ({
    ...item,
    lowStock: item.quantity <= item.reorderLevel,
  }))

  return c.json({ items: enriched })
})

inventoryRoutes.post('/items', zValidator('json', createItemSchema), async (c) => {
  const user = c.get('user')
  if (!canAssignTasks(user)) return c.json({ error: 'Forbidden' }, 403)

  const body = c.req.valid('json')
  const [item] = await db
    .insert(inventoryItems)
    .values({
      farmId: user.farmId,
      name: body.name,
      category: body.category,
      unit: body.unit,
      quantity: body.quantity,
      reorderLevel: body.reorderLevel,
      costPerUnit: body.costPerUnit ?? null,
      supplier: body.supplier ?? null,
      expiryDate: body.expiryDate ? new Date(body.expiryDate) : null,
      storageLocation: body.storageLocation ?? null,
      batchNumber: body.batchNumber ?? null,
    })
    .returning()

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'create',
    entityType: 'inventory_item',
    entityId: item.id,
    metadata: { name: item.name },
  })

  return c.json({ item }, 201)
})

inventoryRoutes.post('/movements', zValidator('json', movementSchema), async (c) => {
  const user = c.get('user')
  if (user.role === 'field_worker') return c.json({ error: 'Forbidden' }, 403)

  const body = c.req.valid('json')
  const [item] = await db
    .select()
    .from(inventoryItems)
    .where(and(eq(inventoryItems.id, body.itemId), eq(inventoryItems.farmId, user.farmId)))
    .limit(1)

  if (!item) return c.json({ error: 'Item not found' }, 404)

  const newQty = item.quantity + body.delta
  if (newQty < 0) return c.json({ error: 'Insufficient stock' }, 400)

  const updated = await db.transaction(async (tx) => {
    await tx.insert(inventoryMovements).values({
      farmId: user.farmId,
      itemId: body.itemId,
      delta: body.delta,
      reason: body.reason,
      recordedById: user.id,
    })

    const [row] = await tx
      .update(inventoryItems)
      .set({ quantity: newQty, updatedAt: new Date() })
      .where(eq(inventoryItems.id, body.itemId))
      .returning()

    return row
  })

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'inventory_movement',
    entityType: 'inventory_item',
    entityId: body.itemId,
    metadata: { delta: body.delta, reason: body.reason },
  })

  return c.json({ item: updated })
})

inventoryRoutes.post('/opening-count', zValidator('json', openingCountSchema), async (c) => {
  const user = c.get('user')
  if (user.role === 'field_worker') return c.json({ error: 'Forbidden' }, 403)

  const body = c.req.valid('json')
  const itemIds = [...new Set(body.items.map((item) => item.itemId))]

  const existingItems = await db
    .select()
    .from(inventoryItems)
    .where(eq(inventoryItems.farmId, user.farmId))
  const byId = new Map(existingItems.map((item) => [item.id, item]))

  for (const id of itemIds) {
    if (!byId.has(id)) return c.json({ error: `Item not found: ${id}` }, 404)
  }

  const updatedItems = await db.transaction(async (tx) => {
    const nextRows: typeof existingItems = []
    for (const entry of body.items) {
      const current = byId.get(entry.itemId)
      if (!current) continue
      const delta = entry.countedQuantity - current.quantity

      if (delta !== 0) {
        await tx.insert(inventoryMovements).values({
          farmId: user.farmId,
          itemId: entry.itemId,
          delta,
          reason: 'opening_stock_count',
          recordedById: user.id,
        })
      }

      const [updated] = await tx
        .update(inventoryItems)
        .set({
          quantity: entry.countedQuantity,
          updatedAt: new Date(),
        })
        .where(eq(inventoryItems.id, entry.itemId))
        .returning()
      nextRows.push(updated)
    }
    return nextRows
  })

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'inventory_opening_count',
    entityType: 'inventory_item',
    metadata: {
      itemCount: body.items.length,
      reason: 'opening_stock_count',
    },
  })

  return c.json({ items: updatedItems })
})

inventoryRoutes.get('/count-sessions', async (c) => {
  const user = c.get('user')
  const sessions = await db
    .select()
    .from(inventoryCountSessions)
    .where(eq(inventoryCountSessions.farmId, user.farmId))
    .orderBy(desc(inventoryCountSessions.createdAt))
    .limit(50)
  return c.json({ sessions })
})

inventoryRoutes.post('/count-sessions', zValidator('json', countSessionSchema), async (c) => {
  const user = c.get('user')
  const body = c.req.valid('json')

  const session = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(inventoryCountSessions)
      .values({
        farmId: user.farmId,
        taskId: body.taskId ?? null,
        locationText: body.locationText ?? null,
        status: 'submitted',
        recordedById: user.id,
      })
      .returning()

    for (const line of body.lines) {
      await tx.insert(inventoryCountLines).values({
        sessionId: row.id,
        itemId: line.itemId ?? null,
        itemName: line.itemName,
        category: line.category,
        unit: line.unit,
        countedQuantity: line.countedQuantity,
        notes: line.notes ?? null,
      })
    }

    return row
  })

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'inventory_count_submit',
    entityType: 'inventory_count_session',
    entityId: session.id,
  })

  return c.json({ session }, 201)
})

inventoryRoutes.post(
  '/count-sessions/:id/verify',
  zValidator('json', verifyCountSchema),
  async (c) => {
    const user = c.get('user')
    if (!canApproveTasks(user)) return c.json({ error: 'Forbidden' }, 403)

    const sessionId = c.req.param('id')
    const body = c.req.valid('json')

    const [session] = await db
      .select()
      .from(inventoryCountSessions)
      .where(
        and(
          eq(inventoryCountSessions.id, sessionId),
          eq(inventoryCountSessions.farmId, user.farmId),
        ),
      )
      .limit(1)

    if (!session) return c.json({ error: 'Not found' }, 404)
    if (session.recordedById === user.id) {
      return c.json({ error: 'You cannot verify your own count session' }, 400)
    }
    if (session.status !== 'submitted') {
      return c.json({ error: 'Session already resolved' }, 400)
    }
    if (body.status === 'rejected' && !body.rejectionReason?.trim()) {
      return c.json({ error: 'rejectionReason is required' }, 400)
    }

    if (body.status === 'rejected') {
      const [updated] = await db
        .update(inventoryCountSessions)
        .set({
          status: 'rejected',
          verifiedById: user.id,
          verifiedAt: new Date(),
          rejectionReason: body.rejectionReason!.trim(),
        })
        .where(eq(inventoryCountSessions.id, sessionId))
        .returning()
      return c.json({ session: updated })
    }

    const lines = await db
      .select()
      .from(inventoryCountLines)
      .where(eq(inventoryCountLines.sessionId, sessionId))

    const updated = await db.transaction(async (tx) => {
      for (const line of lines) {
        let itemId = line.itemId
        if (!itemId) {
          const [created] = await tx
            .insert(inventoryItems)
            .values({
              farmId: user.farmId,
              name: line.itemName,
              category: line.category,
              unit: line.unit as (typeof INVENTORY_UNITS)[number],
              quantity: 0,
            })
            .returning()
          itemId = created.id
          await tx
            .update(inventoryCountLines)
            .set({ itemId })
            .where(eq(inventoryCountLines.id, line.id))
        }

        const [item] = await tx
          .select()
          .from(inventoryItems)
          .where(and(eq(inventoryItems.id, itemId), eq(inventoryItems.farmId, user.farmId)))
          .limit(1)
        if (!item) continue

        const delta = line.countedQuantity - item.quantity
        if (delta !== 0) {
          await tx.insert(inventoryMovements).values({
            farmId: user.farmId,
            itemId,
            delta,
            reason: 'verified_count_session',
            sourceType: 'inventory_count_line',
            sourceId: line.id,
            recordedById: user.id,
          })
        }

        await tx
          .update(inventoryItems)
          .set({ quantity: line.countedQuantity, updatedAt: new Date() })
          .where(eq(inventoryItems.id, itemId))
      }

      const [row] = await tx
        .update(inventoryCountSessions)
        .set({
          status: 'verified',
          verifiedById: user.id,
          verifiedAt: new Date(),
          rejectionReason: null,
        })
        .where(eq(inventoryCountSessions.id, sessionId))
        .returning()

      return row
    })

    await logAudit({
      farmId: user.farmId,
      userId: user.id,
      action: 'inventory_count_verify',
      entityType: 'inventory_count_session',
      entityId: sessionId,
    })

    return c.json({ session: updated })
  },
)

inventoryRoutes.get('/low-stock', async (c) => {
  const user = c.get('user')
  const items = await db
    .select()
    .from(inventoryItems)
    .where(
      and(
        eq(inventoryItems.farmId, user.farmId),
        sql`${inventoryItems.quantity} <= ${inventoryItems.reorderLevel}`,
      ),
    )

  return c.json({ items })
})
