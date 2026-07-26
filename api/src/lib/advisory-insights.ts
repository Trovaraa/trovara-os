import { and, eq, inArray, ne } from 'drizzle-orm'
import { db } from '../db/index.js'
import {
  cropCycles,
  cropCycleStages,
  cropCycleTasks,
  farms,
  livestockBatches,
  livestockScheduleEntries,
  plots,
  users,
} from '../db/schema.js'
import {
  generateFarmAdvice,
  type AdviceRequest,
  type AdviceText,
  type FarmWeatherContext,
} from './advisory-generate.js'
import {
  isAdvisoryReasonCode,
  renderAdvisoryFallback,
  type FallbackText,
} from './advisory-fallback-messages.js'
import {
  WEATHER_ADVISORY_RULES,
  cropRulesForCycle,
  daysBetween,
  dueRulesForDay,
  poultryRulesForBatch,
  type AdvisoryRuleDef,
  type BatchScheduleEntry,
  type CropCycleTaskEntry,
} from './advisory-playbooks.js'
import {
  resolveMarketplaceProducts,
  type MarketplaceProductHit,
} from './marketplace-search.js'
import { resolveStaffReplyLocale, type ReplyLocale } from './reply-locale.js'
import { isNoilerBatch, isPoultryBatch, type SpeciesBearingBatch } from './species-normalize.js'
import type { CropStage } from './state-machines.js'
import { getFarmWeather } from './weather.js'
import { withWeatherTiming } from './weather-alerts.js'

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
  /** 'ai' when the prose was generated for this farm's state, 'playbook' for seed text. */
  source: 'ai' | 'playbook'
  ephemeral: true
}

const MAX_WEATHER_TIPS = 6
const MAX_TIPS = 8

/**
 * True when a tip's prose is fixed playbook seed text under a reason code the
 * pre-translated fallback table knows.
 *
 * `buildInsightTips` renders those tips into the viewer's language itself, with
 * no model, because the content translator that would otherwise do it needs the
 * same LLM whose absence produced the seed text in the first place. Read paths
 * must check this before staging a tip for translation, or they will send text
 * that is already in the reader's language back through the translator.
 */
