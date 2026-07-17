import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { assetEvents, assets, assetLogs, users } from '../db/schema.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { canAssignTasks } from '../lib/rbac.js'
import { logAudit } from '../lib/audit.js'
import { recordFarmEvent } from '../lib/farm-events.js'
import { processEvidenceValue, validateEvidenceRef } from '../lib/evidence-store.js'

const ASSET_CATEGORIES = ['ppe', 'tool', 'vehicle', 'irrigation', 'other'] as const

const createAssetSchema = z.object({
  name: z.string().trim().min(1).max(200),
  category: z.enum(ASSET_CATEGORIES).default('other'),
  unit: z.string().trim().min(1).max(40).default('unit'),
  quantityOwned: z.number().int().min(0).default(0),
  trackingMode: z.enum(['pool', 'individual']).default('pool'),
  assetTag: z.string().trim().max(100).nullable().optional(),
  manufacturer: z.string().trim().max(200).nullable().optional(),
  model: z.string().trim().max(200).nullable().optional(),
  serialNumber: z.string().trim().max(200).nullable().optional(),
  acquisitionDate: z.string().datetime().nullable().optional(),
  acquisitionCostMinor: z.number().int().min(0).nullable().optional(),
  currency: z.string().trim().max(10).nullable().optional(),
  zoneId: z.string().uuid().nullable().optional(),
  plotId: z.string().uuid().nullable().optional(),
  locationText: z.string().trim().max(500).nullable().optional(),
  operationalStatus: z.string().trim().max(100).default('operational'),
  maintenanceIntervalDays: z.number().int().min(0).nullable().optional(),
  nextServiceAt: z.string().datetime().nullable().optional(),
  assignedToId: z.string().uuid().nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  active: z.boolean().default(true),
})

const updateAssetSchema = createAssetSchema.partial()

const createLogSchema = z.object({
  countAvailable: z.number().int().min(0),
  countDamaged: z.number().int().min(0).default(0),
  condition: z.string().trim().min(1).max(200).default('good'),
  note: z.string().max(2000).nullable().optional(),
  photoUrl: z.string().max(2_000_000).nullable().optional(),
})

const verifyLogSchema = z.object({
  status: z.enum(['verified', 'rejected']),
  note: z.string().max(2000).nullable().optional(),
})

const assetEventSchema = z.object({
  eventType: z.enum(['service', 'repair', 'inspection', 'transfer', 'disposal']),
  eventDate: z.string().datetime().optional(),
  costMinor: z.number().int().min(0).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  evidenceUrl: z.string().max(2_000_000).nullable().optional(),
})

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

export const assetRoutes = new Hono<{ Variables: AppVariables }>()

assetRoutes.use('*', authMiddleware)

// List the register with each asset's latest verified log summary. Visible to all staff.
assetRoutes.get('/', async (c) => {
  const user = c.get('user')

  const rows = await db
    .select({
      id: assets.id,
      name: assets.name,
      category: assets.category,
      unit: assets.unit,
      quantityOwned: assets.quantityOwned,
      trackingMode: assets.trackingMode,
      assetTag: assets.assetTag,
      manufacturer: assets.manufacturer,
      model: assets.model,
      serialNumber: assets.serialNumber,
      acquisitionDate: assets.acquisitionDate,
      acquisitionCostMinor: assets.acquisitionCostMinor,
      currency: assets.currency,
      zoneId: assets.zoneId,
      plotId: assets.plotId,
      locationText: assets.locationText,
      operationalStatus: assets.operationalStatus,
      maintenanceIntervalDays: assets.maintenanceIntervalDays,
      nextServiceAt: assets.nextServiceAt,
      disposedAt: assets.disposedAt,
      assignedToId: assets.assignedToId,
      assignedToName: users.name,
      notes: assets.notes,
      active: assets.active,
      createdAt: assets.createdAt,
    })
    .from(assets)
    .leftJoin(users, eq(assets.assignedToId, users.id))
    .where(eq(assets.farmId, user.farmId))
    .orderBy(desc(assets.active), assets.name)

  // Logs newest-first: first seen per asset is latest activity; first verified is trusted summary.
  const logs = await db
    .select({
      id: assetLogs.id,
      assetId: assetLogs.assetId,
      logDate: assetLogs.logDate,
      countAvailable: assetLogs.countAvailable,
      countDamaged: assetLogs.countDamaged,
      condition: assetLogs.condition,
      note: assetLogs.note,
      recordedById: assetLogs.recordedById,
      recordedByName: users.name,
      verificationStatus: assetLogs.verificationStatus,
      verifiedAt: assetLogs.verifiedAt,
      createdAt: assetLogs.createdAt,
    })
    .from(assetLogs)
    .leftJoin(users, eq(assetLogs.recordedById, users.id))
    .where(eq(assetLogs.farmId, user.farmId))
    .orderBy(desc(assetLogs.createdAt))

  const latestActivityByAsset = new Map<string, (typeof logs)[number]>()
  const latestVerifiedByAsset = new Map<string, (typeof logs)[number]>()
  for (const log of logs) {
    if (!latestActivityByAsset.has(log.assetId)) latestActivityByAsset.set(log.assetId, log)
    if (log.verificationStatus === 'verified' && !latestVerifiedByAsset.has(log.assetId)) {
      latestVerifiedByAsset.set(log.assetId, log)
    }
  }

  const now = new Date()
  const enriched = rows.map((asset) => {
    const activity = latestActivityByAsset.get(asset.id) ?? null
    const latestVerified = latestVerifiedByAsset.get(asset.id) ?? null
    const loggedToday = activity ? sameDay(new Date(activity.logDate), now) : false
    return {
      ...asset,
      latestLog: latestVerified,
      loggedToday,
      verifiedToday: loggedToday && activity?.verificationStatus === 'verified',
      todayVerificationStatus: loggedToday ? (activity?.verificationStatus ?? null) : null,
    }
  })

  return c.json({ assets: enriched })
})

