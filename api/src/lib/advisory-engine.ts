import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import {
  advisoryRecommendations,
  cropCycles,
  farms,
  livestockBatches,
  plots,
  users,
  type UserRole,
} from '../db/schema.js'
import {
  BROILER_ADVISORY_PLAYBOOK,
  CROP_ADVISORY_PLAYBOOKS,
  WEATHER_ADVISORY_RULES,
  daysBetween,
  dueRulesForDay,
  type AdvisoryNotifyRole,
  type AdvisoryRuleDef,
} from './advisory-playbooks.js'
import { notifyRoles, notifyRolesTelegram } from './farm-notify.js'
import { completeChat, isLlmConfigured } from './llm.js'
import { checkLlmBudget, consumeLlmBudget } from './llm-budget.js'
import {
  resolveMarketplaceProducts,
  type MarketplaceProductHit,
} from './marketplace-search.js'
import { resolveStaffReplyLocale } from './reply-locale.js'
import { sanitizeForLlm } from './sanitize-input.js'
import { getFarmWeather } from './weather.js'
import { withWeatherTiming } from './weather-alerts.js'

export type AdvisoryPayload = {
  happeningNow: string
  whatNext: string
  needQuery: string
  products: MarketplaceProductHit[]
  reasonCode: string
  weatherRef?: string
  cropType?: string
  stage?: string
  batchName?: string
  dayInCycle?: number
}

export type AdvisoryRecommendationRow = typeof advisoryRecommendations.$inferSelect

function formatAdvisoryMessage(
  farmName: string,
  payload: AdvisoryPayload,
  aiSummary?: string | null,
): string {
  const productLines =
    payload.products.length > 0
      ? payload.products
          .map((p) => {
            if (p.url) return `• ${p.title}: ${p.url}`
            return `• ${p.title}${p.reason ? ` — ${p.reason}` : ''} (suggested for your area)`
          })
          .join('\n')
      : '• (no product links right now)'

  return [
    `🌱 Trovara OS Advisory — ${farmName}`,
    '',
    `Now: ${payload.happeningNow}`,
    `Next: ${payload.whatNext}`,
    aiSummary ? `Why: ${aiSummary}` : null,
    '',
    'Suggested inputs:',
    productLines,
    '',
    'Confirm sensitive actions with your supervisor. Trovara does not sell these products.',
  ]
    .filter((line) => line !== null)
    .join('\n')
}

async function draftAiSummary(
  farmId: string,
  payload: AdvisoryPayload,
): Promise<string | null> {
  if (!isLlmConfigured()) return null
  const budget = checkLlmBudget(farmId)
  if (!budget.allowed) return null
  try {
    const { text } = await completeChat(
      [
        'Write one short sentence (max 40 words) explaining why this farm advisory tip matters.',
        'Do not add new actions or products. No pesticides. Plain text only.',
      ].join(' '),
      sanitizeForLlm(`Now: ${payload.happeningNow}\nNext: ${payload.whatNext}\nReason: ${payload.reasonCode}`),
    )
    consumeLlmBudget(farmId)
    return text.trim().slice(0, 280) || null
  } catch {
    return null
  }
}

