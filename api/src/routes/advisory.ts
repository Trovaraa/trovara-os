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
  type InsightKey,
} from '../lib/advisory-engine.js'
import {
  CROP_OBSERVATION_TILES,
  POULTRY_OBSERVATION_TILES,
} from '../lib/advisory-playbooks.js'
import { advisoryCloseLine } from '../lib/advisory-close.js'
import { containsPesticideLanguage } from '../lib/pesticide-filter.js'
import { resolveMarketplaceProducts } from '../lib/marketplace-search.js'
import { resolveStaffReplyLocale } from '../lib/reply-locale.js'
import { secureCompare } from '../lib/secure-compare.js'

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

advisoryRoutes.use('*', async (c, next) => {
  if (c.req.path.endsWith('/run') && c.req.method === 'POST') {
    const cronSecret = process.env.CRON_SECRET?.trim()
    const provided = c.req.header('x-cron-secret')?.trim()
    if (cronSecret && provided && secureCompare(provided, cronSecret)) {
      await next()
      return
    }
  }
  return authMiddleware(c, next)
})

advisoryRoutes.get('/home', async (c) => {
  const user = c.get('user')
  requireRole(user, 'owner', 'supervisor', 'field_worker')

  const [pref] = await db
    .select({ preferredLocale: users.preferredLocale })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1)
  const locale = resolveStaffReplyLocale(pref?.preferredLocale)

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

  return c.json({
    subjects,
    recommendations,
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

  const tips = await buildInsightTips(user.farmId, key)
  return c.json({ key, tips })
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

  return c.json({ bucket, recommendations })
})

advisoryRoutes.get('/calendar', async (c) => {
  const user = c.get('user')
  requireRole(user, 'owner', 'supervisor', 'field_worker')

  const month = c.req.query('month') // YYYY-MM
  const base = month && /^\d{4}-\d{2}$/.test(month) ? new Date(`${month}-01T00:00:00Z`) : new Date()
  const start = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), 1))
  const end = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0, 23, 59, 59))

  const [subjects, recommendations, observations] = await Promise.all([
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

  return c.json({
    month: `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}`,
    subjects,
    recommendations,
    observations,
  })
})

advisoryRoutes.get('/analysis', async (c) => {
  const user = c.get('user')
  requireRole(user, 'owner', 'supervisor', 'field_worker')

  const [subjects, stats, recentObs] = await Promise.all([
    listAdvisorySubjects(user.farmId),
    recommendationStats(user.farmId),
    db
      .select()
      .from(advisoryObservations)
      .where(eq(advisoryObservations.farmId, user.farmId))
      .orderBy(desc(advisoryObservations.loggedAt))
      .limit(14),
  ])

  return c.json({
    subjects,
    stats,
    recentObservations: recentObs,
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

  const [farm] = await db.select().from(farms).where(eq(farms.id, user.farmId)).limit(1)
  const [pref] = await db
    .select({ preferredLocale: users.preferredLocale })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1)
  const locale = resolveStaffReplyLocale(pref?.preferredLocale)

  const [observation] = await db
    .insert(advisoryObservations)
    .values({
      farmId: user.farmId,
      tiles: body.tiles,
      note: body.note,
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

  return c.json({
    observation,
    products,
    closeLine: symptomLike ? advisoryCloseLine(locale, domain) : null,
  }, 201)
})

advisoryRoutes.post('/run', zValidator('json', cronSchema), async (c) => {
  const body = c.req.valid('json')
  const cronSecret = process.env.CRON_SECRET?.trim()
  const provided = c.req.header('x-cron-secret')?.trim()
  const usedCron = Boolean(cronSecret && provided && secureCompare(provided, cronSecret))

  let farmId: string
  if (usedCron) {
    if (!body.farmId) return c.json({ error: 'farmId required for cron' }, 400)
    farmId = body.farmId
  } else {
    const user = c.get('user')
    requireRole(user, 'owner', 'supervisor')
    farmId = user.farmId
  }

  const result = await runAdvisoryEngine(farmId)
  return c.json({ ok: true, farmId, ...result })
})