export function isLocalizedFallbackTip(tip: {
  source: 'ai' | 'playbook'
  reasonCode: string
}): boolean {
  return tip.source === 'playbook' && isAdvisoryReasonCode(tip.reasonCode)
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

/**
 * `resolveMarketplaceProducts` used to be called once per rule per cycle. The same
 * `needQuery` repeats across cycles of the same crop, so memoize per call: the
 * module already caches hits for 12h, this just collapses the repeats within one
 * page load and shares the in-flight promise.
 */
function makeProductResolver(farmId: string, locale: ReplyLocale) {
  const inFlight = new Map<string, Promise<MarketplaceProductHit[]>>()
  return (farmLocation: string | null | undefined, needQuery: string) => {
    if (!needQuery.trim()) return Promise.resolve<MarketplaceProductHit[]>([])
    const cacheKey = `${farmLocation ?? ''}::${needQuery}`
    let hit = inFlight.get(cacheKey)
    if (!hit) {
      hit = resolveMarketplaceProducts({ farmLocation, needQuery, locale, farmId }).catch(
        () => [] as MarketplaceProductHit[],
      )
      inFlight.set(cacheKey, hit)
    }
    return hit
  }
}

async function loadViewerLocale(farmId: string, viewerLocale?: string | null): Promise<ReplyLocale> {
  if (viewerLocale != null) return resolveStaffReplyLocale(viewerLocale)
  // Legacy fallback for callers that have not been updated yet: the owner's locale.
  const [owner] = await db
    .select({ preferredLocale: users.preferredLocale })
    .from(users)
    .where(and(eq(users.farmId, farmId), eq(users.role, 'owner')))
    .limit(1)
  return resolveStaffReplyLocale(owner?.preferredLocale)
}

/**
 * The vaccination and husbandry calendars of a set of batches, keyed by batch.
 *
 * Every advisory path walks a farm's batches in a loop, so the calendars are
 * read for all of them in one statement and grouped in memory. Reading them
 * inside the loop would be a query per flock on every page view and on every
 * cron pass.
 *
 * Exported for `advisory-engine.ts`, which needs the same rows for the push
 * pipeline and for the subject list; the dependency already runs that way.
 */
export async function loadBatchScheduleEntries(
  batchIds: string[],
): Promise<Map<string, BatchScheduleEntry[]>> {
  const byBatch = new Map<string, BatchScheduleEntry[]>()
  if (batchIds.length === 0) return byBatch

  const rows = await db
    .select({
      batchId: livestockScheduleEntries.batchId,
      dayOffset: livestockScheduleEntries.dayOffset,
      name: livestockScheduleEntries.name,
      vaccine: livestockScheduleEntries.vaccine,
      translationStatus: livestockScheduleEntries.translationStatus,
    })
    .from(livestockScheduleEntries)
    .where(inArray(livestockScheduleEntries.batchId, batchIds))
    .orderBy(livestockScheduleEntries.dayOffset)

  for (const row of rows) {
    const entries = byBatch.get(row.batchId)
    if (entries) entries.push(row)
    else byBatch.set(row.batchId, [row])
  }
  return byBatch
}

/**
 * The task plans of a set of crop cycles, keyed by cycle.
 *
 * The crop twin of `loadBatchScheduleEntries`, and batched for the same reason:
 * every advisory path walks a farm's cycles in a loop, so the plans are read for
 * all of them in one statement and grouped in memory. Reading them inside the
 * loop would be a query per cycle on every page view and on every cron pass.
 *
 * Exported for `advisory-engine.ts`, which needs the same rows for the push
 * pipeline and for the subject list.
 */
export async function loadCropCycleTasks(
  cycleIds: string[],
): Promise<Map<string, CropCycleTaskEntry[]>> {
  const byCycle = new Map<string, CropCycleTaskEntry[]>()
  if (cycleIds.length === 0) return byCycle

  const rows = await db
    .select({
      cropCycleId: cropCycleTasks.cropCycleId,
      stage: cropCycleTasks.stage,
      offsetDays: cropCycleTasks.offsetDays,
      templateName: cropCycleTasks.templateName,
      description: cropCycleTasks.description,
      translationStatus: cropCycleTasks.translationStatus,
    })
    .from(cropCycleTasks)
    .where(inArray(cropCycleTasks.cropCycleId, cycleIds))
    .orderBy(cropCycleTasks.offsetDays)

  for (const row of rows) {
    const tasks = byCycle.get(row.cropCycleId)
    if (tasks) tasks.push(row)
    else byCycle.set(row.cropCycleId, [row])
  }
  return byCycle
}

/** The columns of a `crop_cycle_stages` row the advisory layer reads. */
export type CropCycleStageEntry = {
  stage: CropStage
  sequence: number
  durationDays: number
}

/**
 * The stage lengths of a set of crop cycles, keyed by cycle, in stage order.
 *
 * Read in one statement for the same reason the plans are. How long a stage is
 * expected to run is a per-cycle number, so the subject list reads it from the
 * cycle's own row rather than reporting nothing.
 */
export async function loadCropCycleStages(
  cycleIds: string[],
): Promise<Map<string, CropCycleStageEntry[]>> {
  const byCycle = new Map<string, CropCycleStageEntry[]>()
  if (cycleIds.length === 0) return byCycle

  const rows = await db
    .select({
      cropCycleId: cropCycleStages.cropCycleId,
      stage: cropCycleStages.stage,
      sequence: cropCycleStages.sequence,
      durationDays: cropCycleStages.durationDays,
    })
    .from(cropCycleStages)
    .where(inArray(cropCycleStages.cropCycleId, cycleIds))
    .orderBy(cropCycleStages.sequence)

  for (const row of rows) {
    const stages = byCycle.get(row.cropCycleId)
    if (stages) stages.push(row)
    else byCycle.set(row.cropCycleId, [row])
  }
  return byCycle
}

/**
 * The rules one batch is advised off, or nothing when it is not ours to advise.
 *
 * Every rule below is worded for a flock, so a batch that cannot be placed as
 * poultry is advised off nothing: generation refuses those batches a calendar,
 * which leaves only one a farm wrote by hand, and a schedule someone typed for
 * goats does not make goats a flock. Among poultry the batch's own calendar
 * wins whatever its species text reads as, and only the hard-coded fallback
 * narrows further, to the single type the playbook was written for.
 */
export function advisoryRulesForBatch(
  batch: SpeciesBearingBatch,
  entries: readonly BatchScheduleEntry[],
): AdvisoryRuleDef[] {
  if (!isPoultryBatch(batch)) return []
  if (entries.length === 0 && !isNoilerBatch(batch)) return []
  return poultryRulesForBatch(entries)
}

/** A tip waiting on generated prose; the seed text is already in `request`. */
type PendingTip = {
  id: string
  sourceType: InsightTip['sourceType']
  sourceId: string
  request: AdviceRequest
  /** Appended to the seed headline when generation did not run (keeps the old wording). */
  fallbackSuffix?: string
  needQuery: string
  farmLocation: string | null | undefined
  /** Weather tips fold the alert timing into the seed headline. */
  timingAlert?: Parameters<typeof withWeatherTiming>[1]
}

/**
 * Build live insight tips from current farm state (on-demand, not only stored rows).
 *
 * `viewerLocale` is the locale of the person looking at the page. Generated prose
 * is written and stored in English and translated further down the read path, so
 * for those tips the locale only picks a marketplace region. Seed-fallback prose
 * is the exception: it is rendered here, from the pre-translated table, because
 * the translator is unavailable exactly when the fallback fires. When omitted,
 * the farm owner's locale is used (legacy behaviour, kept so existing callers
 * keep compiling).
 */
export async function buildInsightTips(
  farmId: string,
  key: InsightKey,
  viewerLocale?: string | null,
): Promise<InsightTip[]> {
  const [farm] = await db.select().from(farms).where(eq(farms.id, farmId)).limit(1)
  if (!farm) return []

  const locale = await loadViewerLocale(farmId, viewerLocale)
  const productsFor = makeProductResolver(farmId, locale)
  const now = new Date()

  if (key === 'weather') {
    // Fresh fetch so peak rainfall times are present (not a stale daily-only cache).
    const weather = await getFarmWeather(farmId, { forceRefresh: true, preferredLocale: locale })
    if (weather.status !== 'ok' && weather.status !== 'stale') {
      return [
        {
          id: 'insight:weather.unavailable',
          sourceType: 'weather',
          sourceId: 'weather:unavailable',
          ruleKey: 'weather.unavailable',
          reasonCode: 'weather_unavailable',
          happeningNow: 'Weather data is not available for this farm yet.',
          whatNext: 'Set farm location / weather API keys, then refresh Advisory.',
          needQuery: '',
          products: [],
          source: 'playbook',
          ephemeral: true,
        },
      ]
    }

    const weatherContext = toWeatherContext(weather.current?.condition, weather.current?.tempC, weather.alerts)
    const alertByType = new Map(weather.alerts.map((a) => [a.type, a]))
    const pending: PendingTip[] = []

    for (const rule of WEATHER_ADVISORY_RULES) {
      const alert = alertByType.get(rule.alertType)
      if (!alert) continue
      pending.push({
        id: `insight:${rule.ruleKey}`,
        sourceType: 'weather',
        sourceId: `weather:${rule.alertType}`,
        needQuery: rule.needQuery,
        farmLocation: farm.location ?? weather.locationLabel,
        timingAlert: alert,
        request: {
          ruleKey: rule.ruleKey,
          reasonCode: rule.reasonCode,
          seedHappeningNow: rule.happeningNow,
          seedWhatNext: rule.whatNext,
          subject: {
            kind: 'weather',
            alertType: alert.type,
            alertTitle: alert.title,
            alertMessage: alert.message,
            whenLabel: alert.whenLabel ?? null,
          },
        },
      })
    }

    if (pending.length === 0) {
      if (!weather.current) return []
      const needQuery = 'poultry electrolytes shade farm'
      return [
        {
          id: 'insight:weather.general',
          sourceType: 'weather',
          sourceId: 'weather:general',
          ruleKey: 'weather.general',
          reasonCode: 'weather_general',
          happeningNow: `Current conditions: ${weather.current.condition}, ${weather.current.tempC.toFixed(0)}°C.`,
          whatNext: 'Review the Today weather card and plan field or poultry work around the forecast.',
          needQuery,
          products: await productsFor(farm.location ?? weather.locationLabel, needQuery),
          source: 'playbook',
          ephemeral: true,
        },
      ]
    }

    return finishTips(farmId, farm.name, farm.location, weatherContext, pending.slice(0, MAX_WEATHER_TIPS), productsFor, locale, {
      alwaysResolveProducts: true,
    })
  }

  const weatherContext = await loadWeatherContext(farmId)
  const pending: PendingTip[] = []

  const cycles = await db
    .select({
      id: cropCycles.id,
      cropType: cropCycles.cropType,
      stage: cropCycles.stage,
      plantedAt: cropCycles.plantedAt,
      stageEnteredAt: cropCycles.stageEnteredAt,
      plotName: plots.name,
      plotAreaAcres: plots.areaAcres,
    })
    .from(cropCycles)
    .innerJoin(plots, eq(plots.id, cropCycles.plotId))
    .where(and(eq(cropCycles.farmId, farmId), ne(cropCycles.stage, 'harvested')))

  const cyclePlans = await loadCropCycleTasks(cycles.map((cycle) => cycle.id))

  for (const cycle of cycles) {
    const dayInStage = daysBetween(cycle.stageEnteredAt ?? cycle.plantedAt, now)
    const tasks = cyclePlans.get(cycle.id) ?? []
    const stageRules = cropRulesForCycle(cycle, tasks)

    // Harvest insights also look at harvest-ready work even if not in that stage yet.
    const rules =
      key === 'harvest' && cycle.stage !== 'harvest_ready'
        ? [
            ...stageRules,
            ...cropRulesForCycle({ cropType: cycle.cropType, stage: 'harvest_ready' }, tasks),
          ]
        : stageRules
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
      pending.push({
        id: `insight:${cycle.id}:${rule.ruleKey}`,
        sourceType: 'crop_cycle',
        sourceId: cycle.id,
        needQuery: rule.needQuery,
        farmLocation: farm.location,
        fallbackSuffix: cycle.plotName,
        request: {
          ruleKey: rule.ruleKey,
          reasonCode: rule.reasonCode,
          seedHappeningNow: rule.happeningNow,
          seedWhatNext: rule.whatNext,
          subject: {
            kind: 'crop',
            cropType: cycle.cropType,
            stage: cycle.stage,
            dayInStage,
            plotName: cycle.plotName,
            areaAcres: cycle.plotAreaAcres,
          },
        },
      })
    }
  }

  const batches = await db
    .select()
    .from(livestockBatches)
    .where(and(eq(livestockBatches.farmId, farmId), eq(livestockBatches.active, true)))

  const schedules = await loadBatchScheduleEntries(batches.map((batch) => batch.id))

  for (const batch of batches) {
    const rules = advisoryRulesForBatch(batch, schedules.get(batch.id) ?? [])
    if (rules.length === 0) continue
    const dayInCycle = daysBetween(batch.acquiredAt, now)
    const due = dueRulesForDay(dayInCycle, rules).filter((rule) => matchesInsight(key, rule))
    const upcoming =
      due.length === 0 && (key === 'vaccination' || key === 'inputs')
        ? rules
            .filter((rule) => matchesInsight(key, rule))
            .map((rule) => ({ rule, daysUntil: rule.offsetDays - dayInCycle }))
            .filter((x) => x.daysUntil >= 0 && x.daysUntil <= 14)
            .sort((a, b) => a.daysUntil - b.daysUntil)
            .slice(0, 2)
            .map((x) => x.rule)
        : []

    for (const rule of [...due, ...upcoming]) {
      pending.push({
        id: `insight:${batch.id}:${rule.ruleKey}`,
        sourceType: 'livestock_batch',
        sourceId: batch.id,
        needQuery: rule.needQuery,
        farmLocation: farm.location,
        fallbackSuffix: batch.name,
        request: {
          ruleKey: rule.ruleKey,
          reasonCode: rule.reasonCode,
          seedHappeningNow: rule.happeningNow,
          seedWhatNext: rule.whatNext,
          subject: {
            kind: 'livestock',
            species: batch.species,
            batchName: batch.name,
            headCount: batch.headCount,
            dayInCycle,
          },
        },
      })
    }
  }

  return finishTips(farmId, farm.name, farm.location, weatherContext, pending.slice(0, MAX_TIPS), productsFor, locale, {
    alwaysResolveProducts: key === 'inputs',
  })
}

