import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, asc, desc, eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { cropCycles, cropCycleStages, cropCycleTasks, plots, users } from '../db/schema.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { hasPermission } from '../lib/rbac.js'
import { COST_CENTRE_CODES } from '../lib/cost-centres.js'
import { logAudit } from '../lib/audit.js'
import { canAdvanceCropStage, type CropStage } from '../lib/state-machines.js'
import { recordFarmEvent } from '../lib/farm-events.js'
import { normalizeCropType } from '../lib/crop-normalize.js'
import {
  CROP_AGRONOMY_LIMITS,
  cropStageTimeline,
  expectedHarvestDate,
  generateCropCycleAgronomy,
  readCropCycleLifecycle,
} from '../lib/crop-agronomy.js'
import {
  authorLocaleForUserId,
  authorLocaleHint,
  toCanonicalEnglish,
  toViewerLocaleMany,
} from '../lib/content-locale.js'
import { resolveStaffReplyLocale } from '../lib/reply-locale.js'
import {
  contentLocaleValues,
  mergeContentLocale,
  type ContentLocaleMeta,
} from '../lib/task-drafts.js'

async function preferredLocaleForUser(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ preferredLocale: users.preferredLocale })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  return row?.preferredLocale ?? null
}

/**
 * Normalize a cycle's `notes` to English for storage - the only prose on a crop
 * cycle, and the one column its locale pair describes (the same column the
 * translation retry job repairs on `crop_cycles`).
 *
 * `cropType` is deliberately not normalized here: it is an exact lookup key
 * resolved through the deterministic crop lexicon below, so it never reaches a
 * translator. The stage enum, plot names, yields and dates are not prose either.
 *
 * A translation failure yields the author's own words at 'pending' so the retry
 * job repairs the row later; it must never fail the write it serves.
 */
async function canonicalNotes(
  notes: string | null | undefined,
  farmId: string,
  hint: string | null,
): Promise<{ text?: string; locale: ContentLocaleMeta }> {
  if (typeof notes !== 'string' || notes.trim() === '') {
    return { locale: { sourceLocale: null, translationStatus: 'done' } }
  }

  try {
    const result = await toCanonicalEnglish({ text: notes, farmId, sourceLocale: hint })
    return {
      text: result.english,
      locale: { sourceLocale: result.sourceLocale, translationStatus: result.status },
    }
  } catch {
    return { text: notes, locale: { sourceLocale: hint, translationStatus: 'pending' } }
  }
}

/**
 * Render cycle prose in the viewer's language with ONE batched translation call
 * per response: every string across every row is collected first, translated
 * together (the service deduplicates and reads its cache in a single query),
 * then mapped back by position. An English viewer short-circuits before any of
 * this work, as does a caller that passes no fields.
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

/** The two prose columns on a lifecycle task; everything else on the row is data. */
const TASK_TEXT_FIELDS = ['templateName', 'description'] as const

/**
 * Normalize one string of a lifecycle task to English.
 *
 * A translation failure yields the author's own words at 'pending' so the retry
 * job repairs the row later; it must never fail the write it serves.
 */
async function canonicalString(
  text: string,
  farmId: string,
  hint: string | null,
): Promise<{ english: string; sourceLocale: string | null; status: 'done' | 'pending' }> {
  try {
    const result = await toCanonicalEnglish({ text, farmId, sourceLocale: hint })
    return { english: result.english, sourceLocale: result.sourceLocale, status: result.status }
  } catch {
    return { english: text, sourceLocale: hint, status: 'pending' }
  }
}

/**
 * Normalize the prose a farmer wrote on a lifecycle task.
 *
 * One locale pair describes the whole row, so the row is only 'done' when both
 * of its strings are: a task whose name translated and whose description did
 * not still owes the retry job work, and labelling it done would hide that
 * forever.
 */