assetRoutes.post('/', zValidator('json', createAssetSchema), async (c) => {
  const user = c.get('user')
  if (!canAssignTasks(user)) return c.json({ error: 'Forbidden' }, 403)

  const body = c.req.valid('json')

  if (body.assignedToId) {
    const [member] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, body.assignedToId), eq(users.farmId, user.farmId)))
      .limit(1)
    if (!member) return c.json({ error: 'Invalid assignee' }, 400)
  }

  const [asset] = await db
    .insert(assets)
    .values({
      farmId: user.farmId,
      name: body.name,
      category: body.category,
      unit: body.unit,
      quantityOwned: body.quantityOwned,
      trackingMode: body.trackingMode,
      assetTag: body.assetTag ?? null,
      manufacturer: body.manufacturer ?? null,
      model: body.model ?? null,
      serialNumber: body.serialNumber ?? null,
      acquisitionDate: body.acquisitionDate ? new Date(body.acquisitionDate) : null,
      acquisitionCostMinor: body.acquisitionCostMinor ?? null,
      currency: body.currency ?? 'NGN',
      zoneId: body.zoneId ?? null,
      plotId: body.plotId ?? null,
      locationText: body.locationText ?? null,
      operationalStatus: body.operationalStatus,
      maintenanceIntervalDays: body.maintenanceIntervalDays ?? null,
      nextServiceAt: body.nextServiceAt ? new Date(body.nextServiceAt) : null,
      assignedToId: body.assignedToId ?? null,
      notes: body.notes ?? null,
      active: body.active,
      createdById: user.id,
    })
    .returning()

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'create',
    entityType: 'asset',
    entityId: asset.id,
    metadata: { name: asset.name },
  })

  return c.json({ asset }, 201)
})

