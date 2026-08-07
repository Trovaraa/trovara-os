import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import {
  auditEvents,
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
import { notifyTaskRejected, notifyTaskSubmittedForApproval } from '../lib/farm-notify.js'
import {
  authorLocaleForUserId,
  authorLocaleHint,
  toCanonicalEnglish,
  toViewerLocaleMany,
} from '../lib/content-locale.js'
import { resolveStaffReplyLocale } from '../lib/reply-locale.js'

/**
 * Task prose. Everything else on a task row is an id, enum, name, URL,
 * coordinate or timestamp and is never translated. `actionPayload` is
 * structured action data (crop enums, `systemTemplateKey`, plot ids), not
 * prose, so it is stored and returned verbatim.
 */
const TASK_TEXT_FIELDS = ['title', 'description', 'completionNote', 'rejectionReason'] as const
type TaskTextField = (typeof TASK_TEXT_FIELDS)[number]

async function preferredLocaleForUser(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ preferredLocale: users.preferredLocale })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  return row?.preferredLocale ?? null
}

type CanonicalFields = {
  text: Partial<Record<TaskTextField, string>>
  sourceLocale: string | null
  translationStatus: 'done' | 'pending'
}

/**
 * Normalize a task's free text to English for storage.
 *
 * Each field is its own column, so they are translated as concurrent calls
 * rather than one merged prompt: a create with a title and a description costs
 * one round trip of latency instead of two, and neither field can bleed into
 * the other's column. `translation_status` is per row, so a single pending
 * field leaves the whole row pending for the retry job.
 */
async function toCanonicalFields(
  fields: Partial<Record<TaskTextField, string | null | undefined>>,
  farmId: string,
  sourceLocale: string | null,
): Promise<CanonicalFields> {
  const entries = Object.entries(fields).filter(
    (entry): entry is [TaskTextField, string] =>
      typeof entry[1] === 'string' && entry[1].trim() !== '',
  )
  if (entries.length === 0) return { text: {}, sourceLocale, translationStatus: 'done' }

  let results
  try {
    results = await Promise.all(
      entries.map(([, text]) => toCanonicalEnglish({ text, farmId, sourceLocale })),
    )
  } catch {
    // A translation failure must never fail the write. The service swallows LLM
    // errors itself, so reaching here means something around it threw and the
    // task still has to be saved. `sourceLocale` is already `authorLocaleHint`
    // output — null or a real non-English locale, never a bare 'en'.
    return {
      text: Object.fromEntries(entries) as Partial<Record<TaskTextField, string>>,
      sourceLocale,
      translationStatus: 'pending',
    }
  }

  const text: Partial<Record<TaskTextField, string>> = {}
  let pending = false
  let resolvedLocale: string | null = null
  entries.forEach(([field], index) => {
    const result = results[index]
    text[field] = result.english
    if (result.status === 'pending') pending = true
    // One column for the whole row: a non-English locale is the informative one.
    if (!resolvedLocale || resolvedLocale === 'en') resolvedLocale = result.sourceLocale
  })

  return { text, sourceLocale: resolvedLocale, translationStatus: pending ? 'pending' : 'done' }
}

/**
 * Render task prose in the viewer's language with ONE batched translation call
 * per response: every string across every row is collected first, translated
 * together (the service deduplicates and reads its cache in a single query),
 * then mapped back by position. An English viewer short-circuits before any of
 * this work.
 */