async function canonicalTaskText(
  fields: { templateName?: string; description?: string | null },
  farmId: string,
  hint: string | null,
): Promise<{
  templateName?: string
  description?: string | null
  locale: ContentLocaleMeta
}> {
  const out: { templateName?: string; description?: string | null } = {}
  let sourceLocale: string | null = null
  let status: 'done' | 'pending' = 'done'

  const normalize = async (value: string): Promise<string> => {
    const result = await canonicalString(value, farmId, hint)
    sourceLocale = sourceLocale ?? result.sourceLocale
    if (result.status === 'pending') status = 'pending'
    return result.english
  }

  if (fields.templateName !== undefined) out.templateName = await normalize(fields.templateName)
  if (fields.description !== undefined) {
    out.description = fields.description ? await normalize(fields.description) : fields.description
  }

  return { ...out, locale: { sourceLocale, translationStatus: status } }
}

/**
 * Drop the note saying why this cycle has no lifecycle, now that it has one.
 *
 * A cycle whose stages or work the farm has edited has a lifecycle, whatever
 * generation last managed, and a banner explaining an empty lifecycle over one
 * the farmer typed is worse than no banner at all.
 */
async function clearAgronomySkipReason(cycleId: string, farmId: string): Promise<void> {
  await db
    .update(cropCycles)
    .set({ agronomySkipReason: null })
    .where(and(eq(cropCycles.id, cycleId), eq(cropCycles.farmId, farmId)))
}

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
  standCount: z.number().int().positive().optional(),
  costCentre: z.enum(COST_CENTRE_CODES).optional(),
  notes: z.string().max(2000).optional(),
})

const updateCropSchema = z.object({
  stage: cropStageSchema.optional(),
  expectedHarvestAt: z.string().datetime().optional(),
  actualHarvestAt: z.string().datetime().optional(),
  expectedYieldKg: z.number().int().positive().optional(),
  actualYieldKg: z.number().int().nonnegative().optional(),
  standCount: z.number().int().positive().nullable().optional(),
  costCentre: z.enum(COST_CENTRE_CODES).nullable().optional(),
  notes: z.string().max(2000).optional(),
  ownerOverride: z.boolean().optional(),
})

/**
 * The bounds come from the generator so a person and a model are held to the
 * same limits: a duration or an offset the generator would have been rejected
 * for inventing is not one the farm can type in by hand either.
 */
const stageDurationSchema = z.object({
  durationDays: z
    .number()
    .int()
    .min(CROP_AGRONOMY_LIMITS.minStageDurationDays)
    .max(CROP_AGRONOMY_LIMITS.maxStageDurationDays),
})

const cycleTaskSchema = z.object({
  stage: cropStageSchema,
  /** Days after the stage is entered, not after planting. */
  offsetDays: z
    .number()
    .int()
    .min(CROP_AGRONOMY_LIMITS.minTaskOffsetDays)
    .max(CROP_AGRONOMY_LIMITS.maxTaskOffsetDays),
  templateName: z.string().trim().min(1).max(CROP_AGRONOMY_LIMITS.maxTemplateNameLength),
  description: z.string().trim().max(CROP_AGRONOMY_LIMITS.maxDescriptionLength).nullable().optional(),
  defaultDurationHours: z
    .number()
    .int()
    .min(CROP_AGRONOMY_LIMITS.minTaskDurationHours)
    .max(CROP_AGRONOMY_LIMITS.maxTaskDurationHours)
    .nullable()
    .optional(),
})

