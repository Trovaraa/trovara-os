import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { operationGuidelines, users } from '../db/schema.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { hasPermission } from '../lib/rbac.js'
import { logAudit } from '../lib/audit.js'

const guidelineSchema = z.object({
  title: z.string().trim().min(3).max(160),
  category: z.string().trim().min(2).max(80),
  body: z.string().trim().min(20).max(30000),
  audience: z.enum(['all', 'management', 'finance', 'operations', 'sales']).default('all'),
  reviewDueAt: z.string().datetime().nullable().optional(),
})

export const operationGuidelineRoutes = new Hono<{ Variables: AppVariables }>()
operationGuidelineRoutes.use('*', authMiddleware)

operationGuidelineRoutes.get('/', async (c) => {
  const user = c.get('user')
  if (!hasPermission(user, 'knowledge.read') && !hasPermission(user, 'knowledge.write')) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  const rows = await db
    .select({ guideline: operationGuidelines, authorName: users.name })
    .from(operationGuidelines)
    .leftJoin(users, eq(operationGuidelines.createdById, users.id))
    .where(eq(operationGuidelines.farmId, user.farmId))
    .orderBy(desc(operationGuidelines.updatedAt))
  const canApprove = hasPermission(user, 'knowledge.approve')
  return c.json({
    guidelines: rows
      .filter(({ guideline }) => canApprove || guideline.status === 'approved' || guideline.createdById === user.id)
      .map(({ guideline, authorName }) => ({ ...guideline, authorName })),
  })
})

operationGuidelineRoutes.post('/', zValidator('json', guidelineSchema), async (c) => {
  const user = c.get('user')
  if (!hasPermission(user, 'knowledge.write')) return c.json({ error: 'Forbidden' }, 403)
  const body = c.req.valid('json')
  const [guideline] = await db.insert(operationGuidelines).values({
    farmId: user.farmId,
    title: body.title,
    category: body.category,
    body: body.body,
    audience: body.audience,
    reviewDueAt: body.reviewDueAt ? new Date(body.reviewDueAt) : null,
    createdById: user.id,
  }).returning()
  await logAudit({ farmId: user.farmId, userId: user.id, action: 'operation_guideline_create', entityType: 'operation_guideline', entityId: guideline.id })
  return c.json({ guideline }, 201)
})

operationGuidelineRoutes.patch('/:id', zValidator('json', guidelineSchema.partial()), async (c) => {
  const user = c.get('user')
  if (!hasPermission(user, 'knowledge.write')) return c.json({ error: 'Forbidden' }, 403)
  const id = c.req.param('id')
  const [existing] = await db.select().from(operationGuidelines).where(and(eq(operationGuidelines.id, id), eq(operationGuidelines.farmId, user.farmId))).limit(1)
  if (!existing) return c.json({ error: 'Guideline not found' }, 404)
  if (existing.createdById !== user.id && !hasPermission(user, 'knowledge.approve')) return c.json({ error: 'Forbidden' }, 403)
  const body = c.req.valid('json')
  const [guideline] = await db.update(operationGuidelines).set({
    ...body,
    reviewDueAt: body.reviewDueAt === undefined ? existing.reviewDueAt : body.reviewDueAt ? new Date(body.reviewDueAt) : null,
    status: 'draft',
    approvedAt: null,
    approvedById: null,
    version: existing.version + 1,
    updatedAt: new Date(),
  }).where(eq(operationGuidelines.id, id)).returning()
  return c.json({ guideline })
})

operationGuidelineRoutes.post('/:id/approve', async (c) => {
  const user = c.get('user')
  if (!hasPermission(user, 'knowledge.approve')) return c.json({ error: 'Forbidden' }, 403)
  const [guideline] = await db.update(operationGuidelines).set({ status: 'approved', approvedById: user.id, approvedAt: new Date(), updatedAt: new Date() }).where(and(eq(operationGuidelines.id, c.req.param('id')), eq(operationGuidelines.farmId, user.farmId))).returning()
  if (!guideline) return c.json({ error: 'Guideline not found' }, 404)
  await logAudit({ farmId: user.farmId, userId: user.id, action: 'operation_guideline_approve', entityType: 'operation_guideline', entityId: guideline.id, metadata: { version: guideline.version } })
  return c.json({ guideline })
})

operationGuidelineRoutes.post('/:id/archive', async (c) => {
  const user = c.get('user')
  if (!hasPermission(user, 'knowledge.approve')) return c.json({ error: 'Forbidden' }, 403)
  const [guideline] = await db.update(operationGuidelines).set({ status: 'archived', updatedAt: new Date() }).where(and(eq(operationGuidelines.id, c.req.param('id')), eq(operationGuidelines.farmId, user.farmId))).returning()
  if (!guideline) return c.json({ error: 'Guideline not found' }, 404)
  return c.json({ guideline })
})
