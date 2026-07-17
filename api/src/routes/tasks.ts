import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import {
  auditEvents,
  cropCycles,
  inventoryItems,
  inventoryMovements,
  plots,
  taskInventoryUsage,
  tasks,
  taskTemplates,
  users,
} from '../db/schema.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { canApproveTasks, canAssignTasks } from '../lib/rbac.js'
import { logAudit } from '../lib/audit.js'
import { canTransitionTask } from '../lib/state-machines.js'
import type { TaskStatus } from '../db/schema.js'
import { recordFarmEvent } from '../lib/farm-events.js'
import { processEvidenceValue, validateEvidenceRef } from '../lib/evidence-store.js'

const createTaskSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  plotId: z.string().uuid().optional(),
  assignedToId: z.string().uuid().optional(),
  templateId: z.string().uuid().optional(),
  dueDate: z.string().datetime().optional(),
  actionType: z.string().max(100).optional(),
  actionPayload: z.record(z.unknown()).optional(),
})

const updateTaskSchema = z
  .object({
    status: z.enum(['pending', 'in_progress', 'awaiting_approval', 'completed', 'rejected']).optional(),
    completionNote: z.string().max(2000).optional(),
    rejectionReason: z.string().trim().min(5).max(2000).optional(),
    photoUrl: z.string().max(2_000_000).optional(),
    voiceUrl: z.string().max(2_000_000).optional(),
    latitude: z.union([z.string().max(32), z.number()]).optional(),
    longitude: z.union([z.string().max(32), z.number()]).optional(),
    consumptions: z
      .array(
        z.object({
          itemId: z.string().uuid(),
          quantity: z.number().int().positive(),
        }),
      )
      .max(20)
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (value.status === 'rejected' && !value.rejectionReason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'rejectionReason is required when status is rejected',
        path: ['rejectionReason'],
      })
    }
  })

export const taskRoutes = new Hono<{ Variables: AppVariables }>()

taskRoutes.use('*', authMiddleware)

taskRoutes.get('/', async (c) => {
  const user = c.get('user')
  const rows = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      description: tasks.description,
      status: tasks.status,
      plotId: tasks.plotId,
      plotName: plots.name,
      templateId: tasks.templateId,
      actionType: tasks.actionType,
      actionPayload: tasks.actionPayload,
      photoUrl: tasks.photoUrl,
      voiceUrl: tasks.voiceUrl,
      latitude: tasks.latitude,
      longitude: tasks.longitude,
      assignedToId: tasks.assignedToId,
      assignedToName: users.name,
      dueDate: tasks.dueDate,
      completionNote: tasks.completionNote,
      rejectionReason: tasks.rejectionReason,
      approvedById: tasks.approvedById,
      createdAt: tasks.createdAt,
      updatedAt: tasks.updatedAt,
    })
    .from(tasks)
    .leftJoin(plots, eq(tasks.plotId, plots.id))
    .leftJoin(users, eq(tasks.assignedToId, users.id))
    .where(eq(tasks.farmId, user.farmId))
    .orderBy(desc(tasks.updatedAt))

  const filtered =
    user.role === 'field_worker'
      ? rows.filter((t) => t.assignedToId === user.id)
      : rows

  const taskIds = filtered.map((task) => task.id)
  const usageRows =
    taskIds.length === 0
      ? []
      : await db
          .select({
            taskId: taskInventoryUsage.taskId,
            itemId: taskInventoryUsage.itemId,
            quantity: taskInventoryUsage.quantity,
          })
          .from(taskInventoryUsage)
          .where(
            and(
              eq(taskInventoryUsage.farmId, user.farmId),
              inArray(taskInventoryUsage.taskId, taskIds),
            ),
          )

  const usageByTask = new Map<string, { itemId: string; quantity: number }[]>()
  for (const usage of usageRows) {
    const list = usageByTask.get(usage.taskId) ?? []
    list.push({ itemId: usage.itemId, quantity: usage.quantity })
    usageByTask.set(usage.taskId, list)
  }

  return c.json({
    tasks: filtered.map((task) => {
      const row = {
        ...task,
        consumptions: usageByTask.get(task.id) ?? [],
      }
      // Defense in depth: field workers must never see other workers' evidence.
      if (user.role === 'field_worker' && task.assignedToId !== user.id) {
        return { ...row, photoUrl: null, voiceUrl: null, completionNote: null }
      }
      return row
    }),
  })
})