// An edit takes ownership of the task, so an empty body is refused rather than
// quietly relabelling a generated row as the farm's own without changing it.
const updateCycleTaskSchema = cycleTaskSchema
  .partial()
  .refine((body) => Object.keys(body).length > 0, { message: 'No fields to update' })

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
      standCount: cropCycles.standCount,
      costCentre: cropCycles.costCentre,
      agronomySkipReason: cropCycles.agronomySkipReason,
      notes: cropCycles.notes,
      createdAt: cropCycles.createdAt,
      updatedAt: cropCycles.updatedAt,
    })
    .from(cropCycles)
    .leftJoin(plots, eq(cropCycles.plotId, plots.id))
    .where(eq(cropCycles.farmId, user.farmId))
    .orderBy(desc(cropCycles.updatedAt))

  const viewerLocale = await preferredLocaleForUser(user.id)
  const localized = await localizeRows(rows, ['notes'], user.farmId, viewerLocale)

  return c.json({ cropCycles: localized })
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
      standCount: cropCycles.standCount,
      costCentre: cropCycles.costCentre,
      agronomySkipReason: cropCycles.agronomySkipReason,
      notes: cropCycles.notes,
      createdAt: cropCycles.createdAt,
      updatedAt: cropCycles.updatedAt,
    })
    .from(cropCycles)
    .leftJoin(plots, eq(cropCycles.plotId, plots.id))
    .where(and(eq(cropCycles.id, cycleId), eq(cropCycles.farmId, user.farmId)))
    .limit(1)

  if (!row) return c.json({ error: 'Not found' }, 404)

  const viewerLocale = await preferredLocaleForUser(user.id)
  const [localized] = await localizeRows([row], ['notes'], user.farmId, viewerLocale)

  return c.json({ cropCycle: localized })
})

cropRoutes.post('/', zValidator('json', createCropSchema), async (c) => {
  const user = c.get('user')
  if (!hasPermission(user, 'crops.manage')) return c.json({ error: 'Forbidden' }, 403)

  const body = c.req.valid('json')

  const [plot] = await db
    .select()
    .from(plots)
    .where(and(eq(plots.id, body.plotId), eq(plots.farmId, user.farmId)))
    .limit(1)

  if (!plot) return c.json({ error: 'Invalid plot' }, 400)

  const stage = body.stage ?? 'planted'

  // The lifecycle and advisory lookups key off this string exactly, so a crop
  // typed in the operator's own language is resolved to its canonical key here,
  // the same way the butler channels do it. Crops we have no playbook for are
  // stored as typed.
  const cropType = normalizeCropType(body.cropType).canonical

  const canonical = await canonicalNotes(
    body.notes,
    user.farmId,
    await authorLocaleForUserId(user.id),
  )

  const plantedAt = new Date(body.plantedAt)
  const [cropCycle] = await db
    .insert(cropCycles)
    .values({
      farmId: user.farmId,
      plotId: body.plotId,
      cropType,
      stage,
      plantedAt,
      stageEnteredAt: plantedAt,
      expectedHarvestAt: body.expectedHarvestAt ? new Date(body.expectedHarvestAt) : undefined,
      expectedYieldKg: body.expectedYieldKg,
      standCount: body.standCount,
      costCentre: body.costCentre,
      notes: canonical.text ?? body.notes,
      ...contentLocaleValues(canonical.locale),
    })
    .returning()

  await recordFarmEvent({
    farmId: user.farmId,
    actorUserId: user.id,
    entityType: 'crop_cycle',
    entityId: cropCycle.id,
    eventType: cropStageEventType(stage as CropStage),
    afterValue: {
      stage,
      cropType,
      standCount: body.standCount ?? null,
      costCentre: body.costCentre ?? null,
    },
    metadata: { plotId: body.plotId },
  })

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'create',
    entityType: 'crop_cycle',
    entityId: cropCycle.id,
  })

  // Deliberately not awaited: establishing the lifecycle calls a model, and a
  // farmer registering a planting at the edge of the plot must not wait on one,
  // nor lose the cycle when one is unavailable. The service persists nothing
  // when it cannot answer, so the cycle stays in the supported no-lifecycle
  // state and the farm can trigger it again from the crop page.
  void generateCropCycleAgronomy({
    cropCycleId: cropCycle.id,
    farmId: user.farmId,
    // The crop as the farmer typed it, not the lexicon key: "banane plantain"
    // and "plantain" both resolve to one advisory playbook, but the lifecycle is
    // being asked for on behalf of the plants actually in the ground.
    cropType: body.cropType,
    plantedAt,
  }).catch(() => undefined)

  // The author reads back their own words; the row holds the English.
  return c.json({ cropCycle: { ...cropCycle, notes: body.notes ?? cropCycle.notes } }, 201)
})

