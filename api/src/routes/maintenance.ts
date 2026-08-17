import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import {
  assetEvents,
  assets,
  contractors,
  maintenanceWorkOrders,
  users,
} from '../db/schema.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { hasPermission, requirePermission } from '../lib/rbac.js'
import { logAudit } from '../lib/audit.js'
import { processEvidenceValue, validateEvidenceRef } from '../lib/evidence-store.js'

const createSchema = z.object({
  assetId: z.string().uuid(),
  contractorId: z.string().uuid().nullable().optional(),
  assignedToId: z.string().uuid().nullable().optional(),
  title: z.string().trim().min(2).max(200),
  description: z.string().trim().max(2000).nullable().optional(),
  serviceType: z.enum(['preventive', 'inspection', 'repair', 'replacement']).default('preventive'),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  dueAt: z.string().datetime().nullable().optional(),
  checklist: z.array(z.string().trim().min(1).max(200)).max(30).default([]),
  estimatedCostMinor: z.number().int().min(0).nullable().optional(),
})

const updateSchema = z.object({
  status: z.enum(['open', 'in_progress', 'completed', 'cancelled']),
  completionNotes: z.string().trim().max(2000).nullable().optional(),
  partsUsed: z.string().trim().max(1000).nullable().optional(),
  actualCostMinor: z.number().int().min(0).nullable().optional(),
  downtimeMinutes: z.number().int().min(0).max(525_600).nullable().optional(),
  meterReading: z.number().int().min(0).nullable().optional(),
  evidenceUrl: z.string().max(2_000_000).nullable().optional(),
  completedChecklist: z.array(z.string().trim().min(1).max(200)).max(30).optional(),
})

export const maintenanceRoutes = new Hono<{ Variables: AppVariables }>()
maintenanceRoutes.use('*', authMiddleware)

maintenanceRoutes.get('/', async (c) => {
  const user = c.get('user')
  requirePermission(user, 'maintenance.read')

  const [orders, farmAssets, farmUsers, farmContractors] = await Promise.all([
    db.select().from(maintenanceWorkOrders)
      .where(eq(maintenanceWorkOrders.farmId, user.farmId))
      .orderBy(desc(maintenanceWorkOrders.createdAt)),
    db.select({ id: assets.id, name: assets.name, assetTag: assets.assetTag, nextServiceAt: assets.nextServiceAt })
      .from(assets).where(eq(assets.farmId, user.farmId)),
    db.select({ id: users.id, name: users.name }).from(users).where(eq(users.farmId, user.farmId)),
    db.select({ id: contractors.id, name: contractors.name, company: contractors.company })
      .from(contractors).where(eq(contractors.farmId, user.farmId)),
  ])
  const assetMap = new Map(farmAssets.map((row) => [row.id, row]))
  const userMap = new Map(farmUsers.map((row) => [row.id, row.name]))
  const contractorMap = new Map(farmContractors.map((row) => [row.id, row]))

  return c.json({
    workOrders: orders.map((row) => ({
      ...row,
      asset: assetMap.get(row.assetId) ?? null,
      assignedToName: row.assignedToId ? userMap.get(row.assignedToId) ?? null : null,
      contractor: row.contractorId ? contractorMap.get(row.contractorId) ?? null : null,
    })),
    assets: farmAssets,
    staff: farmUsers,
    contractors: farmContractors,
  })
})

maintenanceRoutes.post('/', zValidator('json', createSchema), async (c) => {
  const user = c.get('user')
  requirePermission(user, 'maintenance.write')
  const body = c.req.valid('json')

  const [asset] = await db.select({ id: assets.id }).from(assets)
    .where(and(eq(assets.id, body.assetId), eq(assets.farmId, user.farmId))).limit(1)
  if (!asset) return c.json({ error: 'Invalid equipment' }, 400)

  if (body.assignedToId) {
    const [member] = await db.select({ id: users.id }).from(users)
      .where(and(eq(users.id, body.assignedToId), eq(users.farmId, user.farmId))).limit(1)
    if (!member) return c.json({ error: 'Invalid assignee' }, 400)
  }
  if (body.contractorId) {
    const [contractor] = await db.select({ id: contractors.id }).from(contractors)
      .where(and(eq(contractors.id, body.contractorId), eq(contractors.farmId, user.farmId))).limit(1)
    if (!contractor) return c.json({ error: 'Invalid contractor' }, 400)
  }

  const [workOrder] = await db.insert(maintenanceWorkOrders).values({
    farmId: user.farmId,
    assetId: body.assetId,
    contractorId: body.contractorId ?? null,
    assignedToId: body.assignedToId ?? null,
    title: body.title,
    description: body.description ?? null,
    serviceType: body.serviceType,
    priority: body.priority,
    dueAt: body.dueAt ? new Date(body.dueAt) : null,
    checklist: body.checklist,
    estimatedCostMinor: body.estimatedCostMinor ?? null,
    createdById: user.id,
  }).returning()

  await logAudit({ farmId: user.farmId, userId: user.id, action: 'create', entityType: 'maintenance_work_order', entityId: workOrder.id })
  return c.json({ workOrder }, 201)
})

