import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, asc, desc, eq, lte } from 'drizzle-orm'
import { db } from '../db/index.js'
import {
  cropCycles,
  cropCycleStages,
  plots,
  recurringSchedules,
  taskTemplates,
  tasks,
  users,
} from '../db/schema.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { canAssignTasks } from '../lib/rbac.js'
import { logAudit } from '../lib/audit.js'
import {
  authorLocaleForUserId,
  authorLocaleHint,
  isTranslatable,
  toCanonicalEnglish,
  toViewerLocaleMany,
} from '../lib/content-locale.js'
import { normalizeCropType } from '../lib/crop-normalize.js'
import {
  contentLocaleValues,
  mergeContentLocale,
  type ContentTranslationStatus,
} from '../lib/task-drafts.js'
import { detectReplyLocale, resolveStaffReplyLocale } from '../lib/reply-locale.js'
import {
  cronFarmIdAllowed,
  getOwnerUserByFarmId,
  requestHasCronSecret,
} from '../lib/cron-auth.js'

/**
 * Template prose: `name`, `description` and every `checklist` item - the three
 * things a francophone admin types into this form.
 *
 * `cropType` is not prose. It is read as a dictionary key
 * (`getLifecycleForCrop` and the advisory playbooks match it lowercased against
 * English keys), so it is never translated and never sent to an LLM; it goes
 * through the deterministic `normalizeCropType` lexicon instead, exactly as
 * `routes/crops.ts` does it. `actionType`, `systemTemplateKey`, `defaultPayload`
 * and `defaultDurationHours` are structured data, and every
 * `recurring_schedules` column is an id, enum, boolean or timestamp.
 */

/** Concurrent canonicalization calls when a checklist has many items. */
const WRITE_CONCURRENCY = 4

const createTemplateSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  cropType: z.string().max(100).optional(),
  // Bounded because every item is a separate translation on write.
  checklist: z.array(z.string().max(500)).max(30).optional(),
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

async function preferredLocaleForUser(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ preferredLocale: users.preferredLocale })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  return row?.preferredLocale ?? null
}

type TemplateProse = {
  name?: string
  description?: string
  checklist?: string[]
}

type CanonicalTemplate = TemplateProse & {
  /** False when the write carried no prose at all, so the row keeps its labels. */
  hasText: boolean
  sourceLocale: string | null
  translationStatus: 'done' | 'pending'
}

/**
 * Normalize template prose to English for storage.
 *
 * One `source_locale`/`translation_status` pair describes the whole row, so a
 * single field the LLM could not translate leaves the template `pending` and the
 * non-English locale is the informative one to record.
 */
async function toCanonicalTemplate(
  input: TemplateProse,
  farmId: string,
  sourceLocale: string | null,
): Promise<CanonicalTemplate> {
  type Slot =
    | { kind: 'name' | 'description'; text: string }
    | { kind: 'checklist'; index: number; text: string }

  const slots: Slot[] = []
  if (input.name?.trim()) slots.push({ kind: 'name', text: input.name })
  if (input.description?.trim()) slots.push({ kind: 'description', text: input.description })
  input.checklist?.forEach((item, index) => {
    if (item.trim()) slots.push({ kind: 'checklist', index, text: item })
  })

  const empty: CanonicalTemplate = { hasText: false, sourceLocale, translationStatus: 'done' }
  if (slots.length === 0) return empty

  // Chunked rather than one Promise.all: a 30-item checklist must not open 30
  // concurrent LLM calls just because one admin saved a form.
  const results: Awaited<ReturnType<typeof toCanonicalEnglish>>[] = []
  for (let i = 0; i < slots.length; i += WRITE_CONCURRENCY) {
    results.push(
      ...(await Promise.all(
        slots
          .slice(i, i + WRITE_CONCURRENCY)
          .map((slot) => toCanonicalEnglish({ text: slot.text, farmId, sourceLocale })),
      )),
    )
  }

  const out: CanonicalTemplate = { ...empty, hasText: true }
  if (input.checklist) out.checklist = [...input.checklist]
  let pending = false
  let resolvedLocale: string | null = null

  slots.forEach((slot, i) => {
    const result = results[i]
    if (slot.kind === 'checklist') {
      if (out.checklist) out.checklist[slot.index] = result.english
    } else {
      out[slot.kind] = result.english
    }
    if (result.status === 'pending') pending = true
    // One label describes the whole write: a non-English locale is informative.
    if (!resolvedLocale || resolvedLocale === 'en') resolvedLocale = result.sourceLocale
  })

  out.sourceLocale = resolvedLocale
  out.translationStatus = pending ? 'pending' : 'done'
  return out
}