cropRoutes.patch('/:id', zValidator('json', updateCropSchema), async (c) => {
  const user = c.get('user')
  if (!hasPermission(user, 'crops.manage')) return c.json({ error: 'Forbidden' }, 403)

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

  const viewerLocale = await preferredLocaleForUser(user.id)
  const authorLocale = authorLocaleHint(viewerLocale)
  const canonical = await canonicalNotes(body.notes, user.farmId, authorLocale)

  const updates: Partial<typeof existing> = { updatedAt: new Date() }

  if (body.stage !== undefined) {
    updates.stage = body.stage
    if (body.stage !== existing.stage) {
      updates.stageEnteredAt = new Date()
    }
  }
  if (body.expectedHarvestAt !== undefined) {
    updates.expectedHarvestAt = new Date(body.expectedHarvestAt)
  }
  if (body.actualHarvestAt !== undefined) {
    updates.actualHarvestAt = new Date(body.actualHarvestAt)
  }
  if (body.expectedYieldKg !== undefined) updates.expectedYieldKg = body.expectedYieldKg
  if (body.actualYieldKg !== undefined) updates.actualYieldKg = body.actualYieldKg
  if (body.standCount !== undefined) updates.standCount = body.standCount
  if (body.costCentre !== undefined) updates.costCentre = body.costCentre
  if (body.notes !== undefined) {
    updates.notes = canonical.text ?? body.notes
    // Escalates a row to 'pending' but never downgrades one the retry job still
    // owes work on. A patch that carries no notes never touches the pair.
    Object.assign(updates, mergeContentLocale(existing, canonical.locale))
  }

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

  // Notes this author just wrote are echoed in their own words (no round trip);
  // a patch that left them alone renders the stored English for the viewer.
  const [localized] = await localizeRows(
    [cropCycle],
    body.notes !== undefined ? [] : ['notes'],
    user.farmId,
    viewerLocale,
  )

  return c.json({
    cropCycle: body.notes !== undefined ? { ...localized, notes: body.notes } : localized,
  })
})