async function persistAndNotify(args: {
  farmId: string
  farmName: string
  farmLocation: string | null
  ruleKey: string
  sourceType: 'crop_cycle' | 'livestock_batch' | 'weather' | 'farm'
  sourceId: string
  notifyRolesList: AdvisoryNotifyRole[]
  basePayload: Omit<AdvisoryPayload, 'products'>
  locale: ReturnType<typeof resolveStaffReplyLocale>
}): Promise<AdvisoryRecommendationRow | null> {
  const existing = await db
    .select({ id: advisoryRecommendations.id })
    .from(advisoryRecommendations)
    .where(
      and(
        eq(advisoryRecommendations.farmId, args.farmId),
        eq(advisoryRecommendations.sourceId, args.sourceId),
        eq(advisoryRecommendations.ruleKey, args.ruleKey),
      ),
    )
    .limit(1)
  if (existing.length > 0) return null

  const products = await resolveMarketplaceProducts({
    farmLocation: args.farmLocation,
    needQuery: args.basePayload.needQuery,
    locale: args.locale,
    farmId: args.farmId,
  })

  const payload: AdvisoryPayload = { ...args.basePayload, products }
  const aiSummary = await draftAiSummary(args.farmId, payload)

  let row: AdvisoryRecommendationRow
  try {
    const [inserted] = await db
      .insert(advisoryRecommendations)
      .values({
        farmId: args.farmId,
        ruleKey: args.ruleKey,
        sourceType: args.sourceType,
        sourceId: args.sourceId,
        status: 'pending',
        notifyRoles: args.notifyRolesList,
        payload,
        aiSummary,
      })
      .returning()
    row = inserted
  } catch {
    // unique race
    return null
  }

  const message = formatAdvisoryMessage(args.farmName, payload, aiSummary)
  const roles = args.notifyRolesList as UserRole[]
  await Promise.all([
    notifyRolesTelegram(args.farmId, roles, message, {
      reason: 'advisory_recommendation',
      kind: 'advisory',
    }),
    notifyRoles(args.farmId, roles, message, {
      reason: 'advisory_recommendation',
      kind: 'advisory',
    }),
  ])

  const [updated] = await db
    .update(advisoryRecommendations)
    .set({ status: 'notified', updatedAt: new Date() })
    .where(eq(advisoryRecommendations.id, row.id))
    .returning()

  return updated ?? row
}

export async function runAdvisoryEngine(farmId: string): Promise<{ created: number }> {
  const [farm] = await db.select().from(farms).where(eq(farms.id, farmId)).limit(1)
  if (!farm) return { created: 0 }

  const [owner] = await db
    .select({ preferredLocale: users.preferredLocale })
    .from(users)
    .where(and(eq(users.farmId, farmId), eq(users.role, 'owner')))
    .limit(1)
  const locale = resolveStaffReplyLocale(owner?.preferredLocale)
  const now = new Date()
  let created = 0

  const cycles = await db
    .select({
      id: cropCycles.id,
      cropType: cropCycles.cropType,
      stage: cropCycles.stage,
      plantedAt: cropCycles.plantedAt,
      stageEnteredAt: cropCycles.stageEnteredAt,
      plotName: plots.name,
    })
    .from(cropCycles)
    .innerJoin(plots, eq(plots.id, cropCycles.plotId))
    .where(and(eq(cropCycles.farmId, farmId), ne(cropCycles.stage, 'harvested')))

  for (const cycle of cycles) {
    const stageStart = cycle.stageEnteredAt ?? cycle.plantedAt
    const dayInStage = daysBetween(stageStart, now)
    const playbooks = CROP_ADVISORY_PLAYBOOKS.filter(
      (p) =>
        p.cropType === cycle.cropType.toLowerCase() && p.stage === cycle.stage,
    )
    for (const pb of playbooks) {
      for (const rule of dueRulesForDay(dayInStage, pb.rules)) {
        const row = await persistAndNotify({
          farmId,
          farmName: farm.name,
          farmLocation: farm.location,
          ruleKey: rule.ruleKey,
          sourceType: 'crop_cycle',
          sourceId: cycle.id,
          notifyRolesList: rule.notifyRoles,
          locale,
          basePayload: {
            happeningNow: `${rule.happeningNow} (${cycle.plotName})`,
            whatNext: rule.whatNext,
            needQuery: rule.needQuery,
            reasonCode: rule.reasonCode,
            cropType: cycle.cropType,
            stage: cycle.stage,
            dayInCycle: dayInStage,
          },
        })
        if (row) created++
      }
    }
  }

  const batches = await db
    .select()
    .from(livestockBatches)
    .where(and(eq(livestockBatches.farmId, farmId), eq(livestockBatches.active, true)))

  for (const batch of batches) {
    const isBroiler =
      batch.batchType === 'broiler' || batch.species.toLowerCase().includes('broiler')
    if (!isBroiler) continue
    const dayInCycle = daysBetween(batch.acquiredAt, now)
    for (const rule of dueRulesForDay(dayInCycle, BROILER_ADVISORY_PLAYBOOK.rules)) {
      const row = await persistAndNotify({
        farmId,
        farmName: farm.name,
        farmLocation: farm.location,
        ruleKey: rule.ruleKey,
        sourceType: 'livestock_batch',
        sourceId: batch.id,
        notifyRolesList: rule.notifyRoles,
        locale,
        basePayload: {
          happeningNow: `${rule.happeningNow} (${batch.name})`,
          whatNext: rule.whatNext,
          needQuery: rule.needQuery,
          reasonCode: rule.reasonCode,
          batchName: batch.name,
          dayInCycle,
        },
      })
      if (row) created++
    }
  }

  const weather = await getFarmWeather(farmId)
  if (weather.status === 'ok' || weather.status === 'stale') {
    const alertByType = new Map(weather.alerts.map((a) => [a.type, a]))
    const dayBucket = now.toISOString().slice(0, 10)
    for (const rule of WEATHER_ADVISORY_RULES) {
      const alert = alertByType.get(rule.alertType)
      if (!alert) continue
      const row = await persistAndNotify({
        farmId,
        farmName: farm.name,
        farmLocation: farm.location ?? weather.locationLabel,
        ruleKey: `${rule.ruleKey}.${dayBucket}`,
        sourceType: 'weather',
        sourceId: `weather:${dayBucket}:${rule.alertType}`,
        notifyRolesList: rule.notifyRoles,
        locale,
        basePayload: {
          happeningNow: withWeatherTiming(rule.happeningNow, alert),
          whatNext: rule.whatNext,
          needQuery: rule.needQuery,
          reasonCode: rule.reasonCode,
          weatherRef: rule.alertType,
        },
      })
      if (row) created++
    }
  }

  return { created }
}

