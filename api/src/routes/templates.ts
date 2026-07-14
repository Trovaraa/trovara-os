import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, desc, eq, lte } from 'drizzle-orm'
import { db } from '../db/index.js'
import { plots, recurringSchedules, taskTemplates, tasks, users } from '../db/schema.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { canAssignTasks } from '../lib/rbac.js'
import { logAudit } from '../lib/audit.js'
import { CROP_LIFECYCLES } from '../lib/crop-lifecycle.js'

const createTemplateSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  cropType: z.string().max(100).optional(),
  checklist: z.array(z.string()).optional(),
  defaultDurationHours: z.number().int().positive().optional(),
})

const updateTemplateSchema = createTemplateSchema.partial()

const createScheduleSchema = z.object({
  templateId: z.string().uuid(),
  recurrence: z.enum(['daily', 'weekly', 'monthly', 'crop_stage']),
  assignedToId: z.string().uuid().optional(),
  plotId: z.string().uuid().optional(),
  active: z.boolean().optional(),
  nextRunAt: z.string().datetime().optional(),
})

const updateScheduleSchema = createScheduleSchema.partial()

function computeNextRunAt(recurrence: 'daily' | 'weekly' | 'monthly' | 'crop_stage', from: Date): Date | null {
  const next = new Date(from)
  switch (recurrence) {
    case 'daily':
      next.setDate(next.getDate() + 1)
      return next
    case 'weekly':
      next.setDate(next.getDate() + 7)
      return next
    case 'monthly':
      next.setMonth(next.getMonth() + 1)
      return next
    case 'crop_stage':
      return null
  }
}

export const templateRoutes = new Hono<{ Variables: AppVariables }>()

templateRoutes.use('*', authMiddleware)

templateRoutes.get('/lifecycles', async (c) => {
  return c.json({ lifecycles: CROP_LIFECYCLES })
})

templateRoutes.get('/templates', async (c) => {
  const user = c.get('user')

  const rows = await db
    .select()
    .from(taskTemplates)
    .where(eq(taskTemplates.farmId, user.farmId))
    .orderBy(desc(taskTemplates.createdAt))

  return c.json({ templates: rows })
})

templateRoutes.get('/templates/:id', async (c) => {
  const user = c.get('user')
  const templateId = c.req.param('id')

  const [template] = await db
    .select()
    .from(taskTemplates)
    .where(and(eq(taskTemplates.id, templateId), eq(taskTemplates.farmId, user.farmId)))
    .limit(1)

  if (!template) return c.json({ error: 'Not found' }, 404)

  return c.json({ template })
})

templateRoutes.post('/templates', zValidator('json', createTemplateSchema), async (c) => {
  const user = c.get('user')
  if (!canAssignTasks(user)) return c.json({ error: 'Forbidden' }, 403)

  const body = c.req.valid('json')

  const [template] = await db
    .insert(taskTemplates)
    .values({
      farmId: user.farmId,
      name: body.name,
      description: body.description,
      cropType: body.cropType,
      checklist: body.checklist,
      defaultDurationHours: body.defaultDurationHours,
    })
    .returning()

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'create',
    entityType: 'task_template',
    entityId: template.id,
  })

  return c.json({ template }, 201)
})

templateRoutes.patch('/templates/:id', zValidator('json', updateTemplateSchema), async (c) => {
  const user = c.get('user')
  if (!canAssignTasks(user)) return c.json({ error: 'Forbidden' }, 403)

  const templateId = c.req.param('id')
  const body = c.req.valid('json')

  const [existing] = await db
    .select()
    .from(taskTemplates)
    .where(and(eq(taskTemplates.id, templateId), eq(taskTemplates.farmId, user.farmId)))
    .limit(1)

  if (!existing) return c.json({ error: 'Not found' }, 404)

  const updates: Partial<typeof existing> = {}
  if (body.name !== undefined) updates.name = body.name
  if (body.description !== undefined) updates.description = body.description
  if (body.cropType !== undefined) updates.cropType = body.cropType
  if (body.checklist !== undefined) updates.checklist = body.checklist
  if (body.defaultDurationHours !== undefined) updates.defaultDurationHours = body.defaultDurationHours

  const [template] = await db
    .update(taskTemplates)
    .set(updates)
    .where(eq(taskTemplates.id, templateId))
    .returning()

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'update',
    entityType: 'task_template',
    entityId: templateId,
  })

  return c.json({ template })
})

