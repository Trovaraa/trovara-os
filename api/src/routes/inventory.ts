import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { inventoryItems, inventoryMovements } from '../db/schema.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { logAudit } from '../lib/audit.js'

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
