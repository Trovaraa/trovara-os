import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, asc, eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { inventoryItems, products } from '../db/schema.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { canManageProducts, requirePermission } from '../lib/rbac.js'
import { logAudit } from '../lib/audit.js'

/** Suggested catalogue units (UI presets). Custom values are allowed. */
export const PRODUCT_UNIT_PRESETS = [
  'kg',
  'tonne',
  'crate',
  'tray',
  'bag',
  'bunch',
  'piece',
  'pack',
  'bird',
  'litre',
  'unit',
] as const

const productUnitSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[A-Za-z0-9][A-Za-z0-9 _./%-]*$/, 'Invalid unit')
  .transform((value) => value.replace(/\s+/g, ' '))
  .default('unit')

const createProductSchema = z.object({
  sku: z.string().trim().min(2).max(40).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/).optional(),
  name: z.string().min(1).max(200),
  // Free-text unit with presets in the UI (DB column is text, not an enum).
  unit: productUnitSchema,
  // Kobo (integer minor units). 0 => "price on request".
  priceKobo: z.number().int().min(0).default(0),
  currency: z.string().max(10).default('NGN'),
  active: z.boolean().default(true),
  sortOrder: z.number().int().min(0).default(0),
})

const updateProductSchema = createProductSchema.partial().extend({
  // Virtual field: links/unlinks a stock row (stored on inventory_items.product_id).
  inventoryItemId: z.string().uuid().nullable().optional(),
})

export const productRoutes = new Hono<{ Variables: AppVariables }>()

productRoutes.use('*', authMiddleware)

productRoutes.get('/', async (c) => {
  const user = c.get('user')
  const rows = await db
    .select({
      id: products.id,
      farmId: products.farmId,
      sku: products.sku,
      name: products.name,
      unit: products.unit,
      priceKobo: products.priceKobo,
      currency: products.currency,
      active: products.active,
      sortOrder: products.sortOrder,
      createdAt: products.createdAt,
      updatedAt: products.updatedAt,
      inventoryItemId: inventoryItems.id,
      inventorySku: inventoryItems.sku,
      inventoryQuantity: inventoryItems.quantity,
      inventoryUnit: inventoryItems.unit,
    })
    .from(products)
    .leftJoin(
      inventoryItems,
      and(eq(inventoryItems.productId, products.id), eq(inventoryItems.farmId, user.farmId)),
    )
    .where(eq(products.farmId, user.farmId))
    .orderBy(asc(products.sortOrder), asc(products.name))
  return c.json({ products: rows })
})

productRoutes.post('/', zValidator('json', createProductSchema), async (c) => {
  const user = c.get('user')
  if (!canManageProducts(user)) return c.json({ error: 'Forbidden' }, 403)

  const body = c.req.valid('json')
  const sku = (body.sku ?? `PRD-${randomUUID().slice(0, 8)}`).toUpperCase()
  const [duplicate] = await db
    .select({ id: products.id })
    .from(products)
    .where(and(eq(products.farmId, user.farmId), eq(products.sku, sku)))
    .limit(1)
  if (duplicate) return c.json({ error: 'SKU already exists' }, 400)

  const [product] = await db
    .insert(products)
    .values({ ...body, sku, farmId: user.farmId })
    .returning()

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'create',
    entityType: 'product',
    entityId: product.id,
  })

  return c.json({ product }, 201)
})

productRoutes.patch('/:id', zValidator('json', updateProductSchema), async (c) => {
  const user = c.get('user')
  if (!canManageProducts(user)) return c.json({ error: 'Forbidden' }, 403)

  const productId = c.req.param('id')
  const [existing] = await db
    .select()
    .from(products)
    .where(and(eq(products.id, productId), eq(products.farmId, user.farmId)))
    .limit(1)
  if (!existing) return c.json({ error: 'Not found' }, 404)

  const body = c.req.valid('json')
  const { inventoryItemId, ...productFields } = body
  if (productFields.sku !== undefined) {
    const sku = productFields.sku.toUpperCase()
    const [duplicate] = await db
      .select({ id: products.id })
      .from(products)
      .where(and(eq(products.farmId, user.farmId), eq(products.sku, sku)))
      .limit(1)
    if (duplicate && duplicate.id !== productId) {
      return c.json({ error: 'SKU already exists' }, 400)
    }
    productFields.sku = sku
  }

  if (inventoryItemId !== undefined) {
    if (inventoryItemId) {
      const [item] = await db
        .select()
        .from(inventoryItems)
        .where(
          and(eq(inventoryItems.id, inventoryItemId), eq(inventoryItems.farmId, user.farmId)),
        )
        .limit(1)
      if (!item) return c.json({ error: 'Inventory item not found' }, 400)
      if (item.productId && item.productId !== productId) {
        return c.json({ error: 'Inventory item is already linked to another product' }, 400)
      }
      // Clear any previous link for this product, then attach the chosen item.
      await db
        .update(inventoryItems)
        .set({ productId: null, updatedAt: new Date() })
        .where(
          and(eq(inventoryItems.farmId, user.farmId), eq(inventoryItems.productId, productId)),
        )
      await db
        .update(inventoryItems)
        .set({ productId, updatedAt: new Date() })
        .where(eq(inventoryItems.id, inventoryItemId))
    } else {
      await db
        .update(inventoryItems)
        .set({ productId: null, updatedAt: new Date() })
        .where(
          and(eq(inventoryItems.farmId, user.farmId), eq(inventoryItems.productId, productId)),
        )
    }
  }

  const [product] = await db
    .update(products)
    .set({ ...productFields, updatedAt: new Date() })
    .where(eq(products.id, productId))
    .returning()

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'update',
    entityType: 'product',
    entityId: productId,
  })

  const [linked] = await db
    .select({
      inventoryItemId: inventoryItems.id,
      inventorySku: inventoryItems.sku,
      inventoryQuantity: inventoryItems.quantity,
      inventoryUnit: inventoryItems.unit,
    })
    .from(inventoryItems)
    .where(
      and(eq(inventoryItems.farmId, user.farmId), eq(inventoryItems.productId, productId)),
    )
    .limit(1)

  return c.json({
    product: {
      ...product,
      inventoryItemId: linked?.inventoryItemId ?? null,
      inventorySku: linked?.inventorySku ?? null,
      inventoryQuantity: linked?.inventoryQuantity ?? null,
      inventoryUnit: linked?.inventoryUnit ?? null,
    },
  })
})

productRoutes.delete('/:id', async (c) => {
  const user = c.get('user')
  try {
    requirePermission(user, 'products.delete')
  } catch {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const productId = c.req.param('id')
  const [existing] = await db
    .select()
    .from(products)
    .where(and(eq(products.id, productId), eq(products.farmId, user.farmId)))
    .limit(1)
  if (!existing) return c.json({ error: 'Not found' }, 404)

  // Soft-delete: deactivate so historical order_items keep their product link.
  await db
    .update(products)
    .set({ active: false, updatedAt: new Date() })
    .where(eq(products.id, productId))

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'delete',
    entityType: 'product',
    entityId: productId,
  })

  return c.json({ ok: true })
})