taskRoutes.post('/', zValidator('json', createTaskSchema), async (c) => {
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

  if (body.assignedToId) {
    const [assignee] = await db
      .select()
      .from(users)
      .where(and(eq(users.id, body.assignedToId), eq(users.farmId, user.farmId)))
      .limit(1)
    if (!assignee) return c.json({ error: 'Invalid assignee' }, 400)
  }

  let actionType = body.actionType ?? null
  let actionPayload = body.actionPayload ?? null

  if (body.templateId) {
    const [template] = await db
      .select()
      .from(taskTemplates)
      .where(and(eq(taskTemplates.id, body.templateId), eq(taskTemplates.farmId, user.farmId)))
      .limit(1)
    if (!template) return c.json({ error: 'Invalid template' }, 400)
    if (!actionType && template.actionType) actionType = template.actionType
    if (!actionPayload && template.defaultPayload) {
      actionPayload = template.defaultPayload as Record<string, unknown>
    }
  }

  const [task] = await db
    .insert(tasks)
    .values({
      farmId: user.farmId,
      title: body.title,
      description: body.description,
      plotId: body.plotId,
      assignedToId: body.assignedToId,
      templateId: body.templateId,
      actionType,
      actionPayload,
      createdById: user.id,
      dueDate: body.dueDate ? new Date(body.dueDate) : undefined,
      status: 'pending',
    })
    .returning()

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'create',
    entityType: 'task',
    entityId: task.id,
  })

  return c.json({ task }, 201)
})