templateRoutes.delete('/templates/:id', async (c) => {
  const user = c.get('user')
  if (!canAssignTasks(user)) return c.json({ error: 'Forbidden' }, 403)

  const templateId = c.req.param('id')

  const [existing] = await db
    .select()
    .from(taskTemplates)
    .where(and(eq(taskTemplates.id, templateId), eq(taskTemplates.farmId, user.farmId)))
    .limit(1)

  if (!existing) return c.json({ error: 'Not found' }, 404)

  await db.delete(taskTemplates).where(eq(taskTemplates.id, templateId))

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'delete',
    entityType: 'task_template',
    entityId: templateId,
  })

  return c.json({ ok: true })
})

templateRoutes.get('/schedules', async (c) => {
  const user = c.get('user')

  const rows = await db
    .select({
      id: recurringSchedules.id,
      templateId: recurringSchedules.templateId,
      templateName: taskTemplates.name,
      recurrence: recurringSchedules.recurrence,
      assignedToId: recurringSchedules.assignedToId,
      assignedToName: users.name,
      plotId: recurringSchedules.plotId,
      plotName: plots.name,
      active: recurringSchedules.active,
      nextRunAt: recurringSchedules.nextRunAt,
      createdAt: recurringSchedules.createdAt,
    })
    .from(recurringSchedules)
    .leftJoin(taskTemplates, eq(recurringSchedules.templateId, taskTemplates.id))
    .leftJoin(users, eq(recurringSchedules.assignedToId, users.id))
    .leftJoin(plots, eq(recurringSchedules.plotId, plots.id))
    .where(eq(recurringSchedules.farmId, user.farmId))
    .orderBy(desc(recurringSchedules.createdAt))

  return c.json({ schedules: rows })
})

templateRoutes.post('/schedules', zValidator('json', createScheduleSchema), async (c) => {
  const user = c.get('user')
  if (!canAssignTasks(user)) return c.json({ error: 'Forbidden' }, 403)

  const body = c.req.valid('json')

  const [template] = await db
    .select()
    .from(taskTemplates)
    .where(and(eq(taskTemplates.id, body.templateId), eq(taskTemplates.farmId, user.farmId)))
    .limit(1)

  if (!template) return c.json({ error: 'Invalid template' }, 400)

  if (body.assignedToId) {
    const [assignee] = await db
      .select()
      .from(users)
      .where(and(eq(users.id, body.assignedToId), eq(users.farmId, user.farmId)))
      .limit(1)
    if (!assignee) return c.json({ error: 'Invalid assignee' }, 400)
  }

  if (body.plotId) {
    const [plot] = await db
      .select()
      .from(plots)
      .where(and(eq(plots.id, body.plotId), eq(plots.farmId, user.farmId)))
      .limit(1)
    if (!plot) return c.json({ error: 'Invalid plot' }, 400)
  }

  const [schedule] = await db
    .insert(recurringSchedules)
    .values({
      farmId: user.farmId,
      templateId: body.templateId,
      recurrence: body.recurrence,
      assignedToId: body.assignedToId,
      plotId: body.plotId,
      active: body.active ?? true,
      nextRunAt: body.nextRunAt ? new Date(body.nextRunAt) : new Date(),
    })
    .returning()

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'create',
    entityType: 'recurring_schedule',
    entityId: schedule.id,
  })

  return c.json({ schedule }, 201)
})

