import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, desc, eq, gte, lte } from 'drizzle-orm'
import { db } from '../db/index.js'
import { advisoryObservations, farms, users } from '../db/schema.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { requireRole } from '../lib/rbac.js'
import {
  listAdvisorySubjects,
  listRecommendationsForRole,
  listOpenRecommendations,
  listCompletedRecommendations,
  recommendationStats,
  runAdvisoryEngine,
  updateRecommendationStatus,
  buildInsightTips,
  isLocalizedFallbackTip,
  type AdvisoryRecommendationRow,
  type AdvisorySubject,
  type InsightKey,
  type InsightTip,
} from '../lib/advisory-engine.js'
import {
  CROP_OBSERVATION_TILES,
  POULTRY_OBSERVATION_TILES,
} from '../lib/advisory-playbooks.js'
import { advisoryCloseLine } from '../lib/advisory-close.js'
import { authorLocaleHint, toCanonicalEnglish, toViewerLocaleMany } from '../lib/content-locale.js'
import {
  isAdvisoryReasonCode,
  renderAdvisoryFallback,
  type FallbackText,
} from '../lib/advisory-fallback-messages.js'
import { containsPesticideLanguage } from '../lib/pesticide-filter.js'
import { resolveMarketplaceProducts } from '../lib/marketplace-search.js'
import { resolveStaffReplyLocale, type ReplyLocale } from '../lib/reply-locale.js'
import {
  cronFarmIdAllowed,
  requestHasCronSecret,
} from '../lib/cron-auth.js'

export const advisoryRoutes = new Hono<{ Variables: AppVariables }>()

const statusSchema = z.object({
  status: z.enum(['accepted', 'ignored', 'completed']),
})

const observationSchema = z.object({
  tiles: z.array(z.string().min(1).max(40)).min(1).max(12),
  note: z.string().max(1000).optional(),
  sourceType: z.enum(['crop_cycle', 'livestock_batch', 'weather', 'farm']).optional(),
  sourceId: z.string().max(80).optional(),
  loggedAt: z.string().datetime().optional(),
})

const cronSchema = z.object({
  farmId: z.string().uuid().optional(),
})

/** Language of the person making the request — never the farm owner's. */
async function viewerLocale(userId: string): Promise<ReplyLocale> {
  const [pref] = await db
    .select({ preferredLocale: users.preferredLocale })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  return resolveStaffReplyLocale(pref?.preferredLocale)
}

/**
 * Normalize an observation note to English for storage. A degraded translator
 * returns the author's own words with status 'pending' so the retry job repairs
 * the row later: a note stored as 'done' while still holding French would never
 * be swept again.
 */
async function canonicalNote(
  text: string,
  farmId: string,
  hint: ReplyLocale | null,
): Promise<{ english: string; sourceLocale: string | null; status: 'done' | 'pending' }> {
  try {
    const result = await toCanonicalEnglish({ text, farmId, sourceLocale: hint })
    return { english: result.english, sourceLocale: result.sourceLocale, status: result.status }
  } catch {
    // A translation failure must never fail the worker's write. The locale stays
    // null rather than defaulting to 'en': the translator threw before it could
    // establish one, and a pending row claiming 'en' is one the retry job would
    // short-circuit and promote to 'done' still holding the worker's language.
    return { english: text, sourceLocale: hint, status: 'pending' }
  }
}

/**
 * Advisory prose is generated and stored in canonical English, so a single
 * response can carry dozens of English strings. Callers stage every string,
 * spend one batched translation call, then read each string back by slot.
 */
type ProseBatch = {
  /** True for an English viewer: nothing is staged and no call is made. */
  passthrough: boolean
  locale: ReplyLocale
  stage: (text: string) => number
  translate: () => Promise<void>
  read: (slot: number) => string
}

