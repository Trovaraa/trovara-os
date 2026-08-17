import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { anomalyObservations } from '../db/schema.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { requirePermission } from '../lib/rbac.js'
import { logAudit } from '../lib/audit.js'
import { runAnomalyObservationMode } from '../lib/anomaly-observations.js'

const reviewSchema = z.object({
  status: z.enum(['explained', 'confirmed', 'false_positive']),
  reviewNote: z.string().trim().min(3).max(2000),
})

export const anomalyRoutes = new Hono<{ Variables: AppVariables }>()
anomalyRoutes.use('*', authMiddleware)

anomalyRoutes.get('/', async (c) => {
  const user = c.get('user')
  requirePermission(user, 'anomalies.read')
  const requestedStatus = c.req.query('status') ?? 'observed'
  const status = ['observed', 'explained', 'confirmed', 'false_positive'].includes(requestedStatus)
    ? requestedStatus
    : 'observed'
  const rows = await db.select().from(anomalyObservations)
    .where(and(eq(anomalyObservations.farmId, user.farmId), eq(anomalyObservations.status, status)))
    .orderBy(desc(anomalyObservations.lastObservedAt)).limit(200)
  return c.json({ mode: 'observation', observations: rows })
})

anomalyRoutes.post('/run', async (c) => {
  const user = c.get('user')
  requirePermission(user, 'anomalies.review')
  const result = await runAnomalyObservationMode(user.farmId)
  await logAudit({ farmId: user.farmId, userId: user.id, action: 'anomaly_observation_run', entityType: 'anomaly_observation', metadata: result })
  return c.json(result)
})

anomalyRoutes.patch('/:id/review', zValidator('json', reviewSchema), async (c) => {
  const user = c.get('user')
  requirePermission(user, 'anomalies.review')
  const body = c.req.valid('json')
  const [existing] = await db.select({ id: anomalyObservations.id, status: anomalyObservations.status })
    .from(anomalyObservations)
    .where(and(eq(anomalyObservations.id, c.req.param('id')), eq(anomalyObservations.farmId, user.farmId))).limit(1)
  if (!existing) return c.json({ error: 'Observation not found' }, 404)
  if (existing.status !== 'observed') return c.json({ error: 'Observation was already reviewed' }, 409)
  const now = new Date()
  const [observation] = await db.update(anomalyObservations).set({ status: body.status, reviewNote: body.reviewNote, reviewedById: user.id, reviewedAt: now, updatedAt: now })
    .where(and(eq(anomalyObservations.id, existing.id), eq(anomalyObservations.farmId, user.farmId), eq(anomalyObservations.status, 'observed'))).returning()
  if (!observation) return c.json({ error: 'Observation was already reviewed' }, 409)
  await logAudit({ farmId: user.farmId, userId: user.id, action: `anomaly_${body.status}`, entityType: 'anomaly_observation', entityId: existing.id, metadata: { reviewNote: body.reviewNote } })
  return c.json({ observation })
})
