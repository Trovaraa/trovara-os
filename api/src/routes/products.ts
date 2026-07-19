import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, asc, eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { products } from '../db/schema.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { canManageProducts, requireRole } from '../lib/rbac.js'
import { logAudit } from '../lib/audit.js'

const createProductSchema = z.object({
  name: z.string().min(1).max(200),
  unit: z.string().min(1).max(40).default('unit'),
  // Kobo (integer minor units). 0 => "price on request".
  priceKobo: z.number().int().min(0).default(0),
  currency: z.string().max(10).default('NGN'),
  active: z.boolean().default(true),
  sortOrder: z.number().int().min(0).default(0),
})

const updateProductSchema = createProductSchema.partial()

export const productRoutes = new Hono<{ Variables: AppVariables }>()

productRoutes.use('*', authMiddleware)

productRoutes.get('/', async (c) => {
  const user = c.get('user')
  const rows = await db
    .select()
    .from(products)
    .where(eq(products.farmId, user.farmId))
    .orderBy(asc(products.sortOrder), asc(products.name))
  return c.json({ products: rows })
})

productRoutes.post('/', zValidator('json', createProductSchema), async (c) => {
  const user = c.get('user')
  if (!canManageProducts(user)) return c.json({ error: 'Forbidden' }, 403)

  const body = c.req.valid('json')
  const [product] = await db
    .insert(products)
    .values({ ...body, farmId: user.farmId })
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
  const [product] = await db
    .update(products)
    .set({ ...body, updatedAt: new Date() })
    .where(eq(products.id, productId))
    .returning()

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'update',
    entityType: 'product',
    entityId: productId,
  })

  return c.json({ product })
})

productRoutes.delete('/:id', async (c) => {
  const user = c.get('user')
  try {
    requireRole(user, 'owner')
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