taskRoutes.patch('/:id', zValidator('json', updateTaskSchema), async (c) => {
  const user = c.get('user')
  const taskId = c.req.param('id')
  const body = c.req.valid('json')

  const [existing] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.farmId, user.farmId)))
    .limit(1)

  if (!existing) return c.json({ error: 'Not found' }, 404)

  const isOwnTask = existing.assignedToId === user.id
  const performedWorkSelf = isOwnTask && (user.role === 'supervisor' || user.role === 'owner')

  if (user.role === 'field_worker' && !isOwnTask) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const reopeningCompletedTask = existing.status === 'completed' && body.status === 'pending'
  if (existing.status === 'completed') {
    if (!(reopeningCompletedTask && user.role === 'owner')) {
      return c.json({ error: 'Completed tasks cannot be edited' }, 403)
    }

    const allowedFields = new Set(['status', 'rejectionReason'])
    const hasDisallowedChange = Object.keys(body).some((key) => !allowedFields.has(key))
    if (hasDisallowedChange) {
      return c.json({ error: 'Only status and rejectionReason may be set when reopening' }, 400)
    }
    if (!body.rejectionReason || body.rejectionReason.trim().length < 5) {
      return c.json({ error: 'Reopen reason must be at least 5 characters' }, 400)
    }
  }

  const updates: Partial<typeof existing> = { updatedAt: new Date() }

  if (body.completionNote !== undefined) {
    if (user.role === 'field_worker' || canAssignTasks(user)) {
      updates.completionNote = body.completionNote
    }
  }

  if (body.photoUrl !== undefined) {
    if (user.role === 'field_worker' || canAssignTasks(user)) {
      if (body.photoUrl !== null && body.photoUrl !== '' && !validateEvidenceRef(body.photoUrl)) {
        return c.json({ error: 'Invalid photo evidence URL' }, 400)
      }
      try {
        updates.photoUrl = await processEvidenceValue(user.farmId, body.photoUrl)
      } catch {
        return c.json({ error: 'Invalid photo evidence URL' }, 400)
      }
    }
  }

  if (body.voiceUrl !== undefined) {
    if (user.role === 'field_worker' || canAssignTasks(user)) {
      if (body.voiceUrl !== null && body.voiceUrl !== '' && !validateEvidenceRef(body.voiceUrl)) {
        return c.json({ error: 'Invalid voice evidence URL' }, 400)
      }
      try {
        updates.voiceUrl = await processEvidenceValue(user.farmId, body.voiceUrl)
      } catch {
        return c.json({ error: 'Invalid voice evidence URL' }, 400)
      }
    }
  }

  if (body.latitude !== undefined) {
    if (user.role === 'field_worker' || canAssignTasks(user)) {
      updates.latitude = String(body.latitude)
    }
  }

  if (body.longitude !== undefined) {
    if (user.role === 'field_worker' || canAssignTasks(user)) {
      updates.longitude = String(body.longitude)
    }
  }

  let consumptionEntries: { itemId: string; quantity: number }[] = []
  if (body.consumptions !== undefined) {
    if (!(user.role === 'field_worker' || canAssignTasks(user))) {
      return c.json({ error: 'Forbidden' }, 403)
    }
    const dedup = new Map<string, number>()
    for (const entry of body.consumptions) {
      dedup.set(entry.itemId, (dedup.get(entry.itemId) ?? 0) + entry.quantity)
    }
    consumptionEntries = [...dedup.entries()].map(([itemId, quantity]) => ({ itemId, quantity }))
  }

  if (body.status) {
    const fromStatus = existing.status as TaskStatus
    const toStatus = body.status as TaskStatus

    if (
      !canTransitionTask(fromStatus, toStatus, user.role, {
        isOwnTask,
        performedWorkSelf,
      })
    ) {
      return c.json({ error: 'Forbidden transition' }, 403)
    }

    updates.status = body.status

    if (body.status === 'completed' || body.status === 'rejected') {
      if (!canApproveTasks(user) && !(body.status === 'completed' && performedWorkSelf)) {
        return c.json({ error: 'Forbidden' }, 403)
      }
      updates.approvedById = user.id
      if (body.status === 'completed') updates.completedAt = new Date()
      if (body.status === 'completed') updates.rejectionReason = null
      if (body.status === 'rejected') updates.rejectionReason = body.rejectionReason
    }

    if (reopeningCompletedTask) {
      updates.completedAt = null
      updates.approvedById = null
      updates.rejectionReason = body.rejectionReason
    }
  }

  const transitionsToAwaitingApproval =
    body.status === 'awaiting_approval' && existing.status !== 'awaiting_approval'
  if (consumptionEntries.length > 0 && !transitionsToAwaitingApproval) {
    return c.json(
      { error: 'consumptions can only be submitted when moving to awaiting_approval' },
      400,
    )
  }

  let task: typeof existing
  try {
    if (transitionsToAwaitingApproval && consumptionEntries.length > 0) {
    task = await db.transaction(async (tx) => {
      const itemIds = consumptionEntries.map((entry) => entry.itemId)
      const existingItems = await tx
        .select({
          id: inventoryItems.id,
          quantity: inventoryItems.quantity,
        })
        .from(inventoryItems)
        .where(and(eq(inventoryItems.farmId, user.farmId), inArray(inventoryItems.id, itemIds)))

      if (existingItems.length !== itemIds.length) {
        throw new Error('INVALID_CONSUMPTION_ITEM')
      }

      const byId = new Map(existingItems.map((item) => [item.id, item]))
      for (const entry of consumptionEntries) {
        const item = byId.get(entry.itemId)
        if (!item || item.quantity < entry.quantity) {
          throw new Error('INSUFFICIENT_STOCK')
        }
      }

      const [updatedTask] = await tx
        .update(tasks)
        .set(updates)
        .where(and(eq(tasks.id, taskId), eq(tasks.farmId, user.farmId)))
        .returning()
      if (!updatedTask) throw new Error('TASK_NOT_FOUND')

      await tx.insert(taskInventoryUsage).values(
        consumptionEntries.map((entry) => ({
          taskId,
          itemId: entry.itemId,
          quantity: entry.quantity,
          farmId: user.farmId,
        })),
      )

      for (const entry of consumptionEntries) {
        const item = byId.get(entry.itemId)!
        await tx.insert(inventoryMovements).values({
          farmId: user.farmId,
          itemId: entry.itemId,
          delta: -entry.quantity,
          reason: 'task_consumption',
          recordedById: user.id,
        })
        await tx
          .update(inventoryItems)
          .set({
            quantity: item.quantity - entry.quantity,
            updatedAt: new Date(),
          })
          .where(eq(inventoryItems.id, entry.itemId))
      }

      return updatedTask
    })

    await logAudit({
      farmId: user.farmId,
      userId: user.id,
      action: 'task_inventory_consumption',
      entityType: 'task',
      entityId: taskId,
      metadata: { consumptions: consumptionEntries },
    })
    } else {
      const [updatedTask] = await db
        .update(tasks)
        .set(updates)
        .where(and(eq(tasks.id, taskId), eq(tasks.farmId, user.farmId)))
        .returning()
      if (!updatedTask) return c.json({ error: 'Not found' }, 404)
      task = updatedTask
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'INVALID_CONSUMPTION_ITEM') {
      return c.json({ error: 'Invalid inventory item in consumption list' }, 400)
    }
    if (error instanceof Error && error.message === 'INSUFFICIENT_STOCK') {
      return c.json({ error: 'Insufficient inventory for task consumption' }, 400)
    }
    if (error instanceof Error && error.message === 'TASK_NOT_FOUND') {
      return c.json({ error: 'Not found' }, 404)
    }
    throw error
  }

  if (body.status && body.status !== existing.status) {
    await recordFarmEvent({
      farmId: user.farmId,
      actorUserId: user.id,
      entityType: 'task',
      entityId: taskId,
      eventType: 'other',
      beforeValue: { status: existing.status },
      afterValue: { status: task.status },
      metadata: { plotId: task.plotId ?? undefined },
    })
  }

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'update',
    entityType: 'task',
    entityId: taskId,
    metadata: { status: task.status },
  })

  if (reopeningCompletedTask) {
    await logAudit({
      farmId: user.farmId,
      userId: user.id,
      action: 'reopen',
      entityType: 'task',
      entityId: taskId,
      metadata: {
        fromStatus: existing.status,
        toStatus: task.status,
        reason: body.rejectionReason,
      },
    })
  }

  return c.json({ task })
})