templateRoutes.patch('/schedules/:id', zValidator('json', updateScheduleSchema), async (c) => {
  const user = c.get('user')
  if (!canAssignTasks(user)) return c.json({ error: 'Forbidden' }, 403)

  const scheduleId = c.req.param('id')
  const body = c.req.valid('json')

  const [existing] = await db
    .select()
    .from(recurringSchedules)
    .where(and(eq(recurringSchedules.id, scheduleId), eq(recurringSchedules.farmId, user.farmId)))
    .limit(1)

  if (!existing) return c.json({ error: 'Not found' }, 404)

  if (body.templateId) {
    const [template] = await db
      .select()
      .from(taskTemplates)
      .where(and(eq(taskTemplates.id, body.templateId), eq(taskTemplates.farmId, user.farmId)))
      .limit(1)
    if (!template) return c.json({ error: 'Invalid template' }, 400)
  }

  if (body.assignedToId) {
    const [assignee] = await db
      .select()
      .from(users)
      .where(and(eq(users.id, body.assignedToId), eq(users.farmId, user.farmId)))
      .limit(1)
    if (!assignee) return c.json({ error: 'Invalid assignee' }, 400)
  }

  if (body.plotId) {
    const [plot] = await db
      .select()
      .from(plots)
      .where(and(eq(plots.id, body.plotId), eq(plots.farmId, user.farmId)))
      .limit(1)
    if (!plot) return c.json({ error: 'Invalid plot' }, 400)
  }

  const updates: Partial<typeof existing> = {}
  if (body.templateId !== undefined) updates.templateId = body.templateId
  if (body.recurrence !== undefined) updates.recurrence = body.recurrence
  if (body.assignedToId !== undefined) updates.assignedToId = body.assignedToId
  if (body.plotId !== undefined) updates.plotId = body.plotId
  if (body.active !== undefined) updates.active = body.active
  if (body.nextRunAt !== undefined) updates.nextRunAt = new Date(body.nextRunAt)

  const [schedule] = await db
    .update(recurringSchedules)
    .set(updates)
    .where(eq(recurringSchedules.id, scheduleId))
    .returning()

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'update',
    entityType: 'recurring_schedule',
    entityId: scheduleId,
  })

  return c.json({ schedule })
})

templateRoutes.delete('/schedules/:id', async (c) => {
  const user = c.get('user')
  if (!canAssignTasks(user)) return c.json({ error: 'Forbidden' }, 403)

  const scheduleId = c.req.param('id')

  const [existing] = await db
    .select()
    .from(recurringSchedules)
    .where(and(eq(recurringSchedules.id, scheduleId), eq(recurringSchedules.farmId, user.farmId)))
    .limit(1)

  if (!existing) return c.json({ error: 'Not found' }, 404)

  await db.delete(recurringSchedules).where(eq(recurringSchedules.id, scheduleId))

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'delete',
    entityType: 'recurring_schedule',
    entityId: scheduleId,
  })

  return c.json({ ok: true })
})

templateRoutes.post('/generate-tasks', async (c) => {
  const user = c.get('user')
  if (!canAssignTasks(user)) return c.json({ error: 'Forbidden' }, 403)

  const now = new Date()

  const dueSchedules = await db
    .select({
      schedule: recurringSchedules,
      template: taskTemplates,
    })
    .from(recurringSchedules)
    .innerJoin(taskTemplates, eq(recurringSchedules.templateId, taskTemplates.id))
    .where(
      and(
        eq(recurringSchedules.farmId, user.farmId),
        eq(recurringSchedules.active, true),
        lte(recurringSchedules.nextRunAt, now),
      ),
    )

  const createdTasks = []

  for (const { schedule, template } of dueSchedules) {
    const [task] = await db
      .insert(tasks)
      .values({
        farmId: user.farmId,
        title: template.name,
        description: template.description ?? undefined,
        templateId: template.id,
        plotId: schedule.plotId ?? undefined,
        assignedToId: schedule.assignedToId ?? undefined,
        createdById: user.id,
        status: 'pending',
        dueDate: now,
      })
      .returning()

    createdTasks.push(task)

    const nextRunAt = computeNextRunAt(schedule.recurrence, now)
    await db
      .update(recurringSchedules)
      .set({ nextRunAt })
      .where(eq(recurringSchedules.id, schedule.id))

    await logAudit({
      farmId: user.farmId,
      userId: user.id,
      action: 'create',
      entityType: 'task',
      entityId: task.id,
      metadata: { source: 'recurring_schedule', scheduleId: schedule.id },
    })
  }

  return c.json({ tasks: createdTasks, count: createdTasks.length })
})
