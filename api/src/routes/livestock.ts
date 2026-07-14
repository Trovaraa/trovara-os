import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { livestockBatches, livestockLogs, plots } from '../db/schema.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { canAssignTasks } from '../lib/rbac.js'
import { logAudit } from '../lib/audit.js'

const BROILER_VACCINATION_SCHEDULE = [
  { day: 1, name: 'Newcastle / IB (hatchery)', vaccine: 'Lasota + IB' },
  { day: 7, name: 'Gumboro (IBD)', vaccine: 'Gumboro live' },
  { day: 14, name: 'Newcastle booster', vaccine: 'Lasota booster' },
  { day: 21, name: 'Gumboro booster', vaccine: 'Gumboro live booster' },
  { day: 28, name: 'Pre-closeout health check', vaccine: 'Optional fowl pox' },
]

const CHICK_START_WEIGHT_KG = 0.04
const BROILER_TARGET_WEIGHT_KG = 2.5
const BROILER_DAILY_GAIN_KG = 0.05

function estimateBroilerWeightKg(daysSinceStart: number): number {
  return Math.min(BROILER_TARGET_WEIGHT_KG, CHICK_START_WEIGHT_KG + daysSinceStart * BROILER_DAILY_GAIN_KG)
}

const createBatchSchema = z.object({
  name: z.string().min(1).max(200),
  species: z.string().min(1).max(100),
  headCount: z.number().int().positive(),
  plotId: z.string().uuid().optional(),
  acquiredAt: z.string().datetime(),
  notes: z.string().max(2000).optional(),
})

const updateBatchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  species: z.string().min(1).max(100).optional(),
  headCount: z.number().int().nonnegative().optional(),
  plotId: z.string().uuid().nullable().optional(),
  notes: z.string().max(2000).optional(),
  active: z.boolean().optional(),
})

const createLogSchema = z.object({
  logType: z.enum(['feeding', 'vaccination', 'mortality', 'incident', 'health_check']),
  headCount: z.number().int().positive().optional(),
  notes: z.string().max(2000).optional(),
})

export const livestockRoutes = new Hono<{ Variables: AppVariables }>()

livestockRoutes.use('*', authMiddleware)

livestockRoutes.get('/batches', async (c) => {
  const user = c.get('user')

  const rows = await db
    .select({
      id: livestockBatches.id,
      name: livestockBatches.name,
      species: livestockBatches.species,
      headCount: livestockBatches.headCount,
      plotId: livestockBatches.plotId,
      plotName: plots.name,
      acquiredAt: livestockBatches.acquiredAt,
      notes: livestockBatches.notes,
      active: livestockBatches.active,
      createdAt: livestockBatches.createdAt,
    })
    .from(livestockBatches)
    .leftJoin(plots, eq(livestockBatches.plotId, plots.id))
    .where(eq(livestockBatches.farmId, user.farmId))
    .orderBy(desc(livestockBatches.createdAt))

  return c.json({ batches: rows })
})

livestockRoutes.get('/batches/:id/economics', async (c) => {
  const user = c.get('user')
  const batchId = c.req.param('id')

  const [batch] = await db
    .select()
    .from(livestockBatches)
    .where(and(eq(livestockBatches.id, batchId), eq(livestockBatches.farmId, user.farmId)))
    .limit(1)

  if (!batch) return c.json({ error: 'Not found' }, 404)

  const startCount = batch.startCount ?? batch.headCount
  const feedUsedKg = batch.feedUsedKg ?? 0
  const daysSinceStart = Math.max(
    0,
    Math.floor((Date.now() - batch.acquiredAt.getTime()) / 86400000),
  )

  const estimatedWeightPerBird =
    batch.batchType === 'broiler' || batch.species.toLowerCase() === 'broiler'
      ? estimateBroilerWeightKg(daysSinceStart)
      : 1.0

  const totalLiveWeightKg = batch.headCount * estimatedWeightPerBird
  const startWeightKg = startCount * CHICK_START_WEIGHT_KG
  const weightGainKg = Math.max(0, totalLiveWeightKg - startWeightKg)
  const fcr = weightGainKg > 0 ? Math.round((feedUsedKg / weightGainKg) * 100) / 100 : null

  return c.json({
    batchId: batch.id,
    batchName: batch.name,
    feedUsedKg,
    startCount,
    currentHeadCount: batch.headCount,
    daysSinceStart,
    estimatedWeightPerBirdKg: Math.round(estimatedWeightPerBird * 100) / 100,
    weightGainKg: Math.round(weightGainKg * 100) / 100,
    fcr,
    targetCloseoutAt: batch.targetCloseoutAt,
  })
})

