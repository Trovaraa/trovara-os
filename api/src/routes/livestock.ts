import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, asc, desc, eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import {
  livestockBatches,
  livestockLogs,
  livestockScheduleEntries,
  plots,
  users,
} from '../db/schema.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { canAssignTasks } from '../lib/rbac.js'
import { logAudit } from '../lib/audit.js'
import { normalizeSpeciesForWrite } from '../lib/species-normalize.js'
import {
  AGRONOMY_LIMITS,
  estimateBatchWeightKg,
  generateBatchAgronomy,
  growthCurveColumns,
  isGrowthSelfConsistent,
  readGrowthCurve,
} from '../lib/poultry-agronomy.js'
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
 * Normalize a batch's or a log's `notes` to English for storage - the only prose
 * on either row, and the one column each locale pair describes (the two columns
 * the translation retry job repairs on `livestock_batches` and `livestock_logs`).
 *
 * `species` is deliberately not normalized here: the advisory playbooks read it
 * as a lookup key and the batch's agronomy is generated from the farmer's own
 * wording, so it goes through the deterministic species lexicon instead and
 * never reaches a translator. A batch `name` is a proper noun ("Shed A"), and
 * the log type enum, head counts and dates are not prose.
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
 * Render livestock prose in the viewer's language with ONE batched translation
 * call per response: every string across every row is collected first,
 * translated together (the service deduplicates and reads its cache in a single
 * query), then mapped back by position. An English viewer short-circuits before
 * any of this work, as does a caller that passes no fields.
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

/** The two prose columns on a schedule entry; everything else on the row is data. */
const SCHEDULE_TEXT_FIELDS = ['name', 'vaccine'] as const

/**
 * Normalize one string of a schedule entry to English.
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
 * Normalize the prose a farmer wrote on a schedule entry.
 *
 * One locale pair describes the whole row, so the row is only 'done' when both
 * of its strings are: an entry whose name translated and whose vaccine did not
 * still owes the retry job work, and labelling it done would hide that forever.
 */
async function canonicalEntryText(
  fields: { name?: string; vaccine?: string | null },
  farmId: string,
  hint: string | null,
): Promise<{ name?: string; vaccine?: string | null; locale: ContentLocaleMeta }> {
  const out: { name?: string; vaccine?: string | null } = {}
  let sourceLocale: string | null = null
  let status: 'done' | 'pending' = 'done'

  const normalize = async (value: string): Promise<string> => {
    const result = await canonicalString(value, farmId, hint)
    sourceLocale = sourceLocale ?? result.sourceLocale
    if (result.status === 'pending') status = 'pending'
    return result.english
  }

  if (fields.name !== undefined) out.name = await normalize(fields.name)
  if (fields.vaccine !== undefined) {
    out.vaccine = fields.vaccine ? await normalize(fields.vaccine) : fields.vaccine
  }

  return { ...out, locale: { sourceLocale, translationStatus: status } }
}

/**
 * Drop the note saying why this batch has no calendar, now that it has one.
 *
 * A batch the farm has written a date or a curve onto has a plan, whatever
 * generation last managed, and a banner explaining an empty calendar over a
 * calendar the farmer typed is worse than no banner at all.
 */
async function clearAgronomySkipReason(batchId: string, farmId: string): Promise<void> {
  await db
    .update(livestockBatches)
    .set({ agronomySkipReason: null })
    .where(and(eq(livestockBatches.id, batchId), eq(livestockBatches.farmId, farmId)))
}

const createBatchSchema = z.object({
  name: z.string().min(1).max(200),
  species: z.string().min(1).max(100),
  headCount: z.number().int().positive(),
  plotId: z.string().uuid().optional(),
  acquiredAt: z.string().datetime(),
  notes: z.string().max(2000).optional(),
})

const updateBatchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  species: z.string().min(1).max(100).optional(),
  headCount: z.number().int().nonnegative().optional(),
  plotId: z.string().uuid().nullable().optional(),
  notes: z.string().max(2000).optional(),
  active: z.boolean().optional(),
})

const createLogSchema = z.object({
  logType: z.enum(['feeding', 'vaccination', 'mortality', 'incident', 'health_check']),
  headCount: z.number().int().positive().optional(),
  notes: z.string().max(2000).optional(),
})