assetRoutes.patch('/:id', zValidator('json', updateAssetSchema), async (c) => {
  const user = c.get('user')
  if (!canAssignTasks(user)) return c.json({ error: 'Forbidden' }, 403)

  const assetId = c.req.param('id')
  const [existing] = await db
    .select()
    .from(assets)
    .where(and(eq(assets.id, assetId), eq(assets.farmId, user.farmId)))
    .limit(1)
  if (!existing) return c.json({ error: 'Not found' }, 404)

  const body = c.req.valid('json')

  if (body.assignedToId) {
    const [member] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, body.assignedToId), eq(users.farmId, user.farmId)))
      .limit(1)
    if (!member) return c.json({ error: 'Invalid assignee' }, 400)
  }

  const updates: Partial<typeof existing> = { updatedAt: new Date() }
  if (body.name !== undefined) updates.name = body.name
  if (body.category !== undefined) updates.category = body.category
  if (body.unit !== undefined) updates.unit = body.unit
  if (body.quantityOwned !== undefined) updates.quantityOwned = body.quantityOwned
  if (body.trackingMode !== undefined) updates.trackingMode = body.trackingMode
  if (body.assetTag !== undefined) updates.assetTag = body.assetTag
  if (body.manufacturer !== undefined) updates.manufacturer = body.manufacturer
  if (body.model !== undefined) updates.model = body.model
  if (body.serialNumber !== undefined) updates.serialNumber = body.serialNumber
  if (body.acquisitionDate !== undefined) {
    updates.acquisitionDate = body.acquisitionDate ? new Date(body.acquisitionDate) : null
  }
  if (body.acquisitionCostMinor !== undefined) {
    updates.acquisitionCostMinor = body.acquisitionCostMinor
  }
  if (body.currency !== undefined) updates.currency = body.currency
  if (body.zoneId !== undefined) updates.zoneId = body.zoneId
  if (body.plotId !== undefined) updates.plotId = body.plotId
  if (body.locationText !== undefined) updates.locationText = body.locationText
  if (body.operationalStatus !== undefined) updates.operationalStatus = body.operationalStatus
  if (body.maintenanceIntervalDays !== undefined) {
    updates.maintenanceIntervalDays = body.maintenanceIntervalDays
  }
  if (body.nextServiceAt !== undefined) {
    updates.nextServiceAt = body.nextServiceAt ? new Date(body.nextServiceAt) : null
  }
  if (body.assignedToId !== undefined) updates.assignedToId = body.assignedToId
  if (body.notes !== undefined) updates.notes = body.notes
  if (body.active !== undefined) updates.active = body.active

  const [asset] = await db
    .update(assets)
    .set(updates)
    .where(eq(assets.id, assetId))
    .returning()

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'update',
    entityType: 'asset',
    entityId: assetId,
    metadata: { name: asset.name },
  })

  return c.json({ asset })
})

assetRoutes.get('/:id/logs', async (c) => {
  const user = c.get('user')
  const assetId = c.req.param('id')

  const [asset] = await db
    .select({ id: assets.id })
    .from(assets)
    .where(and(eq(assets.id, assetId), eq(assets.farmId, user.farmId)))
    .limit(1)
  if (!asset) return c.json({ error: 'Not found' }, 404)

  const rows = await db
    .select({
      id: assetLogs.id,
      logDate: assetLogs.logDate,
      countAvailable: assetLogs.countAvailable,
      countDamaged: assetLogs.countDamaged,
      condition: assetLogs.condition,
      note: assetLogs.note,
      photoUrl: assetLogs.photoUrl,
      recordedById: assetLogs.recordedById,
      recordedByName: users.name,
      verificationStatus: assetLogs.verificationStatus,
      verifiedById: assetLogs.verifiedById,
      verifiedAt: assetLogs.verifiedAt,
      createdAt: assetLogs.createdAt,
    })
    .from(assetLogs)
    .leftJoin(users, eq(assetLogs.recordedById, users.id))
    .where(and(eq(assetLogs.assetId, assetId), eq(assetLogs.farmId, user.farmId)))
    .orderBy(desc(assetLogs.createdAt))

  return c.json({ logs: rows })
})

// Any staff (incl. field workers) can record a daily log for an asset.
assetRoutes.post('/:id/logs', zValidator('json', createLogSchema), async (c) => {
  const user = c.get('user')
  const assetId = c.req.param('id')

  const [asset] = await db
    .select()
    .from(assets)
    .where(and(eq(assets.id, assetId), eq(assets.farmId, user.farmId)))
    .limit(1)
  if (!asset) return c.json({ error: 'Not found' }, 404)

  const body = c.req.valid('json')

  if (body.countAvailable + body.countDamaged > asset.quantityOwned) {
    return c.json(
      { error: 'Available and damaged counts cannot exceed quantity owned' },
      400,
    )
  }

  let photoUrl = body.photoUrl ?? null
  if (photoUrl !== null && photoUrl !== '') {
    if (!validateEvidenceRef(photoUrl)) {
      return c.json({ error: 'Invalid photo evidence URL' }, 400)
    }
    try {
      photoUrl = (await processEvidenceValue(user.farmId, photoUrl)) ?? null
    } catch {
      return c.json({ error: 'Invalid photo evidence URL' }, 400)
    }
  } else {
    photoUrl = photoUrl === '' ? null : photoUrl
  }

  // Supervisor/owner logs are trusted (verified); worker logs need verification.
  const trusted = canAssignTasks(user)

  const [log] = await db
    .insert(assetLogs)
    .values({
      farmId: user.farmId,
      assetId,
      countAvailable: body.countAvailable,
      countDamaged: body.countDamaged,
      condition: body.condition,
      note: body.note ?? null,
      photoUrl,
      recordedById: user.id,
      verificationStatus: trusted ? 'verified' : 'reported',
      verifiedById: trusted ? user.id : null,
      verifiedAt: trusted ? new Date() : null,
    })
    .returning()

  await recordFarmEvent({
    farmId: user.farmId,
    actorUserId: user.id,
    entityType: 'asset',
    entityId: assetId,
    eventType: 'other',
    afterValue: {
      countAvailable: log.countAvailable,
      countDamaged: log.countDamaged,
      condition: log.condition,
    },
    metadata: { assetName: asset.name, kind: 'asset_log' },
  })

  return c.json({ log }, 201)
})

