import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { cropCycles, plots } from '../db/schema.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { canAssignTasks } from '../lib/rbac.js'
import { logAudit } from '../lib/audit.js'
import { canAdvanceCropStage, type CropStage } from '../lib/state-machines.js'
import { recordFarmEvent } from '../lib/farm-events.js'

const cropStageSchema = z.enum([
  'planted',
  'germination',
  'vegetative',
  'flowering',
  'fruiting',
  'harvest_ready',
  'harvested',
])

const createCropSchema = z.object({
  plotId: z.string().uuid(),
  cropType: z.string().min(1).max(100),
  stage: cropStageSchema.optional(),
  plantedAt: z.string().datetime(),
  expectedHarvestAt: z.string().datetime().optional(),
  expectedYieldKg: z.number().int().positive().optional(),
  notes: z.string().max(2000).optional(),
})

const updateCropSchema = z.object({
  stage: cropStageSchema.optional(),
  expectedHarvestAt: z.string().datetime().optional(),
  actualHarvestAt: z.string().datetime().optional(),
  expectedYieldKg: z.number().int().positive().optional(),
  actualYieldKg: z.number().int().nonnegative().optional(),
  notes: z.string().max(2000).optional(),
  ownerOverride: z.boolean().optional(),
})

function cropStageEventType(stage: CropStage): 'planted' | 'harvested' | 'other' {
  if (stage === 'planted') return 'planted'
  if (stage === 'harvested') return 'harvested'
  return 'other'
}

export const cropRoutes = new Hono<{ Variables: AppVariables }>()

cropRoutes.use('*', authMiddleware)

cropRoutes.get('/', async (c) => {
  const user = c.get('user')

  const rows = await db
    .select({
      id: cropCycles.id,
      plotId: cropCycles.plotId,
      plotName: plots.name,
      cropType: cropCycles.cropType,
      stage: cropCycles.stage,
      plantedAt: cropCycles.plantedAt,
      expectedHarvestAt: cropCycles.expectedHarvestAt,
      actualHarvestAt: cropCycles.actualHarvestAt,
      expectedYieldKg: cropCycles.expectedYieldKg,
      actualYieldKg: cropCycles.actualYieldKg,
      notes: cropCycles.notes,
      createdAt: cropCycles.createdAt,
      updatedAt: cropCycles.updatedAt,
    })
    .from(cropCycles)
    .leftJoin(plots, eq(cropCycles.plotId, plots.id))
    .where(eq(cropCycles.farmId, user.farmId))
    .orderBy(desc(cropCycles.updatedAt))

  return c.json({ cropCycles: rows })
})

cropRoutes.get('/:id', async (c) => {
  const user = c.get('user')
  const cycleId = c.req.param('id')

  const [row] = await db
    .select({
      id: cropCycles.id,
      plotId: cropCycles.plotId,
      plotName: plots.name,
      cropType: cropCycles.cropType,
      stage: cropCycles.stage,
      plantedAt: cropCycles.plantedAt,
      expectedHarvestAt: cropCycles.expectedHarvestAt,
      actualHarvestAt: cropCycles.actualHarvestAt,
      expectedYieldKg: cropCycles.expectedYieldKg,
      actualYieldKg: cropCycles.actualYieldKg,
      notes: cropCycles.notes,
      createdAt: cropCycles.createdAt,
      updatedAt: cropCycles.updatedAt,
    })
    .from(cropCycles)
    .leftJoin(plots, eq(cropCycles.plotId, plots.id))
    .where(and(eq(cropCycles.id, cycleId), eq(cropCycles.farmId, user.farmId)))
    .limit(1)

  if (!row) return c.json({ error: 'Not found' }, 404)

  return c.json({ cropCycle: row })
})