function proseBatch(farmId: string, locale: ReplyLocale): ProseBatch {
  const english: string[] = []
  let rendered: string[] | null = null

  return {
    passthrough: locale === 'en',
    locale,
    stage(text) {
      english.push(text)
      return english.length - 1
    },
    async translate() {
      if (english.length === 0) return
      // A degraded translator must leave readable English, not fail the read.
      rendered = await toViewerLocaleMany({
        texts: english,
        targetLocale: locale,
        farmId,
      }).catch(() => null)
    },
    read(slot) {
      return rendered?.[slot] || english[slot]
    },
  }
}

/** Rebuilds one staged collection; only valid once the batch has run. */
type Staged<T> = () => T

/** `payload` is jsonb, and rows written by older engine versions may lack prose. */
function payloadProse(payload: unknown): { happeningNow: string; whatNext: string } | null {
  if (!payload || typeof payload !== 'object') return null
  const { happeningNow, whatNext } = payload as Record<string, unknown>
  if (typeof happeningNow !== 'string' || typeof whatNext !== 'string') return null
  return { happeningNow, whatNext }
}

function payloadReasonCode(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const { reasonCode } = payload as Record<string, unknown>
  return typeof reasonCode === 'string' ? reasonCode : null
}

/**
 * A staged string in the viewer's language, falling back to the pre-translated
 * table.
 *
 * Stored recommendation prose may be an AI plan or a playbook seed. When
 * `batch.read` hands back the English it was given because translation could
 * not run, a known reason code supplies the safe pre-translated playbook text.
 *
 * This is the rule `seedLine` applies in `advisory-engine.ts`, deliberately:
 * an advisory pushed to a worker over WhatsApp and the same advisory read back
 * on the page should not be in different languages. The trade is that the table
 * line is generic, so a tip whose stored sentence had a plot name composed into
 * it loses that name here. Being readable in the right language beats naming the
 * plot in a language the reader does not have.
 */
function proseForViewer(
  batch: ProseBatch,
  slot: number,
  english: string,
  reasonCode: string | null,
  key: keyof FallbackText,
): string {
  const rendered = batch.read(slot)
  if (rendered !== english) return rendered
  if (!reasonCode || !isAdvisoryReasonCode(reasonCode)) return rendered
  return renderAdvisoryFallback(reasonCode, batch.locale)[key]
}

/**
 * `ruleKey`, `reasonCode`, `needQuery`, `source` and ids are machine keys, and
 * marketplace products are proper nouns and prices, so only the prose is staged.
 *
 * Not every tip is staged. A tip whose prose fell back to the fixed playbook
 * seed arrives already rendered in the viewer's language from the pre-translated
 * table, because the translator below needs the same LLM whose absence produced
 * the seed. The decision is per tip and not per response: one page can hold a
 * rule served from an earlier generation next to a rule that just fell back.
 */
function stageTips(batch: ProseBatch, tips: InsightTip[]): Staged<InsightTip[]> {
  if (batch.passthrough || tips.length === 0) return () => tips
  const slots = tips.map((tip) =>
    isLocalizedFallbackTip(tip) ? null : [batch.stage(tip.happeningNow), batch.stage(tip.whatNext)],
  )
  return () =>
    tips.map((tip, i) => {
      const slot = slots[i]
      return slot == null
        ? tip
        : { ...tip, happeningNow: batch.read(slot[0]), whatNext: batch.read(slot[1]) }
    })
}