cropRoutes.delete('/:id', async (c) => {
  const user = c.get('user')
  if (!hasPermission(user, 'crops.manage')) return c.json({ error: 'Forbidden' }, 403)

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

/** A cycle the caller's farm owns, or undefined. Every lifecycle route starts here. */
async function cycleForFarm(cycleId: string, farmId: string) {
  const [cycle] = await db
    .select()
    .from(cropCycles)
    .where(and(eq(cropCycles.id, cycleId), eq(cropCycles.farmId, farmId)))
    .limit(1)
  return cycle
}

cropRoutes.get('/:id/lifecycle', async (c) => {
  const user = c.get('user')
  const cycleId = c.req.param('id')

  const cycle = await cycleForFarm(cycleId, user.farmId)
  if (!cycle) return c.json({ error: 'Not found' }, 404)

  const { stages, tasks } = await readCropCycleLifecycle({
    cropCycleId: cycleId,
    farmId: user.farmId,
  })

  const viewerLocale = await preferredLocaleForUser(user.id)
  const localizedTasks = await localizeRows(tasks, TASK_TEXT_FIELDS, user.farmId, viewerLocale)

  const timeline = cropStageTimeline(stages, cycle.plantedAt)
  const stageStarts = new Map(timeline.map((window) => [window.stage, window.startsOn]))

  return c.json({
    cropCycleId: cycle.id,
    cropType: cycle.cropType,
    plantedAt: cycle.plantedAt,
    // An empty lifecycle is an answer, not an error: any cycle may have one, and
    // a cycle that has none yet is a supported state the client can offer to
    // fill rather than a 4xx it has to interpret.
    generated: stages.length > 0,
    // The stored code, not a sentence: the client owns the wording and the
    // language the person reading it works in.
    agronomySkipReason: cycle.agronomySkipReason,
    // Derived from this cycle's own durations and withheld when it has none.
    // The `expected_harvest_at` column is whatever the farmer entered at
    // planting; the two disagreeing is information, so neither overwrites the
    // other and the client can show both.
    expectedHarvestAt: expectedHarvestDate(stages, cycle.plantedAt),
    totalDays:
      stages.length === 0 ? null : stages.reduce((sum, stage) => sum + stage.durationDays, 0),
    stages: timeline.map((window, index) => ({
      id: stages[index].id,
      stage: window.stage,
      sequence: stages[index].sequence,
      durationDays: window.durationDays,
      source: stages[index].source,
      startsOn: window.startsOn,
      endsOn: window.endsOn,
    })),
    tasks: localizedTasks.map((task) => {
      const stageStart = stageStarts.get(task.stage)
      return {
        id: task.id,
        stage: task.stage,
        offsetDays: task.offsetDays,
        templateName: task.templateName,
        description: task.description,
        defaultDurationHours: task.defaultDurationHours,
        source: task.source,
        dueDate: stageStart
          ? new Date(stageStart.getTime() + task.offsetDays * 86400000).toISOString()
          : null,
      }
    }),
  })
})

cropRoutes.patch(
  '/:id/lifecycle/stages/:stageId',
  zValidator('json', stageDurationSchema),
  async (c) => {
    const user = c.get('user')
    if (!hasPermission(user, 'crops.manage')) return c.json({ error: 'Forbidden' }, 403)

    const cycleId = c.req.param('id')
    const stageId = c.req.param('stageId')
    const body = c.req.valid('json')

    const stages = await db
      .select()
      .from(cropCycleStages)
      .where(
        and(
          eq(cropCycleStages.cropCycleId, cycleId),
          eq(cropCycleStages.farmId, user.farmId),
        ),
      )
      .orderBy(asc(cropCycleStages.sequence))

    const existing = stages.find((stage) => stage.id === stageId)
    if (!existing) return c.json({ error: 'Not found' }, 404)

    // The whole lifecycle is read because one stage's own bound cannot see the
    // total: seven stages each inside the per-stage ceiling still add up to a
    // cycle no crop runs, and the generator is held to that same total.
    const totalDays = stages.reduce(
      (sum, stage) => sum + (stage.id === stageId ? body.durationDays : stage.durationDays),
      0,
    )
    if (
      totalDays < CROP_AGRONOMY_LIMITS.minTotalDurationDays ||
      totalDays > CROP_AGRONOMY_LIMITS.maxTotalDurationDays
    ) {
      return c.json({ error: 'Lifecycle total duration out of range' }, 400)
    }

    // Tasks are anchored to the day their stage is entered, so a stage cut
    // shorter than the work already scheduled inside it would leave that work
    // due after the crop has moved on.
    const [furthestTask] = await db
      .select({ offsetDays: cropCycleTasks.offsetDays })
      .from(cropCycleTasks)
      .where(
        and(
          eq(cropCycleTasks.cropCycleId, cycleId),
          eq(cropCycleTasks.farmId, user.farmId),
          eq(cropCycleTasks.stage, existing.stage),
        ),
      )
      .orderBy(desc(cropCycleTasks.offsetDays))
      .limit(1)

    if (furthestTask && furthestTask.offsetDays > body.durationDays) {
      return c.json({ error: 'Stage is shorter than the work scheduled in it' }, 400)
    }

    const [stage] = await db
      .update(cropCycleStages)
      .set({
        durationDays: body.durationDays,
        // The farm's own reading of its own crop. No regeneration overwrites it
        // again, which is the whole point of asking the farm for it.
        source: 'manual',
        updatedAt: new Date(),
      })
      .where(and(eq(cropCycleStages.id, stageId), eq(cropCycleStages.farmId, user.farmId)))
      .returning()

    await clearAgronomySkipReason(cycleId, user.farmId)

    await logAudit({
      farmId: user.farmId,
      userId: user.id,
      action: 'update',
      entityType: 'crop_cycle_stage',
      entityId: stageId,
      metadata: { cropCycleId: cycleId, durationDays: body.durationDays },
    })

    return c.json({ stage })
  },
)

cropRoutes.post('/:id/lifecycle/tasks', zValidator('json', cycleTaskSchema), async (c) => {
  const user = c.get('user')
  if (!hasPermission(user, 'crops.manage')) return c.json({ error: 'Forbidden' }, 403)

  const cycleId = c.req.param('id')
  const body = c.req.valid('json')

  const cycle = await cycleForFarm(cycleId, user.farmId)
  if (!cycle) return c.json({ error: 'Not found' }, 404)

  const { stages, tasks } = await readCropCycleLifecycle({
    cropCycleId: cycleId,
    farmId: user.farmId,
  })

  if (tasks.length >= CROP_AGRONOMY_LIMITS.maxTasks) {
    return c.json({ error: 'Lifecycle already holds the maximum number of tasks' }, 400)
  }

  // Work has to hang off a stage this cycle actually passes through, within the
  // days that stage lasts - the same two rules a generated task is held to.
  const stage = stages.find((row) => row.stage === body.stage)
  if (!stage) return c.json({ error: 'Cycle has no such stage' }, 400)
  if (body.offsetDays > stage.durationDays) {
    return c.json({ error: 'offsetDays is beyond the end of the stage' }, 400)
  }

  const canonical = await canonicalTaskText(
    { templateName: body.templateName, description: body.description ?? null },
    user.farmId,
    await authorLocaleForUserId(user.id),
  )

  const [task] = await db
    .insert(cropCycleTasks)
    .values({
      farmId: user.farmId,
      cropCycleId: cycleId,
      stage: body.stage,
      offsetDays: body.offsetDays,
      templateName: canonical.templateName ?? body.templateName,
      description: canonical.description ?? body.description ?? null,
      defaultDurationHours: body.defaultDurationHours ?? null,
      // Anything a person wrote is the farm's own record of its work, so a
      // regeneration leaves it alone.
      source: 'manual',
      ...contentLocaleValues(canonical.locale),
    })
    .returning()

  await clearAgronomySkipReason(cycleId, user.farmId)

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'create',
    entityType: 'crop_cycle_task',
    entityId: task.id,
    metadata: { cropCycleId: cycleId, stage: body.stage },
  })

  // The author reads back their own words; the row holds the English.
  return c.json(
    {
      task: {
        ...task,
        templateName: body.templateName,
        description: body.description ?? task.description,
      },
    },
    201,
  )
})

