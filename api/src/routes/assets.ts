import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { assets, assetLogs, users } from '../db/schema.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { canAssignTasks } from '../lib/rbac.js'
import { logAudit } from '../lib/audit.js'
import { recordFarmEvent } from '../lib/farm-events.js'
import { validateEvidenceDataUrl } from '../lib/evidence-url.js'

const ASSET_CATEGORIES = ['ppe', 'tool', 'vehicle', 'irrigation', 'other'] as const

const createAssetSchema = z.object({
  name: z.string().trim().min(1).max(200),
  category: z.enum(ASSET_CATEGORIES).default('other'),
  unit: z.string().trim().min(1).max(40).default('unit'),
  quantityOwned: z.number().int().min(0).default(0),
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

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

export const assetRoutes = new Hono<{ Variables: AppVariables }>()

assetRoutes.use('*', authMiddleware)

// List the register with each asset's latest log summary. Visible to all staff.
assetRoutes.get('/', async (c) => {
  const user = c.get('user')

  const rows = await db
    .select({
      id: assets.id,
      name: assets.name,
      category: assets.category,
      unit: assets.unit,
      quantityOwned: assets.quantityOwned,
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

  // Latest log per asset: fetch farm logs newest-first, keep the first seen.
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

  const latestByAsset = new Map<string, (typeof logs)[number]>()
  for (const log of logs) {
    if (!latestByAsset.has(log.assetId)) latestByAsset.set(log.assetId, log)
  }

  const now = new Date()
  const enriched = rows.map((asset) => {
    const latest = latestByAsset.get(asset.id) ?? null
    const loggedToday = latest ? sameDay(new Date(latest.logDate), now) : false
    return {
      ...asset,
      latestLog: latest,
      loggedToday,
      verifiedToday: loggedToday && latest?.verificationStatus === 'verified',
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

  if (body.photoUrl && !validateEvidenceDataUrl(body.photoUrl)) {
    return c.json({ error: 'Invalid photo evidence URL' }, 400)
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
      photoUrl: body.photoUrl ?? null,
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