/** Locale of the first text that is not English, without calling an LLM. */
function detectNonEnglish(texts: (string | null | undefined)[]): string | null {
  for (const text of texts) {
    if (typeof text !== 'string' || !isTranslatable(text)) continue
    const detected = detectReplyLocale(text)
    if (detected !== 'en') return detected
  }
  return null
}

/**
 * Locale columns for a task row whose text was COPIED from a template rather
 * than authored here.
 *
 * The template already holds canonical English and carries its own labels
 * (migration 0029 added them to `task_templates`), so generation propagates that
 * metadata instead of paying to translate the same words a second time: no LLM
 * call, whatever the outcome.
 *
 * The detector is a backstop for a template that still holds its author's
 * language while claiming `'done'` - a row written before those columns existed,
 * so nothing ever checked it. Status only escalates: a false `'pending'` costs
 * the retry job one wasted call, while a false `'done'` hides non-English text
 * in `tasks` permanently, because the job filters on status.
 */
function copiedTemplateLocale(template: {
  name: string
  description: string | null
  sourceLocale: string | null
  translationStatus: ContentTranslationStatus
}): { sourceLocale?: string | null; translationStatus?: ContentTranslationStatus } {
  const inherited = contentLocaleValues(template)
  if (inherited.translationStatus === 'pending') return inherited

  const detected = detectNonEnglish([template.name, template.description])
  if (!detected) return inherited
  return { sourceLocale: template.sourceLocale ?? detected, translationStatus: 'pending' }
}

/**
 * Render prose in the viewer's language with ONE batched translation call per
 * response: every string across every row is collected first, translated
 * together, then mapped back by position. An English viewer short-circuits
 * before any of this work.
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

/**
 * `localizeRows` for template rows, whose third prose field is a jsonb array of
 * checklist steps. Names, descriptions and every checklist item across every
 * row still go out in one batched call.
 */
async function localizeTemplates<
  T extends { name?: string | null; description?: string | null; checklist?: string[] | null },
>(rows: T[], farmId: string, targetLocale: string | null): Promise<T[]> {
  if (resolveStaffReplyLocale(targetLocale) === 'en') return rows
  if (rows.length === 0) return rows

  const collect = (row: T): string[] => {
    const values = [row.name, row.description, ...(row.checklist ?? [])]
    return values.filter((value): value is string => typeof value === 'string' && value !== '')
  }

  const texts = rows.flatMap(collect)
  if (texts.length === 0) return rows

  const translated = await toViewerLocaleMany({ texts, targetLocale, farmId })

  let cursor = 0
  return rows.map((row) => {
    const out = { ...row } as Record<string, unknown>
    if (typeof row.name === 'string' && row.name !== '') out.name = translated[cursor++]
    if (typeof row.description === 'string' && row.description !== '') {
      out.description = translated[cursor++]
    }
    if (row.checklist) {
      out.checklist = row.checklist.map((item) =>
        typeof item === 'string' && item !== '' ? translated[cursor++] : item,
      )
    }
    return out as T
  })
}

export const templateRoutes = new Hono<{ Variables: AppVariables }>()

templateRoutes.use('*', async (c, next) => {
  if (c.req.path.endsWith('/generate-tasks') && c.req.method === 'POST' && requestHasCronSecret(c)) {
    await next()
    return
  }
  return authMiddleware(c, next)
})