function stageRecommendations(
  batch: ProseBatch,
  rows: AdvisoryRecommendationRow[],
): Staged<AdvisoryRecommendationRow[]> {
  if (batch.passthrough || rows.length === 0) return () => rows
  const slots = rows.map((row) => {
    const prose = payloadProse(row.payload)
    return {
      english: prose,
      reasonCode: payloadReasonCode(row.payload),
      prose: prose ? [batch.stage(prose.happeningNow), batch.stage(prose.whatNext)] : null,
      aiSummary: row.aiSummary ? batch.stage(row.aiSummary) : null,
    }
  })
  return () =>
    rows.map((row, i) => {
      const slot = slots[i]
      return {
        ...row,
        payload:
          slot.prose && slot.english
            ? {
                ...(row.payload as Record<string, unknown>),
                happeningNow: proseForViewer(
                  batch,
                  slot.prose[0],
                  slot.english.happeningNow,
                  slot.reasonCode,
                  'happeningNow',
                ),
                whatNext: proseForViewer(
                  batch,
                  slot.prose[1],
                  slot.english.whatNext,
                  slot.reasonCode,
                  'whatNext',
                ),
              }
            : row.payload,
        // The AI summary is genuinely generated prose with no table entry, so an
        // untranslatable one stays English rather than being replaced.
        aiSummary: slot.aiSummary == null ? row.aiSummary : batch.read(slot.aiSummary),
      }
    })
}

type ObservationRow = typeof advisoryObservations.$inferSelect

/**
 * An observation's only prose is `note`, stored in canonical English like every
 * other free-text column. `tiles` and `sourceId` are identifiers the advisory
 * engine and the client tile grid match exactly, so they are never staged.
 */
function stageObservations(
  batch: ProseBatch,
  rows: ObservationRow[],
): Staged<ObservationRow[]> {
  if (batch.passthrough || rows.length === 0) return () => rows
  const slots = rows.map((row) => (row.note ? batch.stage(row.note) : null))
  return () =>
    rows.map((row, i) => {
      const slot = slots[i]
      return slot == null ? row : { ...row, note: batch.read(slot) }
    })
}

/** A subject's `label` names a crop, plot or batch, so only `nextHint` is prose. */
function stageSubjects(batch: ProseBatch, subjects: AdvisorySubject[]): Staged<AdvisorySubject[]> {
  if (batch.passthrough || subjects.length === 0) return () => subjects
  const slots = subjects.map((subject) => (subject.nextHint ? batch.stage(subject.nextHint) : null))
  return () =>
    subjects.map((subject, i) => {
      const slot = slots[i]
      return slot == null ? subject : { ...subject, nextHint: batch.read(slot) }
    })
}

advisoryRoutes.use('*', async (c, next) => {
  if (c.req.path.endsWith('/run') && c.req.method === 'POST' && requestHasCronSecret(c)) {
    await next()
    return
  }
  return authMiddleware(c, next)
})

advisoryRoutes.get('/home', async (c) => {
  const user = c.get('user')
  requireRole(user, 'owner', 'supervisor', 'field_worker')

  const locale = await viewerLocale(user.id)

  // Generate tips if none exist yet (local/dev and first visit after seed).
  let recommendations = await listRecommendationsForRole(user.farmId, user.role, 20)
  if (recommendations.length === 0) {
    await runAdvisoryEngine(user.farmId)
    recommendations = await listRecommendationsForRole(user.farmId, user.role, 20)
  }

  const [subjects, stats] = await Promise.all([
    listAdvisorySubjects(user.farmId),
    recommendationStats(user.farmId),
  ])

  const batch = proseBatch(user.farmId, locale)
  const localizedRecommendations = stageRecommendations(batch, recommendations)
  const localizedSubjects = stageSubjects(batch, subjects)
  await batch.translate()

  return c.json({
    subjects: localizedSubjects(),
    recommendations: localizedRecommendations(),
    stats,
    tiles: {
      crop: CROP_OBSERVATION_TILES,
      poultry: POULTRY_OBSERVATION_TILES,
    },
    closeLine: {
      livestock: advisoryCloseLine(locale, 'livestock'),
      crop: advisoryCloseLine(locale, 'crop'),
    },
  })
})