function toWeatherContext(
  condition: string | undefined,
  tempC: number | undefined,
  alerts: Array<{ type: string; severity: string; title: string }>,
): FarmWeatherContext {
  return {
    condition: condition ?? null,
    tempC: tempC ?? null,
    alerts: alerts.map((a) => ({ type: a.type, severity: a.severity, title: a.title })),
  }
}

/** Live conditions for grounding crop/livestock prose; never fatal if weather is off. */
async function loadWeatherContext(farmId: string): Promise<FarmWeatherContext | null> {
  try {
    const weather = await getFarmWeather(farmId)
    if (weather.status !== 'ok' && weather.status !== 'stale') return null
    return toWeatherContext(weather.current?.condition, weather.current?.tempC, weather.alerts)
  } catch {
    return null
  }
}

/** One batched generation for every due rule, then marketplace lookups. */
async function finishTips(
  farmId: string,
  farmName: string | null,
  farmLocation: string | null,
  weather: FarmWeatherContext | null,
  pending: PendingTip[],
  productsFor: (location: string | null | undefined, needQuery: string) => Promise<MarketplaceProductHit[]>,
  locale: ReplyLocale,
  opts: { alwaysResolveProducts: boolean },
): Promise<InsightTip[]> {
  if (pending.length === 0) return []

  const bundle = await generateFarmAdvice({
    farmId,
    farmName,
    farmLocation,
    weather,
    requests: pending.map((p) => p.request),
  })

  return Promise.all(
    pending.map(async (tip, i) => {
      const text = bundle.texts[i] ?? {
        happeningNow: tip.request.seedHappeningNow,
        whatNext: tip.request.seedWhatNext,
        source: 'playbook' as const,
        reasonCode: tip.request.reasonCode,
      }
      const prose = fallbackProse(text, locale) ?? text
      return {
        id: tip.id,
        sourceType: tip.sourceType,
        sourceId: tip.sourceId,
        ruleKey: tip.request.ruleKey,
        reasonCode: tip.request.reasonCode,
        happeningNow: headline(prose.happeningNow, text.source, tip),
        whatNext: prose.whatNext,
        needQuery: tip.needQuery,
        products:
          opts.alwaysResolveProducts || tip.needQuery
            ? await productsFor(tip.farmLocation, tip.needQuery)
            : [],
        source: text.source,
        ephemeral: true as const,
      }
    }),
  )
}

/**
 * Seed prose in the viewer's language, or null to leave the text where it is.
 *
 * An English viewer reads the seed exactly as the playbook wrote it: it is
 * already their language, it names the crop and stage the deliberately generic
 * table cannot, and a lookup would only make the page differ from today for no
 * gain. A reason code the table does not know — the ad-hoc weather tips below
 * carry `weather_general` and `weather_unavailable` — stays with the translator
 * too, since the generic line would say something less true than the seed.
 */
function fallbackProse(text: AdviceText, locale: ReplyLocale): FallbackText | null {
  if (locale === 'en' || !isLocalizedFallbackTip(text)) return null
  return renderAdvisoryFallback(text.reasonCode, locale)
}

/**
 * Generated prose already names the plot/batch and the alert timing, so the
 * decorations only apply to the seed fallback — and they matter most there,
 * because the fallback line is otherwise generic and the plot name is the only
 * thing telling the crew where to go.
 */
function headline(text: string, source: AdviceText['source'], tip: PendingTip): string {
  if (source === 'ai') return text
  if (tip.timingAlert) return withWeatherTiming(text, tip.timingAlert)
  return tip.fallbackSuffix ? `${text} (${tip.fallbackSuffix})` : text
}