// Supervisor/owner verify (or reject) a reported daily log.
assetRoutes.post('/logs/:logId/verify', zValidator('json', verifyLogSchema), async (c) => {
  const user = c.get('user')
  if (!canAssignTasks(user)) return c.json({ error: 'Forbidden' }, 403)

  const logId = c.req.param('logId')
  const body = c.req.valid('json')

  const [existing] = await db
    .select()
    .from(assetLogs)
    .where(and(eq(assetLogs.id, logId), eq(assetLogs.farmId, user.farmId)))
    .limit(1)
  if (!existing) return c.json({ error: 'Not found' }, 404)

  const [log] = await db
    .update(assetLogs)
    .set({
      verificationStatus: body.status,
      verifiedById: user.id,
      verifiedAt: new Date(),
      note: body.note ?? existing.note,
    })
    .where(eq(assetLogs.id, logId))
    .returning()

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'update',
    entityType: 'asset_log',
    entityId: logId,
    metadata: { status: body.status },
  })

  return c.json({ log })
})

assetRoutes.get('/:id/events', async (c) => {
  const user = c.get('user')
  const assetId = c.req.param('id')
  const [asset] = await db
    .select({ id: assets.id })
    .from(assets)
    .where(and(eq(assets.id, assetId), eq(assets.farmId, user.farmId)))
    .limit(1)
  if (!asset) return c.json({ error: 'Not found' }, 404)

  const events = await db
    .select()
    .from(assetEvents)
    .where(and(eq(assetEvents.assetId, assetId), eq(assetEvents.farmId, user.farmId)))
    .orderBy(desc(assetEvents.eventDate))

  return c.json({ events })
})

assetRoutes.post('/:id/events', zValidator('json', assetEventSchema), async (c) => {
  const user = c.get('user')
  if (!canAssignTasks(user)) return c.json({ error: 'Forbidden' }, 403)

  const assetId = c.req.param('id')
  const body = c.req.valid('json')
  const [asset] = await db
    .select()
    .from(assets)
    .where(and(eq(assets.id, assetId), eq(assets.farmId, user.farmId)))
    .limit(1)
  if (!asset) return c.json({ error: 'Not found' }, 404)

  let evidenceUrl = body.evidenceUrl ?? null
  if (evidenceUrl) {
    if (!validateEvidenceRef(evidenceUrl)) {
      return c.json({ error: 'Invalid evidence URL' }, 400)
    }
    evidenceUrl = (await processEvidenceValue(user.farmId, evidenceUrl)) ?? null
  }

  const eventDate = body.eventDate ? new Date(body.eventDate) : new Date()

  const [event] = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(assetEvents)
      .values({
        assetId,
        farmId: user.farmId,
        eventType: body.eventType,
        eventDate,
        costMinor: body.costMinor ?? null,
        notes: body.notes ?? null,
        evidenceUrl,
        recordedById: user.id,
      })
      .returning()

    if (body.eventType === 'disposal') {
      await tx
        .update(assets)
        .set({
          disposedAt: eventDate,
          operationalStatus: 'disposed',
          active: false,
          updatedAt: new Date(),
        })
        .where(eq(assets.id, assetId))
    }

    return [row]
  })

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'asset_event',
    entityType: 'asset',
    entityId: assetId,
    metadata: { eventType: body.eventType },
  })

  return c.json({ event }, 201)
})