cropRoutes.post('/', zValidator('json', createCropSchema), async (c) => {
  const user = c.get('user')
  if (!canAssignTasks(user)) return c.json({ error: 'Forbidden' }, 403)

  const body = c.req.valid('json')

  const [plot] = await db
    .select()
    .from(plots)
    .where(and(eq(plots.id, body.plotId), eq(plots.farmId, user.farmId)))
    .limit(1)

  if (!plot) return c.json({ error: 'Invalid plot' }, 400)

  const stage = body.stage ?? 'planted'

  const [cropCycle] = await db
    .insert(cropCycles)
    .values({
      farmId: user.farmId,
      plotId: body.plotId,
      cropType: body.cropType,
      stage,
      plantedAt: new Date(body.plantedAt),
      expectedHarvestAt: body.expectedHarvestAt ? new Date(body.expectedHarvestAt) : undefined,
      expectedYieldKg: body.expectedYieldKg,
      notes: body.notes,
    })
    .returning()

  await recordFarmEvent({
    farmId: user.farmId,
    actorUserId: user.id,
    entityType: 'crop_cycle',
    entityId: cropCycle.id,
    eventType: cropStageEventType(stage as CropStage),
    afterValue: { stage, cropType: body.cropType },
    metadata: { plotId: body.plotId },
  })

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'create',
    entityType: 'crop_cycle',
    entityId: cropCycle.id,
  })

  return c.json({ cropCycle }, 201)
})

cropRoutes.patch('/:id', zValidator('json', updateCropSchema), async (c) => {
  const user = c.get('user')
  if (!canAssignTasks(user)) return c.json({ error: 'Forbidden' }, 403)

  const cycleId = c.req.param('id')
  const body = c.req.valid('json')

  const [existing] = await db
    .select()
    .from(cropCycles)
    .where(and(eq(cropCycles.id, cycleId), eq(cropCycles.farmId, user.farmId)))
    .limit(1)

  if (!existing) return c.json({ error: 'Not found' }, 404)

  if (body.stage !== undefined) {
    const fromStage = existing.stage as CropStage
    const toStage = body.stage as CropStage

    if (
      !canAdvanceCropStage(fromStage, toStage, user.role, {
        ownerOverride: body.ownerOverride,
      })
    ) {
      return c.json({ error: 'Invalid stage transition' }, 400)
    }

    if (toStage === 'harvested' && body.actualYieldKg === undefined && !existing.actualYieldKg) {
      return c.json({ error: 'actualYieldKg required when setting harvested stage' }, 400)
    }
  }

  const updates: Partial<typeof existing> = { updatedAt: new Date() }

  if (body.stage !== undefined) updates.stage = body.stage
  if (body.expectedHarvestAt !== undefined) {
    updates.expectedHarvestAt = new Date(body.expectedHarvestAt)
  }
  if (body.actualHarvestAt !== undefined) {
    updates.actualHarvestAt = new Date(body.actualHarvestAt)
  }
  if (body.expectedYieldKg !== undefined) updates.expectedYieldKg = body.expectedYieldKg
  if (body.actualYieldKg !== undefined) updates.actualYieldKg = body.actualYieldKg
  if (body.notes !== undefined) updates.notes = body.notes

  if (body.stage === 'harvested' && !body.actualHarvestAt && !existing.actualHarvestAt) {
    updates.actualHarvestAt = new Date()
  }

  const [cropCycle] = await db
    .update(cropCycles)
    .set(updates)
    .where(eq(cropCycles.id, cycleId))
    .returning()

  if (body.stage !== undefined && body.stage !== existing.stage) {
    await recordFarmEvent({
      farmId: user.farmId,
      actorUserId: user.id,
      entityType: 'crop_cycle',
      entityId: cycleId,
      eventType: cropStageEventType(body.stage as CropStage),
      beforeValue: { stage: existing.stage },
      afterValue: { stage: cropCycle.stage, actualYieldKg: cropCycle.actualYieldKg },
      metadata: { plotId: existing.plotId },
    })
  }

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'update',
    entityType: 'crop_cycle',
    entityId: cycleId,
    metadata: { stage: cropCycle.stage },
  })

  return c.json({ cropCycle })
})

cropRoutes.delete('/:id', async (c) => {
  const user = c.get('user')
  if (!canAssignTasks(user)) return c.json({ error: 'Forbidden' }, 403)

  const cycleId = c.req.param('id')

  const [existing] = await db
    .select()
    .from(cropCycles)
    .where(and(eq(cropCycles.id, cycleId), eq(cropCycles.farmId, user.farmId)))
    .limit(1)

  if (!existing) return c.json({ error: 'Not found' }, 404)

  await db.delete(cropCycles).where(eq(cropCycles.id, cycleId))

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'delete',
    entityType: 'crop_cycle',
    entityId: cycleId,
  })

  return c.json({ ok: true })
})