cropRoutes.patch(
  '/:id/lifecycle/tasks/:taskId',
  zValidator('json', updateCycleTaskSchema),
  async (c) => {
    const user = c.get('user')
    if (!hasPermission(user, 'crops.manage')) return c.json({ error: 'Forbidden' }, 403)

    const cycleId = c.req.param('id')
    const taskId = c.req.param('taskId')
    const body = c.req.valid('json')

    const [existing] = await db
      .select()
      .from(cropCycleTasks)
      .where(
        and(
          eq(cropCycleTasks.id, taskId),
          eq(cropCycleTasks.cropCycleId, cycleId),
          eq(cropCycleTasks.farmId, user.farmId),
        ),
      )
      .limit(1)

    if (!existing) return c.json({ error: 'Not found' }, 404)

    // Either half of the anchor can move, so the pair is checked as it will be
    // stored rather than field by field.
    if (body.stage !== undefined || body.offsetDays !== undefined) {
      const stageName = body.stage ?? existing.stage
      const offsetDays = body.offsetDays ?? existing.offsetDays

      const [stage] = await db
        .select({ durationDays: cropCycleStages.durationDays })
        .from(cropCycleStages)
        .where(
          and(
            eq(cropCycleStages.cropCycleId, cycleId),
            eq(cropCycleStages.farmId, user.farmId),
            eq(cropCycleStages.stage, stageName),
          ),
        )
        .limit(1)

      if (!stage) return c.json({ error: 'Cycle has no such stage' }, 400)
      if (offsetDays > stage.durationDays) {
        return c.json({ error: 'offsetDays is beyond the end of the stage' }, 400)
      }
    }

    const viewerLocale = await preferredLocaleForUser(user.id)
    const canonical = await canonicalTaskText(
      { templateName: body.templateName, description: body.description },
      user.farmId,
      authorLocaleHint(viewerLocale),
    )

    const updates: Partial<typeof existing> = { source: 'manual', updatedAt: new Date() }
    if (body.stage !== undefined) updates.stage = body.stage
    if (body.offsetDays !== undefined) updates.offsetDays = body.offsetDays
    if (body.defaultDurationHours !== undefined) {
      updates.defaultDurationHours = body.defaultDurationHours
    }
    if (body.templateName !== undefined) {
      updates.templateName = canonical.templateName ?? body.templateName
    }
    if (body.description !== undefined) {
      updates.description = canonical.description ?? body.description
    }
    if (body.templateName !== undefined || body.description !== undefined) {
      // Escalates a settled row to 'pending' but never downgrades one the retry
      // job still owes work on.
      Object.assign(updates, mergeContentLocale(existing, canonical.locale))
    }

    const [task] = await db
      .update(cropCycleTasks)
      .set(updates)
      .where(eq(cropCycleTasks.id, taskId))
      .returning()

    await clearAgronomySkipReason(cycleId, user.farmId)

    await logAudit({
      farmId: user.farmId,
      userId: user.id,
      action: 'update',
      entityType: 'crop_cycle_task',
      entityId: taskId,
      metadata: { cropCycleId: cycleId },
    })

    const [localized] = await localizeRows(
      [task],
      // Prose this author just submitted is echoed in their own words below;
      // only the columns they left alone are rendered from the stored English.
      TASK_TEXT_FIELDS.filter((field) => body[field] === undefined),
      user.farmId,
      viewerLocale,
    )

    return c.json({
      task: {
        ...localized,
        ...(body.templateName !== undefined ? { templateName: body.templateName } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
      },
    })
  },
)

cropRoutes.delete('/:id/lifecycle/tasks/:taskId', async (c) => {
  const user = c.get('user')
  if (!hasPermission(user, 'crops.manage')) return c.json({ error: 'Forbidden' }, 403)

  const cycleId = c.req.param('id')
  const taskId = c.req.param('taskId')

  const [existing] = await db
    .select()
    .from(cropCycleTasks)
    .where(
      and(
        eq(cropCycleTasks.id, taskId),
        eq(cropCycleTasks.cropCycleId, cycleId),
        eq(cropCycleTasks.farmId, user.farmId),
      ),
    )
    .limit(1)

  if (!existing) return c.json({ error: 'Not found' }, 404)

  await db.delete(cropCycleTasks).where(eq(cropCycleTasks.id, taskId))

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'delete',
    entityType: 'crop_cycle_task',
    entityId: taskId,
    metadata: { cropCycleId: cycleId },
  })

  return c.json({ ok: true })
})

cropRoutes.post('/:id/agronomy/regenerate', async (c) => {
  const user = c.get('user')
  if (!hasPermission(user, 'crops.manage')) return c.json({ error: 'Forbidden' }, 403)

  const cycleId = c.req.param('id')

  const cycle = await cycleForFarm(cycleId, user.farmId)
  if (!cycle) return c.json({ error: 'Not found' }, 404)

  // Awaited, unlike the create path: somebody asked for this and is waiting to
  // see whether it worked. The result says why when it did not, so the page can
  // tell them instead of leaving them clicking a button that appears to do
  // nothing.
  const result = await generateCropCycleAgronomy({
    cropCycleId: cycle.id,
    farmId: user.farmId,
    // The stored crop is the best record of what is growing here that survives
    // the create: a crop the lexicon knows was folded to its key, and one it
    // does not know is still in the farmer's own words.
    cropType: cycle.cropType,
    plantedAt: cycle.plantedAt,
  })

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'regenerate_agronomy',
    entityType: 'crop_cycle',
    entityId: cycleId,
    metadata: { ...result },
  })

  return c.json(result)
})