async function localizeRows<T extends object>(
  rows: T[],
  fields: readonly (keyof T & string)[],
  farmId: string,
  targetLocale: string | null,
): Promise<T[]> {
  if (resolveStaffReplyLocale(targetLocale) === 'en') return rows
  if (rows.length === 0 || fields.length === 0) return rows

  const texts: string[] = []
  for (const row of rows) {
    for (const field of fields) {
      const value = row[field]
      if (typeof value === 'string' && value !== '') texts.push(value)
    }
  }
  if (texts.length === 0) return rows

  const translated = await toViewerLocaleMany({ texts, targetLocale, farmId })

  let cursor = 0
  return rows.map((row) => {
    const out = { ...row }
    for (const field of fields) {
      const value = row[field]
      if (typeof value === 'string' && value !== '') {
        ;(out as Record<string, unknown>)[field] = translated[cursor++]
      }
    }
    return out
  })
}

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
  if (user.role === 'sales') {
    return c.json({ error: 'Forbidden' }, 403)
  }
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

  type TaskListRow = (typeof filtered)[number] & {
    consumptions: { itemId: string; quantity: number }[]
  }

  // Masking runs before localization so hidden text is never sent for translation.
  const shaped: TaskListRow[] = filtered.map((task) => {
    const row = {
      ...task,
      consumptions: usageByTask.get(task.id) ?? [],
    }
    // Defense in depth: field workers must never see other workers' evidence.
    if (user.role === 'field_worker' && task.assignedToId !== user.id) {
      return { ...row, photoUrl: null, voiceUrl: null, completionNote: null }
    }
    return row
  })

  const viewerLocale = await preferredLocaleForUser(user.id)
  const localized = await localizeRows(shaped, TASK_TEXT_FIELDS, user.farmId, viewerLocale)

  return c.json({ tasks: localized })
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

  const authorLocale = await authorLocaleForUserId(user.id)
  const canonical = await toCanonicalFields(
    { title: body.title, description: body.description },
    user.farmId,
    authorLocale,
  )

  const [task] = await db
    .insert(tasks)
    .values({
      farmId: user.farmId,
      title: canonical.text.title ?? body.title,
      description: canonical.text.description ?? body.description,
      sourceLocale: canonical.sourceLocale,
      translationStatus: canonical.translationStatus,
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

  // The author reads back their own words; the row holds the English.
  return c.json(
    {
      task: {
        ...task,
        title: body.title,
        description: body.description ?? task.description,
      },
    },
    201,
  )
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

  const viewerLocale = await preferredLocaleForUser(user.id)
  const authorLocale = authorLocaleHint(viewerLocale)
  const canonical = await toCanonicalFields(
    { completionNote: body.completionNote, rejectionReason: body.rejectionReason },
    user.farmId,
    authorLocale,
  )
  // Length and presence checks above validate the author's own words; every
  // write below stores the canonical English.
  const completionNote = canonical.text.completionNote ?? body.completionNote
  const rejectionReason = canonical.text.rejectionReason ?? body.rejectionReason

  const updates: Partial<typeof existing> = { updatedAt: new Date() }

  if (Object.keys(canonical.text).length > 0) {
    // Never downgrade a row the retry job still owes work on, and keep it
    // labelled with the locale of the text that failed: `source_locale` is the
    // hint that retry uses.
    if (existing.translationStatus === 'done' || canonical.translationStatus === 'pending') {
      updates.sourceLocale = canonical.sourceLocale ?? existing.sourceLocale
    }
    if (canonical.translationStatus === 'pending') updates.translationStatus = 'pending'
  }

  if (body.completionNote !== undefined) {
    if (user.role === 'field_worker' || canAssignTasks(user)) {
      updates.completionNote = completionNote
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
      if (body.status === 'rejected') updates.rejectionReason = rejectionReason
    }

    if (reopeningCompletedTask) {
      updates.completedAt = null
      updates.approvedById = null
      updates.rejectionReason = rejectionReason
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

  if (transitionsToAwaitingApproval) {
    void notifyTaskSubmittedForApproval({
      farmId: user.farmId,
      taskId: task.id,
      taskTitle: task.title,
      workerName: user.name,
      note: completionNote ?? task.completionNote,
      actorUserId: user.id,
    }).catch(() => undefined)
  }

  const transitionsToRejected = body.status === 'rejected' && existing.status !== 'rejected'
  if (transitionsToRejected) {
    void notifyTaskRejected({
      farmId: user.farmId,
      assignedToId: task.assignedToId,
      taskId: task.id,
      taskTitle: task.title,
      reason: rejectionReason ?? task.rejectionReason,
      actorUserId: user.id,
    }).catch(() => undefined)
  }

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
        reason: rejectionReason,
      },
    })
  }

  // Text this author just wrote is echoed in their own words (no round trip);
  // the rest of the row is canonical English rendered for the viewer.
  const echo: Partial<Record<TaskTextField, string>> = {}
  if (typeof updates.completionNote === 'string' && body.completionNote) {
    echo.completionNote = body.completionNote
  }
  if (typeof updates.rejectionReason === 'string' && body.rejectionReason) {
    echo.rejectionReason = body.rejectionReason
  }
  const [localized] = await localizeRows(
    [task],
    TASK_TEXT_FIELDS.filter((field) => !(field in echo)),
    user.farmId,
    viewerLocale,
  )

  return c.json({ task: { ...localized, ...echo } })
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

  const viewerLocale = await preferredLocaleForUser(user.id)
  const localized = await localizeRows(rows, TASK_TEXT_FIELDS, user.farmId, viewerLocale)

  return c.json({ tasks: localized })
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

  // The task title and the reopen reason are the only prose here; statuses,
  // ids, timestamps and staff names stay as they are.
  const viewerLocale = await preferredLocaleForUser(user.id)
  const prose = await localizeRows(
    changes.map((change) => ({
      taskTitle: change.taskTitle,
      reason: typeof change.after.reason === 'string' ? change.after.reason : '',
    })),
    ['taskTitle', 'reason'],
    user.farmId,
    viewerLocale,
  )

  return c.json({
    changes: changes.map((change, index) => ({
      ...change,
      taskTitle: prose[index].taskTitle,
      after: { ...change.after, reason: prose[index].reason || change.after.reason },
    })),
  })
})