/**
 * The bounds come from the generator so a person and a model are held to the
 * same limits: a date or a weight the generator would have been rejected for
 * inventing is not one the farm can type in by hand either.
 */
const scheduleEntrySchema = z.object({
  dayOffset: z
    .number()
    .int()
    .min(AGRONOMY_LIMITS.minDayOffset)
    .max(AGRONOMY_LIMITS.maxDayOffset),
  name: z.string().trim().min(1).max(AGRONOMY_LIMITS.maxEntryTextLength),
  vaccine: z.string().trim().max(AGRONOMY_LIMITS.maxEntryTextLength).nullable().optional(),
})

// An edit takes ownership of the entry, so an empty body is refused rather than
// quietly relabelling a generated row as the farm's own without changing it.
const updateScheduleEntrySchema = scheduleEntrySchema
  .partial()
  .refine((body) => Object.keys(body).length > 0, { message: 'No fields to update' })

/**
 * All four figures together, never a subset. They are one statement about one
 * animal and they are checked against each other, so accepting three would
 * leave the batch on a curve half written by the farm and half by a model with
 * nothing recording which half is which.
 */
const growthCurveSchema = z
  .object({
    startWeightKg: z
      .number()
      .min(AGRONOMY_LIMITS.minStartWeightKg)
      .max(AGRONOMY_LIMITS.maxStartWeightKg),
    targetWeightKg: z
      .number()
      .min(AGRONOMY_LIMITS.minTargetWeightKg)
      .max(AGRONOMY_LIMITS.maxTargetWeightKg),
    dailyGainKg: z
      .number()
      .min(AGRONOMY_LIMITS.minDailyGainKg)
      .max(AGRONOMY_LIMITS.maxDailyGainKg),
    cycleDays: z.number().int().min(AGRONOMY_LIMITS.minCycleDays).max(AGRONOMY_LIMITS.maxCycleDays),
  })
  .refine((curve) => curve.targetWeightKg > curve.startWeightKg, {
    message: 'targetWeightKg must be greater than startWeightKg',
  })
  .refine(isGrowthSelfConsistent, {
    message: 'dailyGainKg over cycleDays does not reach targetWeightKg',
  })

export const livestockRoutes = new Hono<{ Variables: AppVariables }>()

livestockRoutes.use('*', authMiddleware)

livestockRoutes.get('/batches', async (c) => {
  const user = c.get('user')

  const rows = await db
    .select({
      id: livestockBatches.id,
      name: livestockBatches.name,
      species: livestockBatches.species,
      headCount: livestockBatches.headCount,
      plotId: livestockBatches.plotId,
      plotName: plots.name,
      acquiredAt: livestockBatches.acquiredAt,
      notes: livestockBatches.notes,
      active: livestockBatches.active,
      createdAt: livestockBatches.createdAt,
    })
    .from(livestockBatches)
    .leftJoin(plots, eq(livestockBatches.plotId, plots.id))
    .where(eq(livestockBatches.farmId, user.farmId))
    .orderBy(desc(livestockBatches.createdAt))

  const viewerLocale = await preferredLocaleForUser(user.id)
  const localized = await localizeRows(rows, ['notes'], user.farmId, viewerLocale)

  return c.json({ batches: localized })
})