export async function listOpenRecommendations(farmId: string, limit = 20) {
  return db
    .select()
    .from(advisoryRecommendations)
    .where(
      and(
        eq(advisoryRecommendations.farmId, farmId),
        inArray(advisoryRecommendations.status, ['pending', 'notified', 'accepted']),
      ),
    )
    .orderBy(desc(advisoryRecommendations.firedAt))
    .limit(limit)
}

export async function listCompletedRecommendations(farmId: string, limit = 40) {
  return db
    .select()
    .from(advisoryRecommendations)
    .where(
      and(
        eq(advisoryRecommendations.farmId, farmId),
        eq(advisoryRecommendations.status, 'completed'),
      ),
    )
    .orderBy(desc(advisoryRecommendations.firedAt))
    .limit(limit)
}

export async function listRecommendationsForRole(
  farmId: string,
  role: UserRole,
  limit = 20,
) {
  const rows = await listOpenRecommendations(farmId, 50)
  if (role === 'owner' || role === 'supervisor') return rows.slice(0, limit)
  return rows
    .filter((r) => (r.notifyRoles as string[]).includes(role))
    .slice(0, limit)
}

export async function updateRecommendationStatus(
  farmId: string,
  id: string,
  status: 'accepted' | 'ignored' | 'completed',
  userId: string,
): Promise<AdvisoryRecommendationRow | null> {
  const [row] = await db
    .update(advisoryRecommendations)
    .set({
      status,
      resolvedAt: status === 'ignored' || status === 'completed' ? new Date() : null,
      resolvedBy: userId,
      updatedAt: new Date(),
    })
    .where(and(eq(advisoryRecommendations.id, id), eq(advisoryRecommendations.farmId, farmId)))
    .returning()
  return row ?? null
}

export type AdvisorySubject =
  | {
      kind: 'crop'
      id: string
      label: string
      cropType: string
      plotName: string
      stage: string
      plantedAt: string
      stageEnteredAt: string
      dayInStage: number
      totalStageDays: number | null
      daysUntilNextHint: number | null
      nextHint: string | null
    }
  | {
      kind: 'livestock'
      id: string
      label: string
      species: string
      batchType: string | null
      acquiredAt: string
      dayInCycle: number
      daysUntilNextHint: number | null
      nextHint: string | null
    }

