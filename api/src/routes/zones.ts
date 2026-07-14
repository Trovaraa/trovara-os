import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, eq, inArray, or } from 'drizzle-orm'
import { db } from '../db/index.js'
import { cropCycles, farmEvents, plantingUnits, plots, tasks, zones } from '../db/schema.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { canAssignTasks } from '../lib/rbac.js'
import { logAudit } from '../lib/audit.js'

const createZoneSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
})

const updateZoneSchema = createZoneSchema.partial()

const createPlantingUnitSchema = z.object({
  plotId: z.string().uuid(),
  label: z.string().min(1).max(200),
  unitType: z.string().min(1).max(100),
  status: z.string().max(50).optional(),
  plantedAt: z.string().datetime().optional(),
})

const updatePlantingUnitSchema = createPlantingUnitSchema.partial().omit({ plotId: true })

export const zoneRoutes = new Hono<{ Variables: AppVariables }>()

zoneRoutes.use('*', authMiddleware)

zoneRoutes.get('/planting-units', async (c) => {
  const user = c.get('user')
  const plotId = c.req.query('plotId')

  const conditions = [eq(plantingUnits.farmId, user.farmId)]
  if (plotId) {
    conditions.push(eq(plantingUnits.plotId, plotId))
  }

  const rows = await db
    .select({
      id: plantingUnits.id,
      plotId: plantingUnits.plotId,
      plotName: plots.name,
      label: plantingUnits.label,
      unitType: plantingUnits.unitType,
      status: plantingUnits.status,
      plantedAt: plantingUnits.plantedAt,
      createdAt: plantingUnits.createdAt,
    })
    .from(plantingUnits)
    .leftJoin(plots, eq(plantingUnits.plotId, plots.id))
    .where(and(...conditions))
    .orderBy(plantingUnits.label)

  return c.json({ plantingUnits: rows })
})

zoneRoutes.post('/planting-units', zValidator('json', createPlantingUnitSchema), async (c) => {
  const user = c.get('user')
  if (!canAssignTasks(user)) return c.json({ error: 'Forbidden' }, 403)

  const body = c.req.valid('json')

  const [plot] = await db
    .select()
    .from(plots)
    .where(and(eq(plots.id, body.plotId), eq(plots.farmId, user.farmId)))
    .limit(1)

  if (!plot) return c.json({ error: 'Invalid plot' }, 400)

  const [unit] = await db
    .insert(plantingUnits)
    .values({
      farmId: user.farmId,
      plotId: body.plotId,
      label: body.label,
      unitType: body.unitType,
      status: body.status ?? 'active',
      plantedAt: body.plantedAt ? new Date(body.plantedAt) : undefined,
    })
    .returning()

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'create',
    entityType: 'planting_unit',
    entityId: unit.id,
  })

  return c.json({ plantingUnit: unit }, 201)
})

zoneRoutes.patch('/planting-units/:id', zValidator('json', updatePlantingUnitSchema), async (c) => {
  const user = c.get('user')
  if (!canAssignTasks(user)) return c.json({ error: 'Forbidden' }, 403)

  const unitId = c.req.param('id')
  const body = c.req.valid('json')

  const [existing] = await db
    .select()
    .from(plantingUnits)
    .where(and(eq(plantingUnits.id, unitId), eq(plantingUnits.farmId, user.farmId)))
    .limit(1)

  if (!existing) return c.json({ error: 'Not found' }, 404)

  const updates: Partial<typeof existing> = {}
  if (body.label !== undefined) updates.label = body.label
  if (body.unitType !== undefined) updates.unitType = body.unitType
  if (body.status !== undefined) updates.status = body.status
  if (body.plantedAt !== undefined) updates.plantedAt = new Date(body.plantedAt)

  const [unit] = await db
    .update(plantingUnits)
    .set(updates)
    .where(eq(plantingUnits.id, unitId))
    .returning()

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'update',
    entityType: 'planting_unit',
    entityId: unitId,
  })

  return c.json({ plantingUnit: unit })
})

zoneRoutes.delete('/planting-units/:id', async (c) => {
  const user = c.get('user')
  if (!canAssignTasks(user)) return c.json({ error: 'Forbidden' }, 403)

  const unitId = c.req.param('id')

  const [existing] = await db
    .select()
    .from(plantingUnits)
    .where(and(eq(plantingUnits.id, unitId), eq(plantingUnits.farmId, user.farmId)))
    .limit(1)

  if (!existing) return c.json({ error: 'Not found' }, 404)

  await db.delete(plantingUnits).where(eq(plantingUnits.id, unitId))

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'delete',
    entityType: 'planting_unit',
    entityId: unitId,
  })

  return c.json({ ok: true })
})

zoneRoutes.get('/plots', async (c) => {
  const user = c.get('user')

  const rows = await db
    .select({
      id: plots.id,
      name: plots.name,
      zoneId: plots.zoneId,
      zoneName: zones.name,
      cropType: plots.cropType,
      areaAcres: plots.areaAcres,
    })
    .from(plots)
    .leftJoin(zones, eq(plots.zoneId, zones.id))
    .where(eq(plots.farmId, user.farmId))
    .orderBy(plots.name)

  return c.json({ plots: rows })
})