livestockRoutes.get('/batches/:id/vaccination-schedule', async (c) => {
  const user = c.get('user')
  const batchId = c.req.param('id')

  const [batch] = await db
    .select()
    .from(livestockBatches)
    .where(and(eq(livestockBatches.id, batchId), eq(livestockBatches.farmId, user.farmId)))
    .limit(1)

  if (!batch) return c.json({ error: 'Not found' }, 404)

  const isBroiler =
    batch.batchType === 'broiler' || batch.species.toLowerCase() === 'broiler'

  if (!isBroiler) {
    return c.json({ error: 'Vaccination schedule only available for broiler batches' }, 400)
  }

  const vaccinationLogs = await db
    .select()
    .from(livestockLogs)
    .where(
      and(
        eq(livestockLogs.batchId, batchId),
        eq(livestockLogs.logType, 'vaccination'),
      ),
    )
    .orderBy(livestockLogs.createdAt)

  const now = new Date()
  const startDate = batch.acquiredAt

  const schedule = BROILER_VACCINATION_SCHEDULE.map((entry) => {
    const dueDate = new Date(startDate.getTime() + entry.day * 86400000)
    const completed = vaccinationLogs.some((log) => {
      const logDay = Math.floor((log.createdAt.getTime() - startDate.getTime()) / 86400000)
      return Math.abs(logDay - entry.day) <= 1
    })

    let status: 'completed' | 'due' | 'upcoming' | 'overdue'
    if (completed) {
      status = 'completed'
    } else if (dueDate.toDateString() === now.toDateString()) {
      status = 'due'
    } else if (dueDate > now) {
      status = 'upcoming'
    } else {
      status = 'overdue'
    }

    return {
      day: entry.day,
      name: entry.name,
      vaccine: entry.vaccine,
      dueDate: dueDate.toISOString(),
      status,
    }
  })

  return c.json({
    batchId: batch.id,
    batchName: batch.name,
    acquiredAt: batch.acquiredAt,
    schedule,
    completedCount: schedule.filter((s) => s.status === 'completed').length,
  })
})

livestockRoutes.get('/batches/:id', async (c) => {
  const user = c.get('user')
  const batchId = c.req.param('id')

  const [batch] = await db
    .select({
      id: livestockBatches.id,
      name: livestockBatches.name,
      species: livestockBatches.species,
      headCount: livestockBatches.headCount,
      plotId: livestockBatches.plotId,
      plotName: plots.name,
      acquiredAt: livestockBatches.acquiredAt,
      notes: livestockBatches.notes,
      active: livestockBatches.active,
      createdAt: livestockBatches.createdAt,
    })
    .from(livestockBatches)
    .leftJoin(plots, eq(livestockBatches.plotId, plots.id))
    .where(and(eq(livestockBatches.id, batchId), eq(livestockBatches.farmId, user.farmId)))
    .limit(1)

  if (!batch) return c.json({ error: 'Not found' }, 404)

  return c.json({ batch })
})

livestockRoutes.post('/batches', zValidator('json', createBatchSchema), async (c) => {
  const user = c.get('user')
  if (!canAssignTasks(user)) return c.json({ error: 'Forbidden' }, 403)

  const body = c.req.valid('json')

  if (body.plotId) {
    const [plot] = await db
      .select()
      .from(plots)
      .where(and(eq(plots.id, body.plotId), eq(plots.farmId, user.farmId)))
      .limit(1)
    if (!plot) return c.json({ error: 'Invalid plot' }, 400)
  }

  const [batch] = await db
    .insert(livestockBatches)
    .values({
      farmId: user.farmId,
      name: body.name,
      species: body.species,
      headCount: body.headCount,
      plotId: body.plotId,
      acquiredAt: new Date(body.acquiredAt),
      notes: body.notes,
    })
    .returning()

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'create',
    entityType: 'livestock_batch',
    entityId: batch.id,
  })

  return c.json({ batch }, 201)
})