livestockRoutes.get('/batches/:id/economics', async (c) => {
  const user = c.get('user')
  const batchId = c.req.param('id')

  const [batch] = await db
    .select()
    .from(livestockBatches)
    .where(and(eq(livestockBatches.id, batchId), eq(livestockBatches.farmId, user.farmId)))
    .limit(1)

  if (!batch) return c.json({ error: 'Not found' }, 404)

  const startCount = batch.startCount ?? batch.headCount
  const feedUsedKg = batch.feedUsedKg ?? 0
  const daysSinceStart = Math.max(
    0,
    Math.floor((Date.now() - batch.acquiredAt.getTime()) / 86400000),
  )

  // Withheld rather than guessed when the batch has no curve. Everything below
  // is derived from this one number, so a borrowed default would not just show
  // one wrong weight - it would put a feed conversion ratio on the page that
  // the farm could plan a closeout around.
  const curve = readGrowthCurve(batch)
  const estimatedWeightPerBird = estimateBatchWeightKg(curve, daysSinceStart)

  const weightGainKg =
    curve && estimatedWeightPerBird !== null
      ? Math.max(0, batch.headCount * estimatedWeightPerBird - startCount * curve.startWeightKg)
      : null
  const fcr =
    weightGainKg !== null && weightGainKg > 0
      ? Math.round((feedUsedKg / weightGainKg) * 100) / 100
      : null

  return c.json({
    batchId: batch.id,
    batchName: batch.name,
    feedUsedKg,
    startCount,
    currentHeadCount: batch.headCount,
    daysSinceStart,
    estimatedWeightPerBirdKg:
      estimatedWeightPerBird === null ? null : Math.round(estimatedWeightPerBird * 100) / 100,
    weightGainKg: weightGainKg === null ? null : Math.round(weightGainKg * 100) / 100,
    fcr,
    targetCloseoutAt: batch.targetCloseoutAt,
  })
})

livestockRoutes.get('/batches/:id/vaccination-schedule', async (c) => {
  const user = c.get('user')
  const batchId = c.req.param('id')

  const [batch] = await db
    .select()
    .from(livestockBatches)
    .where(and(eq(livestockBatches.id, batchId), eq(livestockBatches.farmId, user.farmId)))
    .limit(1)

  if (!batch) return c.json({ error: 'Not found' }, 404)

  const entries = await db
    .select()
    .from(livestockScheduleEntries)
    .where(
      and(
        eq(livestockScheduleEntries.batchId, batchId),
        eq(livestockScheduleEntries.farmId, user.farmId),
      ),
    )
    .orderBy(asc(livestockScheduleEntries.dayOffset))

  const vaccinationLogs = await db
    .select()
    .from(livestockLogs)
    .where(
      and(
        eq(livestockLogs.batchId, batchId),
        eq(livestockLogs.logType, 'vaccination'),
      ),
    )
    .orderBy(livestockLogs.createdAt)

  const viewerLocale = await preferredLocaleForUser(user.id)
  const localized = await localizeRows(entries, SCHEDULE_TEXT_FIELDS, user.farmId, viewerLocale)

  const now = new Date()
  const startDate = batch.acquiredAt

  const schedule = localized.map((entry) => {
    const dueDate = new Date(startDate.getTime() + entry.dayOffset * 86400000)
    const completed = vaccinationLogs.some((log) => {
      const logDay = Math.floor((log.createdAt.getTime() - startDate.getTime()) / 86400000)
      return Math.abs(logDay - entry.dayOffset) <= 1
    })

    let status: 'completed' | 'due' | 'upcoming' | 'overdue'
    if (completed) {
      status = 'completed'
    } else if (dueDate.toDateString() === now.toDateString()) {
      status = 'due'
    } else if (dueDate > now) {
      status = 'upcoming'
    } else {
      status = 'overdue'
    }

    return {
      id: entry.id,
      day: entry.dayOffset,
      name: entry.name,
      vaccine: entry.vaccine,
      source: entry.source,
      dueDate: dueDate.toISOString(),
      status,
    }
  })

  return c.json({
    batchId: batch.id,
    batchName: batch.name,
    acquiredAt: batch.acquiredAt,
    // An empty calendar is an answer, not an error: any batch may have one, and
    // a batch that has none yet is a supported state the client can offer to
    // fill rather than a 4xx it has to interpret.
    generated: schedule.length > 0,
    // The stored code, not a sentence: the client owns the wording and the
    // language the person reading it works in.
    agronomySkipReason: batch.agronomySkipReason,
    schedule,
    completedCount: schedule.filter((s) => s.status === 'completed').length,
  })
})