zoneRoutes.get('/plots/:plotId/timeline', async (c) => {
  const user = c.get('user')
  const plotId = c.req.param('plotId')

  const [plot] = await db
    .select()
    .from(plots)
    .where(and(eq(plots.id, plotId), eq(plots.farmId, user.farmId)))
    .limit(1)

  if (!plot) return c.json({ error: 'Not found' }, 404)

  const plotTasks = await db
    .select({
      id: tasks.id,
      kind: tasks.status,
      title: tasks.title,
      status: tasks.status,
      eventType: tasks.status,
      createdAt: tasks.createdAt,
    })
    .from(tasks)
    .where(and(eq(tasks.farmId, user.farmId), eq(tasks.plotId, plotId)))

  const plotCropCycles = await db
    .select({ id: cropCycles.id })
    .from(cropCycles)
    .where(and(eq(cropCycles.farmId, user.farmId), eq(cropCycles.plotId, plotId)))

  const cycleIds = plotCropCycles.map((c) => c.id)
  const plotTaskIds = plotTasks.map((t) => t.id)

  const entityFilters = [
    and(eq(farmEvents.entityType, 'plot'), eq(farmEvents.entityId, plotId)),
  ]

  if (cycleIds.length > 0) {
    entityFilters.push(
      and(eq(farmEvents.entityType, 'crop_cycle'), inArray(farmEvents.entityId, cycleIds)),
    )
  }

  if (plotTaskIds.length > 0) {
    entityFilters.push(
      and(eq(farmEvents.entityType, 'task'), inArray(farmEvents.entityId, plotTaskIds)),
    )
  }

  const allEvents =
    entityFilters.length > 0
      ? await db
          .select({
            id: farmEvents.id,
            kind: farmEvents.eventType,
            title: farmEvents.eventType,
            status: farmEvents.approvalStatus,
            eventType: farmEvents.eventType,
            createdAt: farmEvents.createdAt,
          })
          .from(farmEvents)
          .where(and(eq(farmEvents.farmId, user.farmId), or(...entityFilters)))
      : []

  const timeline = [
    ...plotTasks.map((t) => ({
      id: t.id,
      type: 'task' as const,
      title: t.title,
      status: t.status,
      eventType: null as string | null,
      createdAt: t.createdAt,
    })),
    ...allEvents.map((e) => ({
      id: e.id,
      type: 'farm_event' as const,
      title: e.title,
      status: e.status,
      eventType: e.eventType,
      createdAt: e.createdAt,
    })),
  ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())

  return c.json({ plotId, timeline })
})

zoneRoutes.get('/', async (c) => {
  const user = c.get('user')

  const rows = await db
    .select()
    .from(zones)
    .where(eq(zones.farmId, user.farmId))
    .orderBy(zones.name)

  return c.json({ zones: rows })
})

zoneRoutes.get('/:id', async (c) => {
  const user = c.get('user')
  const zoneId = c.req.param('id')

  const [zone] = await db
    .select()
    .from(zones)
    .where(and(eq(zones.id, zoneId), eq(zones.farmId, user.farmId)))
    .limit(1)

  if (!zone) return c.json({ error: 'Not found' }, 404)

  return c.json({ zone })
})

zoneRoutes.post('/', zValidator('json', createZoneSchema), async (c) => {
  const user = c.get('user')
  if (!canAssignTasks(user)) return c.json({ error: 'Forbidden' }, 403)

  const body = c.req.valid('json')

  const [zone] = await db
    .insert(zones)
    .values({
      farmId: user.farmId,
      name: body.name,
      description: body.description,
    })
    .returning()

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'create',
    entityType: 'zone',
    entityId: zone.id,
  })

  return c.json({ zone }, 201)
})

zoneRoutes.patch('/:id', zValidator('json', updateZoneSchema), async (c) => {
  const user = c.get('user')
  if (!canAssignTasks(user)) return c.json({ error: 'Forbidden' }, 403)

  const zoneId = c.req.param('id')
  const body = c.req.valid('json')

  const [existing] = await db
    .select()
    .from(zones)
    .where(and(eq(zones.id, zoneId), eq(zones.farmId, user.farmId)))
    .limit(1)

  if (!existing) return c.json({ error: 'Not found' }, 404)

  const updates: Partial<typeof existing> = {}
  if (body.name !== undefined) updates.name = body.name
  if (body.description !== undefined) updates.description = body.description

  const [zone] = await db
    .update(zones)
    .set(updates)
    .where(eq(zones.id, zoneId))
    .returning()

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'update',
    entityType: 'zone',
    entityId: zoneId,
  })

  return c.json({ zone })
})

zoneRoutes.delete('/:id', async (c) => {
  const user = c.get('user')
  if (!canAssignTasks(user)) return c.json({ error: 'Forbidden' }, 403)

  const zoneId = c.req.param('id')

  const [existing] = await db
    .select()
    .from(zones)
    .where(and(eq(zones.id, zoneId), eq(zones.farmId, user.farmId)))
    .limit(1)

  if (!existing) return c.json({ error: 'Not found' }, 404)

  await db.delete(zones).where(eq(zones.id, zoneId))

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'delete',
    entityType: 'zone',
    entityId: zoneId,
  })

  return c.json({ ok: true })
})