maintenanceRoutes.patch('/:id/status', zValidator('json', updateSchema), async (c) => {
  const user = c.get('user')
  const body = c.req.valid('json')
  const [existing] = await db.select().from(maintenanceWorkOrders)
    .where(and(eq(maintenanceWorkOrders.id, c.req.param('id')), eq(maintenanceWorkOrders.farmId, user.farmId))).limit(1)
  if (!existing) return c.json({ error: 'Not found' }, 404)

  const manager = hasPermission(user, 'maintenance.write')
  const workerCanAct = hasPermission(user, 'maintenance.complete') &&
    (!existing.assignedToId || existing.assignedToId === user.id) &&
    ['in_progress', 'completed'].includes(body.status)
  if (!manager && !workerCanAct) return c.json({ error: 'Forbidden' }, 403)

  if (['completed', 'cancelled'].includes(existing.status)) {
    return c.json({ error: 'Closed work orders cannot be changed' }, 409)
  }

  const completedChecklist = body.completedChecklist ?? []
  if (body.status === 'completed' && !(body.completionNotes ?? existing.completionNotes)?.trim()) {
    return c.json({ error: 'A completion note is required before closing the work' }, 400)
  }
  if (body.status === 'completed' && existing.checklist.some((item) => !completedChecklist.includes(item))) {
    return c.json({ error: 'Complete every checklist item before closing the work' }, 400)
  }

  let evidenceUrl = body.evidenceUrl ?? null
  if (evidenceUrl) {
    if (!validateEvidenceRef(evidenceUrl)) return c.json({ error: 'Invalid evidence URL' }, 400)
    try {
      evidenceUrl = (await processEvidenceValue(user.farmId, evidenceUrl)) ?? null
    } catch {
      return c.json({ error: 'Could not store maintenance evidence' }, 400)
    }
  }

  const now = new Date()
  const patch = {
    status: body.status,
    startedAt: body.status === 'in_progress' && !existing.startedAt ? now : existing.startedAt,
    completedAt: body.status === 'completed' ? now : existing.completedAt,
    completedById: body.status === 'completed' ? user.id : existing.completedById,
    completionNotes: body.completionNotes ?? existing.completionNotes,
    partsUsed: body.partsUsed ?? existing.partsUsed,
    actualCostMinor: body.actualCostMinor ?? existing.actualCostMinor,
    downtimeMinutes: body.downtimeMinutes ?? existing.downtimeMinutes,
    meterReading: body.meterReading ?? existing.meterReading,
    evidenceUrl: evidenceUrl ?? existing.evidenceUrl,
    completedChecklist: body.status === 'completed' ? completedChecklist : existing.completedChecklist,
    updatedAt: now,
  }
  const [workOrder] = await db.update(maintenanceWorkOrders).set(patch)
    .where(eq(maintenanceWorkOrders.id, existing.id)).returning()

  if (body.status === 'completed' && existing.status !== 'completed') {
    const [asset] = await db.select().from(assets)
      .where(and(eq(assets.id, existing.assetId), eq(assets.farmId, user.farmId))).limit(1)
    await db.insert(assetEvents).values({
      farmId: user.farmId,
      assetId: existing.assetId,
      eventType: existing.serviceType === 'repair' ? 'repair' : 'service',
      eventDate: now,
      costMinor: body.actualCostMinor ?? null,
      notes: body.completionNotes ?? existing.title,
      evidenceUrl,
      recordedById: user.id,
    })
    if (asset?.maintenanceIntervalDays && asset.maintenanceIntervalDays > 0) {
      const next = new Date(now)
      next.setUTCDate(next.getUTCDate() + asset.maintenanceIntervalDays)
      await db.update(assets).set({ nextServiceAt: next, updatedAt: now }).where(eq(assets.id, asset.id))
    }
  }

  await logAudit({ farmId: user.farmId, userId: user.id, action: `maintenance_${body.status}`, entityType: 'maintenance_work_order', entityId: existing.id })
  return c.json({ workOrder })
})