livestockRoutes.post(
  '/batches/:id/vaccination-schedule',
  zValidator('json', scheduleEntrySchema),
  async (c) => {
    const user = c.get('user')
    if (!canAssignTasks(user)) return c.json({ error: 'Forbidden' }, 403)

    const batchId = c.req.param('id')
    const body = c.req.valid('json')

    const [batch] = await db
      .select()
      .from(livestockBatches)
      .where(and(eq(livestockBatches.id, batchId), eq(livestockBatches.farmId, user.farmId)))
      .limit(1)

    if (!batch) return c.json({ error: 'Not found' }, 404)

    const canonical = await canonicalEntryText(
      { name: body.name, vaccine: body.vaccine ?? null },
      user.farmId,
      await authorLocaleForUserId(user.id),
    )

    const [entry] = await db
      .insert(livestockScheduleEntries)
      .values({
        farmId: user.farmId,
        batchId,
        dayOffset: body.dayOffset,
        name: canonical.name ?? body.name,
        vaccine: canonical.vaccine ?? body.vaccine ?? null,
        // Anything a person wrote is the farm's own record of its birds, so a
        // regeneration leaves it alone.
        source: 'manual',
        ...contentLocaleValues(canonical.locale),
      })
      .returning()

    await clearAgronomySkipReason(batchId, user.farmId)

    await logAudit({
      farmId: user.farmId,
      userId: user.id,
      action: 'create',
      entityType: 'livestock_schedule_entry',
      entityId: entry.id,
      metadata: { batchId },
    })

    // The author reads back their own words; the row holds the English.
    return c.json({ entry: { ...entry, name: body.name, vaccine: body.vaccine ?? null } }, 201)
  },
)

livestockRoutes.patch(
  '/batches/:id/vaccination-schedule/:entryId',
  zValidator('json', updateScheduleEntrySchema),
  async (c) => {
    const user = c.get('user')
    if (!canAssignTasks(user)) return c.json({ error: 'Forbidden' }, 403)

    const batchId = c.req.param('id')
    const entryId = c.req.param('entryId')
    const body = c.req.valid('json')

    const [existing] = await db
      .select()
      .from(livestockScheduleEntries)
      .where(
        and(
          eq(livestockScheduleEntries.id, entryId),
          eq(livestockScheduleEntries.batchId, batchId),
          eq(livestockScheduleEntries.farmId, user.farmId),
        ),
      )
      .limit(1)

    if (!existing) return c.json({ error: 'Not found' }, 404)

    const viewerLocale = await preferredLocaleForUser(user.id)
    const canonical = await canonicalEntryText(
      { name: body.name, vaccine: body.vaccine },
      user.farmId,
      authorLocaleHint(viewerLocale),
    )

    const updates: Partial<typeof existing> = { source: 'manual', updatedAt: new Date() }
    if (body.dayOffset !== undefined) updates.dayOffset = body.dayOffset
    if (body.name !== undefined) updates.name = canonical.name ?? body.name
    if (body.vaccine !== undefined) updates.vaccine = canonical.vaccine ?? body.vaccine
    if (body.name !== undefined || body.vaccine !== undefined) {
      // Escalates a settled row to 'pending' but never downgrades one the retry
      // job still owes work on.
      Object.assign(updates, mergeContentLocale(existing, canonical.locale))
    }

    const [entry] = await db
      .update(livestockScheduleEntries)
      .set(updates)
      .where(eq(livestockScheduleEntries.id, entryId))
      .returning()

    await clearAgronomySkipReason(batchId, user.farmId)

    await logAudit({
      farmId: user.farmId,
      userId: user.id,
      action: 'update',
      entityType: 'livestock_schedule_entry',
      entityId: entryId,
      metadata: { batchId },
    })

    const [localized] = await localizeRows(
      [entry],
      // Prose this author just submitted is echoed in their own words below;
      // only the columns they left alone are rendered from the stored English.
      SCHEDULE_TEXT_FIELDS.filter((field) => body[field] === undefined),
      user.farmId,
      viewerLocale,
    )

    return c.json({
      entry: {
        ...localized,
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.vaccine !== undefined ? { vaccine: body.vaccine } : {}),
      },
    })
  },
)

