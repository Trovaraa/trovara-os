import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { users } from '../db/schema.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { canAssignTasks, canApproveTasks } from '../lib/rbac.js'
import {
  CENSUS_TEXT_FIELDS,
  createCensusSurvey,
  currentVerifiedCensus,
  listCensusByPlot,
  submitCensusForTask,
  surveyHeightsAsNumbers,
  verifyCensusSurvey,
} from '../lib/census-service.js'
import {
  authorLocaleForUserId,
  authorLocaleHint,
  toCanonicalEnglish,
  toViewerLocaleMany,
} from '../lib/content-locale.js'
import { resolveStaffReplyLocale } from '../lib/reply-locale.js'

async function preferredLocaleForUser(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ preferredLocale: users.preferredLocale })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  return row?.preferredLocale ?? null
}

/**
 * Prose a census request can carry. The survey's own columns come from
 * `CENSUS_TEXT_FIELDS`, so a field added there is normalized here without this
 * route having to be edited; `completionNote` is the task's prose, written by
 * `submitCensusForTask` under the same locale pair.
 *
 * `cropType` is never in here: it is an exact lookup key resolved against the
 * crop lexicon, and `countingMethod` is excluded on purpose — the retry job
 * does not sweep that column, so a row marked 'pending' for it would be set
 * back to 'done' with the method still in the author's language.
 */
const TASK_CENSUS_TEXT_FIELDS = [...CENSUS_TEXT_FIELDS, 'completionNote'] as const
type CensusTextField = (typeof TASK_CENSUS_TEXT_FIELDS)[number]

/** The prose fields a request actually filled in, as the author typed them. */
function authorProse<F extends CensusTextField>(
  body: Partial<Record<F, string | null | undefined>>,
  fields: readonly F[],
): Partial<Record<F, string>> {
  const prose: Partial<Record<F, string>> = {}
  for (const field of fields) {
    const value = body[field]
    if (typeof value === 'string' && value.trim() !== '') prose[field] = value
  }
  return prose
}

type CanonicalFields<F extends CensusTextField> = {
  text: Partial<Record<F, string>>
  sourceLocale: string | null
  translationStatus: 'done' | 'pending'
}

/**
 * Normalize a census write's free text to English for storage. The service is
 * not allowed to call an LLM, so this is where it happens.
 *
 * Each field is its own column, so they are translated as concurrent calls
 * rather than one merged prompt: latency is one round trip and neither field can
 * bleed into the other's column. `translation_status` is per row, so a single
 * pending field leaves the whole row pending for the retry job — and a request
 * with no prose at all writes no locale columns, leaving the schema defaults.
 */
async function toCanonicalFields<F extends CensusTextField>(
  prose: Partial<Record<F, string>>,
  farmId: string,
  sourceLocale: string | null,
): Promise<CanonicalFields<F>> {
  const entries = Object.entries(prose) as [F, string][]
  if (entries.length === 0) return { text: {}, sourceLocale: null, translationStatus: 'done' }

  let results
  try {
    results = await Promise.all(
      entries.map(([, text]) => toCanonicalEnglish({ text, farmId, sourceLocale })),
    )
  } catch {
    // A translation failure must never fail the worker's write. The service
    // swallows LLM errors itself, so reaching here means something around it
    // threw — the budget module, the detector — and the survey still has to be
    // recorded. The caller's hint is already `authorLocaleHint` output, so it is
    // either null or a real non-English locale, never a bare 'en' the retry job
    // would short-circuit on.
    return {
      text: Object.fromEntries(entries) as Partial<Record<F, string>>,
      sourceLocale,
      translationStatus: 'pending',
    }
  }

  const text: Partial<Record<F, string>> = {}
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
 * Render survey prose in the viewer's language with ONE batched translation call
 * per response: every string across every row is collected first, translated
 * together, then mapped back by position. An English viewer short-circuits
 * before any of that work — no locale lookup result is used, no cache query and
 * no LLM call.
 *
 * Only the columns in `CENSUS_TEXT_FIELDS` are ever handed over. Crop types are
 * lookup keys, varieties and staff names are proper nouns, and counts, heights,
 * units, coordinates and the verification status carry no prose.
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

const censusBodySchema = z
  .object({
    plotId: z.string().uuid(),
    cropType: z.string().trim().min(1).max(100),
    cropVariety: z.string().trim().max(100).nullable().optional(),
    plantCount: z.number().int().min(0),
    minHeight: z.number().min(0).nullable().optional(),
    maxHeight: z.number().min(0).nullable().optional(),
    avgHeight: z.number().min(0).nullable().optional(),
    heightUnit: z.enum(['cm', 'm']).default('cm'),
    sampleSize: z.number().int().min(0).nullable().optional(),
    countingMethod: z.string().trim().max(200).nullable().optional(),
    conditionNotes: z.string().trim().max(2000).nullable().optional(),
    mortalityNotes: z.string().trim().max(2000).nullable().optional(),
    surveyedAt: z.string().datetime().nullable().optional(),
    latitude: z.union([z.string().max(32), z.number()]).nullable().optional(),
    longitude: z.union([z.string().max(32), z.number()]).nullable().optional(),
    taskId: z.string().uuid().nullable().optional(),
    photoUrl: z.string().max(2_000_000).nullable().optional(),
    voiceUrl: z.string().max(2_000_000).nullable().optional(),
  })
  .superRefine((value, ctx) => {
    if (
      value.minHeight != null &&
      value.maxHeight != null &&
      value.minHeight > value.maxHeight
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'minHeight cannot exceed maxHeight',
        path: ['minHeight'],
      })
    }
  })