livestockRoutes.patch('/batches/:id', zValidator('json', updateBatchSchema), async (c) => {
  const user = c.get('user')
  if (!canAssignTasks(user)) return c.json({ error: 'Forbidden' }, 403)

  const batchId = c.req.param('id')
  const body = c.req.valid('json')

  const [existing] = await db
    .select()
    .from(livestockBatches)
    .where(and(eq(livestockBatches.id, batchId), eq(livestockBatches.farmId, user.farmId)))
    .limit(1)

  if (!existing) return c.json({ error: 'Not found' }, 404)

  if (body.plotId) {
    const [plot] = await db
      .select()
      .from(plots)
      .where(and(eq(plots.id, body.plotId), eq(plots.farmId, user.farmId)))
      .limit(1)
    if (!plot) return c.json({ error: 'Invalid plot' }, 400)
  }

  const updates: Partial<typeof existing> = {}
  if (body.name !== undefined) updates.name = body.name
  if (body.species !== undefined) updates.species = body.species
  if (body.headCount !== undefined) updates.headCount = body.headCount
  if (body.plotId !== undefined) updates.plotId = body.plotId
  if (body.notes !== undefined) updates.notes = body.notes
  if (body.active !== undefined) updates.active = body.active

  const [batch] = await db
    .update(livestockBatches)
    .set(updates)
    .where(eq(livestockBatches.id, batchId))
    .returning()

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'update',
    entityType: 'livestock_batch',
    entityId: batchId,
  })

  return c.json({ batch })
})

livestockRoutes.delete('/batches/:id', async (c) => {
  const user = c.get('user')
  if (!canAssignTasks(user)) return c.json({ error: 'Forbidden' }, 403)

  const batchId = c.req.param('id')

  const [existing] = await db
    .select()
    .from(livestockBatches)
    .where(and(eq(livestockBatches.id, batchId), eq(livestockBatches.farmId, user.farmId)))
    .limit(1)

  if (!existing) return c.json({ error: 'Not found' }, 404)

  await db
    .update(livestockBatches)
    .set({ active: false })
    .where(eq(livestockBatches.id, batchId))

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'deactivate',
    entityType: 'livestock_batch',
    entityId: batchId,
  })

  return c.json({ ok: true })
})

livestockRoutes.get('/batches/:id/logs', async (c) => {
  const user = c.get('user')
  const batchId = c.req.param('id')

  const [batch] = await db
    .select()
    .from(livestockBatches)
    .where(and(eq(livestockBatches.id, batchId), eq(livestockBatches.farmId, user.farmId)))
    .limit(1)

  if (!batch) return c.json({ error: 'Not found' }, 404)

  const logs = await db
    .select()
    .from(livestockLogs)
    .where(and(eq(livestockLogs.batchId, batchId), eq(livestockLogs.farmId, user.farmId)))
    .orderBy(desc(livestockLogs.createdAt))

  return c.json({ logs })
})

livestockRoutes.post('/batches/:id/logs', zValidator('json', createLogSchema), async (c) => {
  const user = c.get('user')
  const batchId = c.req.param('id')
  const body = c.req.valid('json')

  const [batch] = await db
    .select()
    .from(livestockBatches)
    .where(and(eq(livestockBatches.id, batchId), eq(livestockBatches.farmId, user.farmId)))
    .limit(1)

  if (!batch) return c.json({ error: 'Not found' }, 404)
  if (!batch.active) return c.json({ error: 'Batch is inactive' }, 400)

  if (body.logType === 'mortality') {
    if (!body.headCount) return c.json({ error: 'headCount required for mortality' }, 400)
    if (body.headCount > batch.headCount) {
      return c.json({ error: 'Mortality count exceeds batch head count' }, 400)
    }
  }

  const log = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(livestockLogs)
      .values({
        farmId: user.farmId,
        batchId,
        logType: body.logType,
        headCount: body.headCount,
        notes: body.notes,
        recordedById: user.id,
      })
      .returning()

    if (body.logType === 'mortality' && body.headCount) {
      await tx
        .update(livestockBatches)
        .set({ headCount: batch.headCount - body.headCount })
        .where(eq(livestockBatches.id, batchId))
    }

    return row
  })

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'create',
    entityType: 'livestock_log',
    entityId: log.id,
    metadata: { logType: body.logType, batchId },
  })

  return c.json({ log }, 201)
})