export async function listAdvisorySubjects(farmId: string): Promise<AdvisorySubject[]> {
  const now = new Date()
  const cycles = await db
    .select({
      id: cropCycles.id,
      cropType: cropCycles.cropType,
      stage: cropCycles.stage,
      plantedAt: cropCycles.plantedAt,
      stageEnteredAt: cropCycles.stageEnteredAt,
      plotName: plots.name,
    })
    .from(cropCycles)
    .innerJoin(plots, eq(plots.id, cropCycles.plotId))
    .where(and(eq(cropCycles.farmId, farmId), ne(cropCycles.stage, 'harvested')))

  const subjects: AdvisorySubject[] = []

  for (const cycle of cycles) {
    const stageStart = cycle.stageEnteredAt ?? cycle.plantedAt
    const dayInStage = daysBetween(stageStart, now)
    const rules = CROP_ADVISORY_PLAYBOOKS.filter(
      (p) => p.cropType === cycle.cropType.toLowerCase() && p.stage === cycle.stage,
    ).flatMap((p) => p.rules)
    const upcoming = rules
      .map((r) => ({ rule: r, daysUntil: r.offsetDays - dayInStage }))
      .filter((x) => x.daysUntil >= 0)
      .sort((a, b) => a.daysUntil - b.daysUntil)[0]

    subjects.push({
      kind: 'crop',
      id: cycle.id,
      label: `${cycle.cropType.charAt(0).toUpperCase()}${cycle.cropType.slice(1).toLowerCase()} · ${cycle.plotName}`,
      cropType: cycle.cropType,
      plotName: cycle.plotName,
      stage: cycle.stage,
      plantedAt: cycle.plantedAt.toISOString(),
      stageEnteredAt: stageStart.toISOString(),
      dayInStage,
      totalStageDays: null,
      daysUntilNextHint: upcoming?.daysUntil ?? null,
      nextHint: upcoming?.rule.whatNext ?? null,
    })
  }

  const batches = await db
    .select()
    .from(livestockBatches)
    .where(and(eq(livestockBatches.farmId, farmId), eq(livestockBatches.active, true)))

  for (const batch of batches) {
    const dayInCycle = daysBetween(batch.acquiredAt, now)
    const isBroiler =
      batch.batchType === 'broiler' || batch.species.toLowerCase().includes('broiler')
    const upcoming = isBroiler
      ? BROILER_ADVISORY_PLAYBOOK.rules
          .map((r) => ({ rule: r, daysUntil: r.offsetDays - dayInCycle }))
          .filter((x) => x.daysUntil >= 0)
          .sort((a, b) => a.daysUntil - b.daysUntil)[0]
      : undefined

    subjects.push({
      kind: 'livestock',
      id: batch.id,
      label: batch.name,
      species: batch.species,
      batchType: batch.batchType,
      acquiredAt: batch.acquiredAt.toISOString(),
      dayInCycle,
      daysUntilNextHint: upcoming?.daysUntil ?? null,
      nextHint: upcoming?.rule.whatNext ?? null,
    })
  }

  return subjects
}

export async function recommendationStats(farmId: string) {
  const rows = await db
    .select({
      status: advisoryRecommendations.status,
      count: sql<number>`count(*)::int`.mapWith(Number),
    })
    .from(advisoryRecommendations)
    .where(eq(advisoryRecommendations.farmId, farmId))
    .groupBy(advisoryRecommendations.status)

  const byStatus: Record<string, number> = {}
  for (const r of rows) byStatus[r.status] = r.count
  return byStatus
}

export type InsightKey = 'weather' | 'inputs' | 'vaccination' | 'harvest'

export type InsightTip = {
  id: string
  sourceType: 'crop_cycle' | 'livestock_batch' | 'weather' | 'farm'
  sourceId: string
  ruleKey: string
  reasonCode: string
  happeningNow: string
  whatNext: string
  needQuery: string
  products: MarketplaceProductHit[]
  ephemeral: true
}