const taskCensusSchema = z
  .object({
    plotId: z.string().uuid().optional(),
    cropType: z.string().trim().min(1).max(100),
    cropVariety: z.string().trim().max(100).nullable().optional(),
    plantCount: z.number().int().min(0),
    minHeight: z.number().min(0).nullable().optional(),
    maxHeight: z.number().min(0).nullable().optional(),
    avgHeight: z.number().min(0).nullable().optional(),
    heightUnit: z.enum(['cm', 'm']).default('cm'),
    sampleSize: z.number().int().min(0).nullable().optional(),
    countingMethod: z.string().trim().max(200).nullable().optional(),
    conditionNotes: z.string().trim().max(2000).nullable().optional(),
    mortalityNotes: z.string().trim().max(2000).nullable().optional(),
    surveyedAt: z.string().datetime().nullable().optional(),
    latitude: z.union([z.string().max(32), z.number()]).nullable().optional(),
    longitude: z.union([z.string().max(32), z.number()]).nullable().optional(),
    photoUrl: z.string().max(2_000_000).nullable().optional(),
    voiceUrl: z.string().max(2_000_000).nullable().optional(),
    completionNote: z.string().max(2000).nullable().optional(),
  })
  .superRefine((value, ctx) => {
    if (
      value.minHeight != null &&
      value.maxHeight != null &&
      value.minHeight > value.maxHeight
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'minHeight cannot exceed maxHeight',
        path: ['minHeight'],
      })
    }
  })

const verifySchema = z.object({
  status: z.enum(['verified', 'rejected']),
  rejectionReason: z.string().trim().min(5).max(2000).nullable().optional(),
})

export const censusRoutes = new Hono<{ Variables: AppVariables }>()

censusRoutes.use('*', authMiddleware)

censusRoutes.get('/plots/:plotId', async (c) => {
  const user = c.get('user')
  const plotId = c.req.param('plotId')
  const surveys = await listCensusByPlot(user.farmId, plotId)
  const viewerLocale = await preferredLocaleForUser(user.id)
  const localized = await localizeRows(
    surveys.map(surveyHeightsAsNumbers),
    CENSUS_TEXT_FIELDS,
    user.farmId,
    viewerLocale,
  )
  return c.json({ surveys: localized })
})

censusRoutes.get('/plots/:plotId/current', async (c) => {
  const user = c.get('user')
  const plotId = c.req.param('plotId')
  const surveys = await currentVerifiedCensus(user.farmId, plotId)
  const viewerLocale = await preferredLocaleForUser(user.id)
  const localized = await localizeRows(
    surveys.map(surveyHeightsAsNumbers),
    CENSUS_TEXT_FIELDS,
    user.farmId,
    viewerLocale,
  )
  return c.json({ surveys: localized })
})