/**
 * The lifecycles this farm's own crop cycles are running on.
 *
 * This used to return `CROP_LIFECYCLES` wholesale: two crops' worth of stage
 * durations from two hardcoded constants, offered under a heading that reads as
 * the farm's own agronomy. It was the same answer for every farm on every soil,
 * and a farm growing neither crop saw somebody else's plantain.
 *
 * Returning the farm's rows was the honest option rather than labelling the
 * generic ones as a fallback, because a label does not survive the trip: this
 * feeds a reference panel where a stage length is read as a number to plan
 * around, and "generic" beside it is not something a reader weighs before
 * booking harvest labour. A farm with no lifecycles established yet gets an
 * empty list, which is the true state and one the client already renders.
 *
 * Only stages are returned. Tasks are per cycle and carry prose that needs
 * localizing, and they are served by `GET /api/crops/:id/lifecycle` where the
 * farm edits them.
 */
templateRoutes.get('/lifecycles', async (c) => {
  const user = c.get('user')

  const rows = await db
    .select({
      cropCycleId: cropCycleStages.cropCycleId,
      cropType: cropCycles.cropType,
      plantedAt: cropCycles.plantedAt,
      plotName: plots.name,
      stage: cropCycleStages.stage,
      durationDays: cropCycleStages.durationDays,
      source: cropCycleStages.source,
    })
    .from(cropCycleStages)
    .innerJoin(cropCycles, eq(cropCycleStages.cropCycleId, cropCycles.id))
    .leftJoin(plots, eq(cropCycles.plotId, plots.id))
    .where(eq(cropCycleStages.farmId, user.farmId))
    .orderBy(desc(cropCycles.plantedAt), asc(cropCycleStages.sequence))

  const lifecycles: {
    cropCycleId: string
    cropType: string
    plantedAt: Date
    plotName: string | null
    totalDays: number
    stages: { stage: string; durationDays: number; source: string }[]
  }[] = []
  const byCycle = new Map<string, (typeof lifecycles)[number]>()

  for (const row of rows) {
    let lifecycle = byCycle.get(row.cropCycleId)
    if (!lifecycle) {
      lifecycle = {
        cropCycleId: row.cropCycleId,
        cropType: row.cropType,
        plantedAt: row.plantedAt,
        plotName: row.plotName,
        totalDays: 0,
        stages: [],
      }
      byCycle.set(row.cropCycleId, lifecycle)
      lifecycles.push(lifecycle)
    }
    lifecycle.totalDays += row.durationDays
    lifecycle.stages.push({
      stage: row.stage,
      durationDays: row.durationDays,
      source: row.source,
    })
  }

  return c.json({ lifecycles })
})

templateRoutes.get('/templates', async (c) => {
  const user = c.get('user')

  const rows = await db
    .select()
    .from(taskTemplates)
    .where(eq(taskTemplates.farmId, user.farmId))
    .orderBy(desc(taskTemplates.createdAt))

  const viewerLocale = await preferredLocaleForUser(user.id)
  const templates = await localizeTemplates(rows, user.farmId, viewerLocale)

  return c.json({ templates })
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

  const viewerLocale = await preferredLocaleForUser(user.id)
  const [localized] = await localizeTemplates([template], user.farmId, viewerLocale)

  return c.json({ template: localized })
})