livestockRoutes.delete('/batches/:id/vaccination-schedule/:entryId', async (c) => {
  const user = c.get('user')
  if (!canAssignTasks(user)) return c.json({ error: 'Forbidden' }, 403)

  const batchId = c.req.param('id')
  const entryId = c.req.param('entryId')

  const [existing] = await db
    .select()
    .from(livestockScheduleEntries)
    .where(
      and(
        eq(livestockScheduleEntries.id, entryId),
        eq(livestockScheduleEntries.batchId, batchId),
        eq(livestockScheduleEntries.farmId, user.farmId),
      ),
    )
    .limit(1)

  if (!existing) return c.json({ error: 'Not found' }, 404)

  await db.delete(livestockScheduleEntries).where(eq(livestockScheduleEntries.id, entryId))

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'delete',
    entityType: 'livestock_schedule_entry',
    entityId: entryId,
    metadata: { batchId },
  })

  return c.json({ ok: true })
})

livestockRoutes.patch(
  '/batches/:id/growth-curve',
  zValidator('json', growthCurveSchema),
  async (c) => {
    const user = c.get('user')
    if (!canAssignTasks(user)) return c.json({ error: 'Forbidden' }, 403)

    const batchId = c.req.param('id')
    const body = c.req.valid('json')

    const [existing] = await db
      .select()
      .from(livestockBatches)
      .where(and(eq(livestockBatches.id, batchId), eq(livestockBatches.farmId, user.farmId)))
      .limit(1)

    if (!existing) return c.json({ error: 'Not found' }, 404)

    const [batch] = await db
      .update(livestockBatches)
      .set({
        ...growthCurveColumns(body),
        // The farm's own figures for its own birds. No regeneration overwrites
        // them again, which is the whole point of asking the farm for them.
        agronomySource: 'manual',
        agronomySkipReason: null,
      })
      .where(eq(livestockBatches.id, batchId))
      .returning()

    await logAudit({
      farmId: user.farmId,
      userId: user.id,
      action: 'update',
      entityType: 'livestock_batch',
      entityId: batchId,
      metadata: { growthCurve: body },
    })

    return c.json({ batch })
  },
)

livestockRoutes.post('/batches/:id/agronomy/regenerate', async (c) => {
  const user = c.get('user')
  if (!canAssignTasks(user)) return c.json({ error: 'Forbidden' }, 403)

  const batchId = c.req.param('id')

  const [batch] = await db
    .select()
    .from(livestockBatches)
    .where(and(eq(livestockBatches.id, batchId), eq(livestockBatches.farmId, user.farmId)))
    .limit(1)

  if (!batch) return c.json({ error: 'Not found' }, 404)

  // Awaited, unlike the create path: somebody asked for this and is waiting to
  // see whether it worked. The result says why when it did not, so the page can
  // tell them instead of leaving them clicking a button that appears to do
  // nothing.
  const result = await generateBatchAgronomy({
    batchId: batch.id,
    farmId: user.farmId,
    species: batch.species,
    batchType: batch.batchType,
    headCount: batch.headCount,
    acquiredAt: batch.acquiredAt,
  })

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'regenerate_agronomy',
    entityType: 'livestock_batch',
    entityId: batchId,
    metadata: { ...result },
  })

  return c.json(result)
})

livestockRoutes.get('/batches/:id', async (c) => {
  const user = c.get('user')
  const batchId = c.req.param('id')

  const [batch] = await db
    .select({
      id: livestockBatches.id,
      name: livestockBatches.name,
      species: livestockBatches.species,
      headCount: livestockBatches.headCount,
      plotId: livestockBatches.plotId,
      plotName: plots.name,
      acquiredAt: livestockBatches.acquiredAt,
      notes: livestockBatches.notes,
      active: livestockBatches.active,
      createdAt: livestockBatches.createdAt,
    })
    .from(livestockBatches)
    .leftJoin(plots, eq(livestockBatches.plotId, plots.id))
    .where(and(eq(livestockBatches.id, batchId), eq(livestockBatches.farmId, user.farmId)))
    .limit(1)

  if (!batch) return c.json({ error: 'Not found' }, 404)

  const viewerLocale = await preferredLocaleForUser(user.id)
  const [localized] = await localizeRows([batch], ['notes'], user.farmId, viewerLocale)

  return c.json({ batch: localized })
})