censusRoutes.post('/', zValidator('json', censusBodySchema), async (c) => {
  const user = c.get('user')
  if (!canAssignTasks(user)) return c.json({ error: 'Forbidden' }, 403)

  const body = c.req.valid('json')
  const typed = authorProse(body, CENSUS_TEXT_FIELDS)
  const canonical = await toCanonicalFields(
    typed,
    user.farmId,
    await authorLocaleForUserId(user.id),
  )

  try {
    const survey = await createCensusSurvey(
      user,
      {
        ...body,
        conditionNotes: canonical.text.conditionNotes ?? body.conditionNotes,
        mortalityNotes: canonical.text.mortalityNotes ?? body.mortalityNotes,
        // Text the LLM could not turn into English lands as 'pending' so the
        // retry job still owns the row instead of it claiming to be English.
        sourceLocale: canonical.sourceLocale,
        translationStatus: canonical.translationStatus,
      },
      { autoVerify: false },
    )
    // The author reads back their own words; the row holds the English.
    return c.json({ survey: { ...surveyHeightsAsNumbers(survey), ...typed } }, 201)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed'
    if (message === 'FORBIDDEN') return c.json({ error: 'Forbidden' }, 403)
    if (message === 'Invalid plot' || message === 'Invalid task') {
      return c.json({ error: message }, 400)
    }
    return c.json({ error: message }, 400)
  }
})

censusRoutes.post('/:id/verify', zValidator('json', verifySchema), async (c) => {
  const user = c.get('user')
  if (!canApproveTasks(user)) return c.json({ error: 'Forbidden' }, 403)

  const body = c.req.valid('json')
  const viewerLocale = await preferredLocaleForUser(user.id)
  const authorLocale = authorLocaleHint(viewerLocale)
  const typed = authorProse(body, CENSUS_TEXT_FIELDS)
  const canonical = await toCanonicalFields(typed, user.farmId, authorLocale)

  try {
    const survey = await verifyCensusSurvey(
      user,
      c.req.param('id'),
      body.status,
      canonical.text.rejectionReason ?? body.rejectionReason,
      { sourceLocale: canonical.sourceLocale, translationStatus: canonical.translationStatus },
    )
    // The worker's notes are canonical English rendered for this verifier; the
    // rejection reason is the verifier's own sentence and is echoed as typed.
    const echoesReason = body.status === 'rejected' && typed.rejectionReason != null
    const [localized] = await localizeRows(
      [surveyHeightsAsNumbers(survey)],
      CENSUS_TEXT_FIELDS.filter((field) => !(echoesReason && field === 'rejectionReason')),
      user.farmId,
      viewerLocale,
    )
    return c.json({
      survey: echoesReason ? { ...localized, rejectionReason: typed.rejectionReason } : localized,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed'
    if (message === 'FORBIDDEN') return c.json({ error: 'Forbidden' }, 403)
    if (message === 'NOT_FOUND') return c.json({ error: 'Not found' }, 404)
    if (message === 'SELF_VERIFY') {
      return c.json({ error: 'You cannot verify your own census submission' }, 400)
    }
    if (message === 'ALREADY_RESOLVED') {
      return c.json({ error: 'Survey already verified or rejected' }, 400)
    }
    if (message === 'REJECTION_REASON_REQUIRED') {
      return c.json({ error: 'rejectionReason is required' }, 400)
    }
    return c.json({ error: message }, 400)
  }
})

export const taskCensusRoutes = new Hono<{ Variables: AppVariables }>()

taskCensusRoutes.use('*', authMiddleware)

taskCensusRoutes.post(
  '/:id/census-submission',
  zValidator('json', taskCensusSchema),
  async (c) => {
    const user = c.get('user')
    const body = c.req.valid('json')
    // The completion note goes on the task under the same locale pair as the
    // survey notes, so it is normalized in the same batch.
    const canonical = await toCanonicalFields(
      authorProse(body, TASK_CENSUS_TEXT_FIELDS),
      user.farmId,
      await authorLocaleForUserId(user.id),
    )

    try {
      const survey = await submitCensusForTask(user, c.req.param('id'), {
        ...body,
        plotId: body.plotId ?? '',
        cropType: body.cropType,
        plantCount: body.plantCount,
        conditionNotes: canonical.text.conditionNotes ?? body.conditionNotes,
        mortalityNotes: canonical.text.mortalityNotes ?? body.mortalityNotes,
        completionNote: canonical.text.completionNote ?? body.completionNote,
        sourceLocale: canonical.sourceLocale,
        translationStatus: canonical.translationStatus,
      })
      // The worker reads back their own words; the row holds the English.
      return c.json(
        {
          survey: {
            ...surveyHeightsAsNumbers(survey),
            ...authorProse(body, CENSUS_TEXT_FIELDS),
          },
        },
        201,
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed'
      if (message === 'FORBIDDEN') return c.json({ error: 'Forbidden' }, 403)
      if (message === 'NOT_FOUND') return c.json({ error: 'Not found' }, 404)
      if (message === 'PLOT_REQUIRED') return c.json({ error: 'plotId is required' }, 400)
      return c.json({ error: message }, 400)
    }
  },
)
