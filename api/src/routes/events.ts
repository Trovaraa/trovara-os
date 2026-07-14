import { Hono } from 'hono'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { farmEvents, users } from '../db/schema.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { requireRole } from '../lib/rbac.js'

export const eventRoutes = new Hono<{ Variables: AppVariables }>()

eventRoutes.use('*', authMiddleware)

eventRoutes.get('/', async (c) => {
  const user = c.get('user')
  try {
    requireRole(user, 'owner', 'supervisor')
  } catch {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const entityType = c.req.query('entityType')
  const limit = Math.min(Number(c.req.query('limit') ?? 100), 500)

  const conditions = [eq(farmEvents.farmId, user.farmId)]
  if (entityType) {
    conditions.push(eq(farmEvents.entityType, entityType))
  }

  const rows = await db
    .select({
      id: farmEvents.id,
      eventType: farmEvents.eventType,
      entityType: farmEvents.entityType,
      entityId: farmEvents.entityId,
      source: farmEvents.source,
      approvalStatus: farmEvents.approvalStatus,
      metadata: farmEvents.metadata,
      beforeValue: farmEvents.beforeValue,
      afterValue: farmEvents.afterValue,
      createdAt: farmEvents.createdAt,
      actorName: users.name,
    })
    .from(farmEvents)
    .leftJoin(users, eq(farmEvents.actorUserId, users.id))
    .where(and(...conditions))
    .orderBy(desc(farmEvents.createdAt))
    .limit(limit)

  return c.json({ events: rows })
})