livestockRoutes.post('/batches', zValidator('json', createBatchSchema), async (c) => {
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

  // `species` is read as a lookup key by the vaccination schedule, the weight
  // curve and the advisory playbooks, so a species typed in the operator's own
  // language is resolved here and the poultry type is recorded in the enum that
  // actually expresses it. Species the enum cannot express are stored as typed.
  const { species, batchType } = normalizeSpeciesForWrite(body.species)

  const canonical = await canonicalNotes(
    body.notes,
    user.farmId,
    await authorLocaleForUserId(user.id),
  )

  const [batch] = await db
    .insert(livestockBatches)
    .values({
      farmId: user.farmId,
      name: body.name,
      species,
      batchType,
      headCount: body.headCount,
      plotId: body.plotId,
      acquiredAt: new Date(body.acquiredAt),
      notes: canonical.text ?? body.notes,
      ...contentLocaleValues(canonical.locale),
    })
    .returning()

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'create',
    entityType: 'livestock_batch',
    entityId: batch.id,
  })

  // Deliberately not awaited: establishing the agronomy calls a model, and a
  // farmer registering a flock at the shed door must not wait on one, nor lose
  // the batch when one is unavailable. The service persists nothing when it
  // cannot answer, so the batch stays in the supported no-agronomy state and
  // the farm can trigger it again from the batch page.
  void generateBatchAgronomy({
    batchId: batch.id,
    farmId: user.farmId,
    species: batch.species,
    batchType: batch.batchType,
    headCount: batch.headCount,
    acquiredAt: batch.acquiredAt,
  }).catch(() => undefined)

  // The author reads back their own words; the row holds the English.
  return c.json({ batch: { ...batch, notes: body.notes ?? batch.notes } }, 201)
})

livestockRoutes.patch('/batches/:id', zValidator('json', updateBatchSchema), async (c) => {
  const user = c.get('user')
  if (!canAssignTasks(user)) return c.json({ error: 'Forbidden' }, 403)

  const batchId = c.req.param('id')
  const body = c.req.valid('json')

  const [existing] = await db
    .select()
    .from(livestockBatches)
    .where(and(eq(livestockBatches.id, batchId), eq(livestockBatches.farmId, user.farmId)))
    .limit(1)

  if (!existing) return c.json({ error: 'Not found' }, 404)

  if (body.plotId) {
    const [plot] = await db
      .select()
      .from(plots)
      .where(and(eq(plots.id, body.plotId), eq(plots.farmId, user.farmId)))
      .limit(1)
    if (!plot) return c.json({ error: 'Invalid plot' }, 400)
  }

  const viewerLocale = await preferredLocaleForUser(user.id)
  const authorLocale = authorLocaleHint(viewerLocale)
  const canonical = await canonicalNotes(body.notes, user.farmId, authorLocale)

  const updates: Partial<typeof existing> = {}
  if (body.name !== undefined) updates.name = body.name
  if (body.species !== undefined) {
    // Re-derive both: editing "noiler" to "goat" must not leave the old batch
    // type behind, still collecting a 42-day meat-bird advisory.
    const { species, batchType } = normalizeSpeciesForWrite(body.species)
    updates.species = species
    updates.batchType = batchType
  }
  if (body.headCount !== undefined) updates.headCount = body.headCount
  if (body.plotId !== undefined) updates.plotId = body.plotId
  if (body.notes !== undefined) {
    updates.notes = canonical.text ?? body.notes
    // Escalates a row to 'pending' but never downgrades one the retry job still
    // owes work on. A patch that carries no notes never touches the pair.
    Object.assign(updates, mergeContentLocale(existing, canonical.locale))
  }
  if (body.active !== undefined) updates.active = body.active

  const [batch] = await db
    .update(livestockBatches)
    .set(updates)
    .where(eq(livestockBatches.id, batchId))
    .returning()

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'update',
    entityType: 'livestock_batch',
    entityId: batchId,
  })

  // A batch corrected from "Goats" to "noiler" was refused a calendar for a
  // reason that has stopped being true, so the species edit re-asks. Generation
  // rewrites the note either way, which is why nothing clears it here: a rename
  // that is still unplaceable records that again, honestly. Farm-authored
  // entries and a farm-owned curve are out of the regeneration's scope.
  if (updates.species !== undefined && updates.species !== existing.species) {
    void generateBatchAgronomy({
      batchId: batch.id,
      farmId: user.farmId,
      species: batch.species,
      batchType: batch.batchType,
      headCount: batch.headCount,
      acquiredAt: batch.acquiredAt,
    }).catch(() => undefined)
  }

  // Notes this author just wrote are echoed in their own words (no round trip);
  // a patch that left them alone renders the stored English for the viewer.
  const [localized] = await localizeRows(
    [batch],
    body.notes !== undefined ? [] : ['notes'],
    user.farmId,
    viewerLocale,
  )

  return c.json({
    batch: body.notes !== undefined ? { ...localized, notes: body.notes } : localized,
  })
})