function matchesInsight(key: InsightKey, rule: AdvisoryRuleDef): boolean {
  const blob = `${rule.ruleKey} ${rule.reasonCode} ${rule.needQuery} ${rule.whatNext}`.toLowerCase()
  if (key === 'weather') return rule.reasonCode.startsWith('weather_') || blob.includes('weather')
  if (key === 'vaccination') {
    return (
      rule.reasonCode.includes('vaccination') ||
      blob.includes('vaccine') ||
      blob.includes('gumboro') ||
      blob.includes('newcastle') ||
      blob.includes('lasota')
    )
  }
  if (key === 'harvest') return rule.reasonCode.includes('harvest') || blob.includes('harvest')
  // inputs: almost every safe needQuery tip
  return (
    Boolean(rule.needQuery) ||
    blob.includes('fertiliz') ||
    blob.includes('mulch') ||
    blob.includes('feed') ||
    blob.includes('compost') ||
    blob.includes('electrolyte')
  )
}

/** Build live insight tips from current farm state (on-demand, not only stored rows). */
export async function buildInsightTips(
  farmId: string,
  key: InsightKey,
): Promise<InsightTip[]> {
  const [farm] = await db.select().from(farms).where(eq(farms.id, farmId)).limit(1)
  if (!farm) return []

  const [owner] = await db
    .select({ preferredLocale: users.preferredLocale })
    .from(users)
    .where(and(eq(users.farmId, farmId), eq(users.role, 'owner')))
    .limit(1)
  const locale = resolveStaffReplyLocale(owner?.preferredLocale)
  const tips: InsightTip[] = []
  const now = new Date()

  if (key === 'weather') {
    // Fresh fetch so peak rainfall times are present (not a stale daily-only cache).
    const weather = await getFarmWeather(farmId, { forceRefresh: true, preferredLocale: locale })
    if (weather.status === 'ok' || weather.status === 'stale') {
      const alertByType = new Map(weather.alerts.map((a) => [a.type, a]))
      for (const rule of WEATHER_ADVISORY_RULES) {
        const alert = alertByType.get(rule.alertType)
        if (!alert) continue

        const products = await resolveMarketplaceProducts({
          farmLocation: farm.location ?? weather.locationLabel,
          needQuery: rule.needQuery,
          locale,
          farmId,
        })
        tips.push({
          id: `insight:${rule.ruleKey}`,
          sourceType: 'weather',
          sourceId: `weather:${rule.alertType}`,
          ruleKey: rule.ruleKey,
          reasonCode: rule.reasonCode,
          happeningNow: withWeatherTiming(rule.happeningNow, alert),
          whatNext: rule.whatNext,
          needQuery: rule.needQuery,
          products,
          ephemeral: true,
        })
      }
      if (tips.length === 0 && weather.current) {
        const needQuery = 'poultry electrolytes shade farm'
        const products = await resolveMarketplaceProducts({
          farmLocation: farm.location ?? weather.locationLabel,
          needQuery,
          locale,
          farmId,
        })
        tips.push({
          id: 'insight:weather.general',
          sourceType: 'weather',
          sourceId: 'weather:general',
          ruleKey: 'weather.general',
          reasonCode: 'weather_general',
          happeningNow: `Current conditions: ${weather.current.condition}, ${weather.current.tempC.toFixed(0)}°C.`,
          whatNext: 'Review the Today weather card and plan field or poultry work around the forecast.',
          needQuery,
          products,
          ephemeral: true,
        })
      }
    } else {
      tips.push({
        id: 'insight:weather.unavailable',
        sourceType: 'weather',
        sourceId: 'weather:unavailable',
        ruleKey: 'weather.unavailable',
        reasonCode: 'weather_unavailable',
        happeningNow: 'Weather data is not available for this farm yet.',
        whatNext: 'Set farm location / weather API keys, then refresh Advisory.',
        needQuery: '',
        products: [],
        ephemeral: true,
      })
    }
    return tips.slice(0, 6)
  }

  const cycles = await db
    .select({
      id: cropCycles.id,
      cropType: cropCycles.cropType,
      stage: cropCycles.stage,
      plantedAt: cropCycles.plantedAt,
      stageEnteredAt: cropCycles.stageEnteredAt,
      plotName: plots.name,
    })
    .from(cropCycles)
    .innerJoin(plots, eq(plots.id, cropCycles.plotId))
    .where(and(eq(cropCycles.farmId, farmId), ne(cropCycles.stage, 'harvested')))

  for (const cycle of cycles) {
    const dayInStage = daysBetween(cycle.stageEnteredAt ?? cycle.plantedAt, now)
    const stageRules = CROP_ADVISORY_PLAYBOOKS.filter(
      (p) => p.cropType === cycle.cropType.toLowerCase() && p.stage === cycle.stage,
    ).flatMap((p) => p.rules)

    // Harvest insights also look at harvest_ready playbooks even if not in that stage yet.
    const harvestStageRules =
      key === 'harvest'
        ? CROP_ADVISORY_PLAYBOOKS.filter(
            (p) =>
              p.cropType === cycle.cropType.toLowerCase() &&
              (p.stage === 'harvest_ready' || p.stage === cycle.stage),
          ).flatMap((p) => p.rules)
        : stageRules

    const rules = key === 'harvest' ? harvestStageRules : stageRules
    const due = dueRulesForDay(dayInStage, stageRules).filter((rule) => matchesInsight(key, rule))

    let candidates = due
    if (candidates.length === 0 && (key === 'harvest' || key === 'inputs')) {
      if (key === 'harvest' && cycle.stage !== 'harvest_ready') {
        candidates = rules.filter((rule) => matchesInsight(key, rule)).slice(0, 2)
      } else {
        candidates = rules
          .filter((rule) => matchesInsight(key, rule))
          .map((rule) => ({ rule, daysUntil: rule.offsetDays - dayInStage }))
          .filter((x) => x.daysUntil >= 0 && x.daysUntil <= 21)
          .sort((a, b) => a.daysUntil - b.daysUntil)
          .slice(0, 2)
          .map((x) => x.rule)
      }
    }

    for (const rule of candidates) {
      const products =
        key === 'inputs' || rule.needQuery
          ? await resolveMarketplaceProducts({
              farmLocation: farm.location,
              needQuery: rule.needQuery,
              locale,
              farmId,
            })
          : []
      tips.push({
        id: `insight:${cycle.id}:${rule.ruleKey}`,
        sourceType: 'crop_cycle',
        sourceId: cycle.id,
        ruleKey: rule.ruleKey,
        reasonCode: rule.reasonCode,
        happeningNow: `${rule.happeningNow} (${cycle.plotName})`,
        whatNext: rule.whatNext,
        needQuery: rule.needQuery,
        products,
        ephemeral: true,
      })
    }
  }

  const batches = await db
    .select()
    .from(livestockBatches)
    .where(and(eq(livestockBatches.farmId, farmId), eq(livestockBatches.active, true)))

  for (const batch of batches) {
    const isBroiler =
      batch.batchType === 'broiler' || batch.species.toLowerCase().includes('broiler')
    if (!isBroiler) continue
    const dayInCycle = daysBetween(batch.acquiredAt, now)
    const due = dueRulesForDay(dayInCycle, BROILER_ADVISORY_PLAYBOOK.rules).filter((rule) =>
      matchesInsight(key, rule),
    )
    const upcoming =
      due.length === 0 && (key === 'vaccination' || key === 'inputs')
        ? BROILER_ADVISORY_PLAYBOOK.rules
            .filter((rule) => matchesInsight(key, rule))
            .map((rule) => ({ rule, daysUntil: rule.offsetDays - dayInCycle }))
            .filter((x) => x.daysUntil >= 0 && x.daysUntil <= 14)
            .sort((a, b) => a.daysUntil - b.daysUntil)
            .slice(0, 2)
            .map((x) => x.rule)
        : []

    for (const rule of [...due, ...upcoming]) {
      const products = await resolveMarketplaceProducts({
        farmLocation: farm.location,
        needQuery: rule.needQuery,
        locale,
        farmId,
      })
      tips.push({
        id: `insight:${batch.id}:${rule.ruleKey}`,
        sourceType: 'livestock_batch',
        sourceId: batch.id,
        ruleKey: rule.ruleKey,
        reasonCode: rule.reasonCode,
        happeningNow: `${rule.happeningNow} (${batch.name})`,
        whatNext: rule.whatNext,
        needQuery: rule.needQuery,
        products,
        ephemeral: true,
      })
    }
  }

  return tips.slice(0, 8)
}