advisoryRoutes.get('/insights/:key', async (c) => {
  const user = c.get('user')
  requireRole(user, 'owner', 'supervisor', 'field_worker')

  const key = c.req.param('key') as InsightKey
  if (!['weather', 'inputs', 'vaccination', 'harvest'].includes(key)) {
    return c.json({ error: 'Unknown insight' }, 400)
  }

  // Pass the viewer's locale explicitly: the default resolves the farm owner's,
  // which shows an English admin's language to a French worker.
  const locale = await viewerLocale(user.id)
  const tips = await buildInsightTips(user.farmId, key, locale)

  const batch = proseBatch(user.farmId, locale)
  const localizedTips = stageTips(batch, tips)
  await batch.translate()

  return c.json({ key, tips: localizedTips() })
})

advisoryRoutes.get('/recommendations', async (c) => {
  const user = c.get('user')
  requireRole(user, 'owner', 'supervisor', 'field_worker')

  const bucket = c.req.query('bucket')
  if (bucket !== 'open' && bucket !== 'completed') {
    return c.json({ error: 'bucket must be open or completed' }, 400)
  }

  const rows =
    bucket === 'open'
      ? await listOpenRecommendations(user.farmId, 40)
      : await listCompletedRecommendations(user.farmId, 40)

  const recommendations =
    user.role === 'owner' || user.role === 'supervisor'
      ? rows
      : rows.filter((r) => (r.notifyRoles as string[]).includes(user.role))

  const batch = proseBatch(user.farmId, await viewerLocale(user.id))
  const localized = stageRecommendations(batch, recommendations)
  await batch.translate()

  return c.json({ bucket, recommendations: localized() })
})

advisoryRoutes.get('/calendar', async (c) => {
  const user = c.get('user')
  requireRole(user, 'owner', 'supervisor', 'field_worker')

  const month = c.req.query('month') // YYYY-MM
  const base = month && /^\d{4}-\d{2}$/.test(month) ? new Date(`${month}-01T00:00:00Z`) : new Date()
  const start = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), 1))
  const end = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0, 23, 59, 59))

  const [locale, subjects, recommendations, observations] = await Promise.all([
    viewerLocale(user.id),
    listAdvisorySubjects(user.farmId),
    listRecommendationsForRole(user.farmId, user.role, 100),
    db
      .select()
      .from(advisoryObservations)
      .where(
        and(
          eq(advisoryObservations.farmId, user.farmId),
          gte(advisoryObservations.loggedAt, start),
          lte(advisoryObservations.loggedAt, end),
        ),
      )
      .orderBy(desc(advisoryObservations.loggedAt)),
  ])

  const batch = proseBatch(user.farmId, locale)
  const localizedSubjects = stageSubjects(batch, subjects)
  const localizedRecommendations = stageRecommendations(batch, recommendations)
  const localizedObservations = stageObservations(batch, observations)
  await batch.translate()

  return c.json({
    month: `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}`,
    subjects: localizedSubjects(),
    recommendations: localizedRecommendations(),
    observations: localizedObservations(),
  })
})

advisoryRoutes.get('/analysis', async (c) => {
  const user = c.get('user')
  requireRole(user, 'owner', 'supervisor', 'field_worker')

  const [locale, subjects, stats, recentObs] = await Promise.all([
    viewerLocale(user.id),
    listAdvisorySubjects(user.farmId),
    recommendationStats(user.farmId),
    db
      .select()
      .from(advisoryObservations)
      .where(eq(advisoryObservations.farmId, user.farmId))
      .orderBy(desc(advisoryObservations.loggedAt))
      .limit(14),
  ])

  const batch = proseBatch(user.farmId, locale)
  const localizedSubjects = stageSubjects(batch, subjects)
  const localizedObservations = stageObservations(batch, recentObs)
  await batch.translate()

  return c.json({
    subjects: localizedSubjects(),
    stats,
    recentObservations: localizedObservations(),
    // Fixed UI category names, not farm content: these belong in the client's
    // i18n bundle keyed by `key`, not in the content translator.
    insights: [
      { key: 'weather', label: 'Weather risks' },
      { key: 'inputs', label: 'Input suggestions' },
      { key: 'vaccination', label: 'Vaccination windows' },
      { key: 'harvest', label: 'Harvest prep' },
    ],
  })
})