taskRoutes.get('/pending-approvals', async (c) => {
  const user = c.get('user')
  if (!canApproveTasks(user)) return c.json({ error: 'Forbidden' }, 403)

  const rows = await db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.farmId, user.farmId),
        or(eq(tasks.status, 'awaiting_approval')),
      ),
    )
    .orderBy(desc(tasks.updatedAt))

  return c.json({ tasks: rows })
})

taskRoutes.get('/post-approval-changes', async (c) => {
  const user = c.get('user')
  if (!canApproveTasks(user)) return c.json({ error: 'Forbidden' }, 403)

  const rows = await db
    .select({
      id: auditEvents.id,
      taskId: auditEvents.entityId,
      taskTitle: tasks.title,
      changedByName: users.name,
      changedByRole: users.role,
      changedAt: auditEvents.createdAt,
      metadata: auditEvents.metadata,
    })
    .from(auditEvents)
    .innerJoin(tasks, sql`${tasks.id}::text = ${auditEvents.entityId}`)
    .leftJoin(users, eq(auditEvents.userId, users.id))
    .where(
      and(
        eq(auditEvents.farmId, user.farmId),
        eq(auditEvents.entityType, 'task'),
        eq(auditEvents.action, 'reopen'),
      ),
    )
    .orderBy(desc(auditEvents.createdAt))

  const changes = rows.map((row) => {
    const metadata = (row.metadata ?? {}) as Record<string, unknown>
    return {
      id: row.id,
      taskId: row.taskId ?? '',
      taskTitle: row.taskTitle,
      changedByName: row.changedByName ?? undefined,
      changedByRole: row.changedByRole ?? undefined,
      changedAt: row.changedAt.toISOString(),
      before: { status: metadata.fromStatus ?? 'completed' },
      after: {
        status: metadata.toStatus,
        reason: metadata.reason,
      },
    }
  })

  return c.json({ changes })
})