livestockRoutes.delete('/batches/:id', async (c) => {
  const user = c.get('user')
  if (!canAssignTasks(user)) return c.json({ error: 'Forbidden' }, 403)

  const batchId = c.req.param('id')

  const [existing] = await db
    .select()
    .from(livestockBatches)
    .where(and(eq(livestockBatches.id, batchId), eq(livestockBatches.farmId, user.farmId)))
    .limit(1)

  if (!existing) return c.json({ error: 'Not found' }, 404)

  await db
    .update(livestockBatches)
    .set({ active: false })
    .where(eq(livestockBatches.id, batchId))

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'deactivate',
    entityType: 'livestock_batch',
    entityId: batchId,
  })

  return c.json({ ok: true })
})

livestockRoutes.get('/batches/:id/logs', async (c) => {
  const user = c.get('user')
  const batchId = c.req.param('id')

  const [batch] = await db
    .select()
    .from(livestockBatches)
    .where(and(eq(livestockBatches.id, batchId), eq(livestockBatches.farmId, user.farmId)))
    .limit(1)

  if (!batch) return c.json({ error: 'Not found' }, 404)

  const logs = await db
    .select()
    .from(livestockLogs)
    .where(and(eq(livestockLogs.batchId, batchId), eq(livestockLogs.farmId, user.farmId)))
    .orderBy(desc(livestockLogs.createdAt))

  const viewerLocale = await preferredLocaleForUser(user.id)
  const localized = await localizeRows(logs, ['notes'], user.farmId, viewerLocale)

  return c.json({ logs: localized })
})

livestockRoutes.post('/batches/:id/logs', zValidator('json', createLogSchema), async (c) => {
  const user = c.get('user')
  const batchId = c.req.param('id')
  const body = c.req.valid('json')

  const [batch] = await db
    .select()
    .from(livestockBatches)
    .where(and(eq(livestockBatches.id, batchId), eq(livestockBatches.farmId, user.farmId)))
    .limit(1)

  if (!batch) return c.json({ error: 'Not found' }, 404)
  if (!batch.active) return c.json({ error: 'Batch is inactive' }, 400)

  if (body.logType === 'mortality') {
    if (!body.headCount) return c.json({ error: 'headCount required for mortality' }, 400)
    if (body.headCount > batch.headCount) {
      return c.json({ error: 'Mortality count exceeds batch head count' }, 400)
    }
  }

  // Normalized before the transaction opens: a translation round trip must not
  // hold the mortality head-count update open.
  const canonical = await canonicalNotes(
    body.notes,
    user.farmId,
    await authorLocaleForUserId(user.id),
  )

  const log = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(livestockLogs)
      .values({
        farmId: user.farmId,
        batchId,
        logType: body.logType,
        headCount: body.headCount,
        notes: canonical.text ?? body.notes,
        ...contentLocaleValues(canonical.locale),
        recordedById: user.id,
      })
      .returning()

    if (body.logType === 'mortality' && body.headCount) {
      await tx
        .update(livestockBatches)
        .set({ headCount: batch.headCount - body.headCount })
        .where(eq(livestockBatches.id, batchId))
    }

    return row
  })

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'create',
    entityType: 'livestock_log',
    entityId: log.id,
    metadata: { logType: body.logType, batchId },
  })

  // The author reads back their own words; the row holds the English.
  return c.json({ log: { ...log, notes: body.notes ?? log.notes } }, 201)
})