advisoryRoutes.patch(
  '/recommendations/:id',
  zValidator('json', statusSchema),
  async (c) => {
    const user = c.get('user')
    requireRole(user, 'owner', 'supervisor', 'field_worker')
    const id = c.req.param('id')
    const body = c.req.valid('json')
    const row = await updateRecommendationStatus(user.farmId, id, body.status, user.id)
    if (!row) return c.json({ error: 'Not found' }, 404)
    return c.json({ recommendation: row })
  },
)

advisoryRoutes.post('/observations', zValidator('json', observationSchema), async (c) => {
  const user = c.get('user')
  requireRole(user, 'owner', 'supervisor', 'field_worker')
  const body = c.req.valid('json')

  const [[farm], locale] = await Promise.all([
    db.select().from(farms).where(eq(farms.id, user.farmId)).limit(1),
    viewerLocale(user.id),
  ])

  // `tiles` and `sourceId` are identifiers; only `note` is prose, and it is
  // stored in canonical English like every other free-text column.
  const note = body.note?.trim()
  const authorLocale = authorLocaleHint(locale)
  const canonical = note ? await canonicalNote(note, user.farmId, authorLocale) : null

  const [observation] = await db
    .insert(advisoryObservations)
    .values({
      farmId: user.farmId,
      tiles: body.tiles,
      note: canonical?.english ?? body.note,
      sourceLocale: canonical?.sourceLocale ?? null,
      translationStatus: canonical?.status ?? 'done',
      sourceType: body.sourceType,
      sourceId: body.sourceId,
      loggedAt: body.loggedAt ? new Date(body.loggedAt) : new Date(),
      createdBy: user.id,
    })
    .returning()

  const symptomLike = body.tiles.some((t) =>
    ['yellowing', 'wilting', 'pests_spotted', 'lethargy', 'high_mortality', 'respiratory', 'heat_stress'].includes(
      t,
    ),
  )

  let products: Awaited<ReturnType<typeof resolveMarketplaceProducts>> = []
  if (symptomLike) {
    const needQuery = body.tiles.includes('heat_stress')
      ? 'poultry electrolytes heat stress'
      : body.tiles.some((t) => ['lethargy', 'high_mortality', 'respiratory'].includes(t))
        ? 'poultry vitamins electrolytes agrovet'
        : 'organic fertilizer compost soil amendment'
    if (!containsPesticideLanguage(needQuery)) {
      products = await resolveMarketplaceProducts({
        farmLocation: farm?.location,
        needQuery,
        locale,
        farmId: user.farmId,
      })
    }
  }

  const domain =
    body.sourceType === 'livestock_batch' ||
    body.tiles.some((t) =>
      ['lethargy', 'low_feed', 'high_mortality', 'heat_stress', 'wet_litter', 'respiratory'].includes(t),
    )
      ? 'livestock'
      : 'crop'

  // The author reads back their own words; the row holds the English.
  return c.json({
    observation: note ? { ...observation, note } : observation,
    products,
    closeLine: symptomLike ? advisoryCloseLine(locale, domain) : null,
  }, 201)
})

advisoryRoutes.post('/run', zValidator('json', cronSchema), async (c) => {
  const body = c.req.valid('json')
  const usedCron = requestHasCronSecret(c)

  let farmId: string
  if (usedCron) {
    if (!cronFarmIdAllowed(body.farmId)) return c.json({ error: 'Unauthorized' }, 401)
    farmId = body.farmId!
  } else {
    const user = c.get('user')
    requireRole(user, 'owner', 'supervisor')
    farmId = user.farmId
  }

  const result = await runAdvisoryEngine(farmId)
  return c.json({ ok: true, farmId, ...result })
})