templateRoutes.post('/templates', zValidator('json', createTemplateSchema), async (c) => {
  const user = c.get('user')
  if (!canAssignTasks(user)) return c.json({ error: 'Forbidden' }, 403)

  const body = c.req.valid('json')

  const authorLocale = await authorLocaleForUserId(user.id)
  const canonical = await toCanonicalTemplate(
    { name: body.name, description: body.description, checklist: body.checklist },
    user.farmId,
    authorLocale,
  )

  const [template] = await db
    .insert(taskTemplates)
    .values({
      farmId: user.farmId,
      name: canonical.name ?? body.name,
      description: canonical.description ?? body.description,
      // Lookup key, not prose: resolved through the deterministic crop lexicon
      // so a French crop name still matches the English playbook keys. A crop we
      // have no playbook for is stored exactly as typed.
      cropType: body.cropType ? normalizeCropType(body.cropType).canonical : body.cropType,
      checklist: canonical.checklist ?? body.checklist,
      sourceLocale: canonical.sourceLocale,
      translationStatus: canonical.translationStatus,
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

  // The author reads back their own words; the row holds the English.
  return c.json(
    {
      template: {
        ...template,
        name: body.name,
        description: body.description ?? template.description,
        checklist: body.checklist ?? template.checklist,
      },
    },
    201,
  )
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

  const viewerLocale = await preferredLocaleForUser(user.id)
  const authorLocale = authorLocaleHint(viewerLocale)
  const canonical = await toCanonicalTemplate(
    { name: body.name, description: body.description, checklist: body.checklist },
    user.farmId,
    authorLocale,
  )

  const updates: Partial<typeof existing> = {}
  if (body.name !== undefined) updates.name = canonical.name ?? body.name
  if (body.description !== undefined) updates.description = canonical.description ?? body.description
  // Lookup key, not prose: canonicalized through the crop lexicon, never translated.
  if (body.cropType !== undefined) {
    updates.cropType = body.cropType ? normalizeCropType(body.cropType).canonical : body.cropType
  }
  if (body.checklist !== undefined) updates.checklist = canonical.checklist ?? body.checklist
  if (body.defaultDurationHours !== undefined) updates.defaultDurationHours = body.defaultDurationHours

  // A patch that only moves `defaultDurationHours` must not relabel the row, and
  // a row the retry job still owes work on is never downgraded to 'done'.
  if (canonical.hasText) {
    Object.assign(
      updates,
      mergeContentLocale(existing, {
        sourceLocale: canonical.sourceLocale,
        translationStatus: canonical.translationStatus,
      }),
    )
  }

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

  // Text this author just wrote is echoed in their own words (no round trip);
  // fields they did not touch hold English and are rendered for the viewer.
  // Echoed fields are blanked before localization so they are never sent.
  const [localized] = await localizeTemplates(
    [
      {
        ...template,
        name: body.name !== undefined ? null : template.name,
        description: body.description !== undefined ? null : template.description,
        checklist: body.checklist !== undefined ? null : template.checklist,
      },
    ],
    user.farmId,
    viewerLocale,
  )

  return c.json({
    template: {
      ...template,
      name: body.name ?? localized.name ?? template.name,
      description: body.description ?? localized.description,
      checklist: body.checklist ?? localized.checklist,
    },
  })
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

  // `templateName` is the only prose on a schedule. Recurrence is an enum, the
  // staff and plot names are proper nouns, and the rest are ids and timestamps.
  const viewerLocale = await preferredLocaleForUser(user.id)
  const schedules = await localizeRows(rows, ['templateName'], user.farmId, viewerLocale)

  return c.json({ schedules })
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
  let bodyFarmId: string | undefined
  try {
    const parsed = (await c.req.json()) as { farmId?: unknown }
    if (typeof parsed?.farmId === 'string') bodyFarmId = parsed.farmId
  } catch {
    bodyFarmId = undefined
  }

  let user = c.get('user')
  if (requestHasCronSecret(c)) {
    if (!bodyFarmId || !cronFarmIdAllowed(bodyFarmId)) {
      return c.json({ error: 'Unauthorized' }, 401)
    }
    const owner = await getOwnerUserByFarmId(bodyFarmId)
    if (!owner) return c.json({ error: 'Unauthorized' }, 401)
    user = owner
  } else if (!user || !canAssignTasks(user)) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  if (!user) return c.json({ error: 'Unauthorized' }, 401)

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

  const createdTasks: (typeof tasks.$inferSelect)[] = []

  for (const { schedule, template } of dueSchedules) {
    // The template already holds canonical English, so the text and its locale
    // labels are copied through rather than translated a second time.
    const [task] = await db
      .insert(tasks)
      .values({
        farmId: user.farmId,
        title: template.name,
        description: template.description ?? undefined,
        ...copiedTemplateLocale(template),
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

  const viewerLocale = await preferredLocaleForUser(user.id)
  const localized = await localizeRows(
    createdTasks,
    ['title', 'description'],
    user.farmId,
    viewerLocale,
  )

  return c.json({ tasks: localized, count: localized.length })
})
