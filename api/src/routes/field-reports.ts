import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { fieldReports, users } from '../db/schema.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { canApproveTasks, hasPermission, requirePermission } from '../lib/rbac.js'
import { logAudit } from '../lib/audit.js'
import { notifyWorkerAlertChannels } from '../lib/farm-notify.js'
import { validateEvidenceDataUrl } from '../lib/evidence-url.js'

const createSchema = z.object({
  category: z.enum(['observation', 'crop', 'livestock', 'equipment', 'safety', 'theft', 'other']),
  severity: z.enum(['normal', 'urgent', 'critical']).default('normal'),
  description: z.string().trim().min(3).max(4000),
  plotId: z.string().uuid().nullable().optional(),
  batchId: z.string().uuid().nullable().optional(),
  assetId: z.string().uuid().nullable().optional(),
  photoUrl: z.string().max(2_000_000).nullable().optional(),
})

const updateSchema = z.object({
  status: z.enum(['open', 'in_progress', 'resolved', 'dismissed']),
  assignedToId: z.string().uuid().nullable().optional(),
})

export const fieldReportRoutes = new Hono<{ Variables: AppVariables }>()
fieldReportRoutes.use('*', authMiddleware)

fieldReportRoutes.get('/', async (c) => {
  const user = c.get('user')
  if (!hasPermission(user, 'field_reports.create') && !canApproveTasks(user)) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const rows = await db
    .select({
      id: fieldReports.id,
      category: fieldReports.category,
      severity: fieldReports.severity,
      description: fieldReports.description,
      photoUrl: fieldReports.photoUrl,
      status: fieldReports.status,
      createdById: fieldReports.createdById,
      createdByName: users.name,
      assignedToId: fieldReports.assignedToId,
      resolvedAt: fieldReports.resolvedAt,
      createdAt: fieldReports.createdAt,
      updatedAt: fieldReports.updatedAt,
    })
    .from(fieldReports)
    .innerJoin(users, eq(fieldReports.createdById, users.id))
    .where(
      canApproveTasks(user)
        ? eq(fieldReports.farmId, user.farmId)
        : and(eq(fieldReports.farmId, user.farmId), eq(fieldReports.createdById, user.id)),
    )
    .orderBy(desc(fieldReports.createdAt))
    .limit(100)

  return c.json({ reports: rows })
})

fieldReportRoutes.post('/', zValidator('json', createSchema), async (c) => {
  const user = c.get('user')
  requirePermission(user, 'field_reports.create')
  const body = c.req.valid('json')
  if (body.photoUrl && !validateEvidenceDataUrl(body.photoUrl)) {
    return c.json({ error: 'Invalid photo evidence URL' }, 400)
  }

  const [report] = await db
    .insert(fieldReports)
    .values({
      farmId: user.farmId,
      createdById: user.id,
      category: body.category,
      severity: body.severity,
      description: body.description,
      plotId: body.plotId ?? null,
      batchId: body.batchId ?? null,
      assetId: body.assetId ?? null,
      photoUrl: body.photoUrl ?? null,
    })
    .returning()

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'create',
    entityType: 'field_report',
    entityId: report.id,
    metadata: { category: report.category, severity: report.severity },
  })

  if (report.severity !== 'normal' || report.category === 'theft') {
    void notifyWorkerAlertChannels(
      user.farmId,
      `Urgent field report from ${user.name}: ${report.description.slice(0, 500)}`,
      { actorUserId: user.id, reason: 'field_report' },
    ).catch(() => undefined)
  }

  return c.json({ report }, 201)
})

fieldReportRoutes.patch('/:id', zValidator('json', updateSchema), async (c) => {
  const user = c.get('user')
  if (!canApproveTasks(user)) return c.json({ error: 'Forbidden' }, 403)
  const body = c.req.valid('json')
  const resolved = body.status === 'resolved'
  const [report] = await db
    .update(fieldReports)
    .set({
      status: body.status,
      assignedToId: body.assignedToId,
      resolvedById: resolved ? user.id : null,
      resolvedAt: resolved ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(and(eq(fieldReports.id, c.req.param('id')), eq(fieldReports.farmId, user.farmId)))
    .returning()
  if (!report) return c.json({ error: 'Not found' }, 404)

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'update',
    entityType: 'field_report',
    entityId: report.id,
    metadata: { status: report.status },
  })
  return c.json({ report })
})
