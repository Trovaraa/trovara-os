import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, asc, eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { suppliers } from '../db/schema.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { canAssignTasks } from '../lib/rbac.js'
import { logAudit } from '../lib/audit.js'

const supplierSchema = z.object({
  name: z.string().trim().min(1).max(200),
  phone: z.string().trim().max(50).nullable().optional(),
  email: z.string().trim().email().max(320).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  active: z.boolean().optional(),
})

export const supplierRoutes = new Hono<{ Variables: AppVariables }>()

supplierRoutes.use('*', authMiddleware)

supplierRoutes.get('/', async (c) => {
  const user = c.get('user')
  const rows = await db
    .select()
    .from(suppliers)
    .where(eq(suppliers.farmId, user.farmId))
    .orderBy(asc(suppliers.name))
  return c.json({ suppliers: rows })
})

supplierRoutes.post('/', zValidator('json', supplierSchema), async (c) => {
  const user = c.get('user')
  if (!canAssignTasks(user)) return c.json({ error: 'Forbidden' }, 403)
  const body = c.req.valid('json')
  const [supplier] = await db
    .insert(suppliers)
    .values({
      farmId: user.farmId,
      name: body.name,
      phone: body.phone ?? null,
      email: body.email ?? null,
      notes: body.notes ?? null,
      active: body.active ?? true,
    })
    .returning()
  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'create',
    entityType: 'supplier',
    entityId: supplier.id,
  })
  return c.json({ supplier }, 201)
})

supplierRoutes.patch('/:id', zValidator('json', supplierSchema.partial()), async (c) => {
  const user = c.get('user')
  if (!canAssignTasks(user)) return c.json({ error: 'Forbidden' }, 403)
  const body = c.req.valid('json')
  const [supplier] = await db
    .update(suppliers)
    .set({ ...body, updatedAt: new Date() })
    .where(and(eq(suppliers.id, c.req.param('id')), eq(suppliers.farmId, user.farmId)))
    .returning()
  if (!supplier) return c.json({ error: 'Supplier not found' }, 404)
  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'update',
    entityType: 'supplier',
    entityId: supplier.id,
  })
  return c.json({ supplier })
})
