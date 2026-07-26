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
  isAdvisoryReasonCode,
  renderAdvisoryFallback,
  type FallbackText,
} from './advisory-fallback-messages.js'
import {
  advisoryRulesForBatch,
  loadBatchScheduleEntries,
  loadCropCycleStages,
  loadCropCycleTasks,
} from './advisory-insights.js'
import {
  WEATHER_ADVISORY_RULES,
  cropRulesForCycle,
  daysBetween,
  dueRulesForDay,
  type AdvisoryNotifyRole,
} from './advisory-playbooks.js'
import {
  notifyRoles,
  notifyRolesTelegram,
  relayFreeFormEnglish,
  type NotifyRenderer,
} from './farm-notify.js'
import { completeChat, isLlmConfigured } from './llm.js'
import { checkLlmBudget, consumeLlmBudget } from './llm-budget.js'
import {
  resolveMarketplaceProducts,
  type MarketplaceProductHit,
} from './marketplace-search.js'
import { resolveStaffReplyLocale, type ReplyLocale } from './reply-locale.js'
import { sanitizeForLlm } from './sanitize-input.js'
import { getFarmWeather } from './weather.js'
import { renderWeatherAlert, withWeatherTiming, type WeatherAlert } from './weather-alerts.js'

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

/**
 * Where the "Now" line comes from, kept as parts rather than one string.
 *
 * `english` is the playbook seed (or generated) prose and is the only piece a
 * translator ever sees. The plot/batch name and the forecast numbers are
 * composed in afterwards: names are proper nouns, and dates, clock times and
 * amounts render from the weather locale table instead, because a translator
 * asked for French may well rewrite "3:00 PM" or a weekday and silently move a
 * rain window by hours.
 */
type AdvisoryNowSource =
  | { kind: 'subject'; english: string; subjectName: string }
  | { kind: 'weather'; english: string; alert: WeatherAlert }

/** Canonical-English source of one advisory push, before any reader is known. */
type AdvisoryMessageSource = {
  farmName: string
  now: AdvisoryNowSource
  whatNext: string
  aiSummary: string | null
  products: MarketplaceProductHit[]
  /** The rule's generic category, which keys the pre-translated seed fallback. */
  reasonCode: string
}

type MsgTable = Record<ReplyLocale, string>

function pick(locale: ReplyLocale, table: MsgTable): string {
  return table[locale] ?? table.en
}

/**
 * Locale tables for the advisory push chrome, in the style of digest-messages.ts:
 * developer-authored labels render from a table, so they are instant, free, and
 * still correct with the AI switched off.
 *
 * The farm, plot and batch names, the product titles and the URLs are data and
 * stay verbatim in every language.
 */
const HEADER: MsgTable = {
  en: '🌱 Trovara OS Advisory',
  fr: '🌱 Avis Trovara OS',
  yo: '🌱 Ìmọ̀ràn Trovara OS',
  pcm: '🌱 Trovara OS Advice',
}

const NOW_LABEL: MsgTable = {
  en: 'Now',
  fr: 'Maintenant',
  yo: 'Lọ́wọ́lọ́wọ́',
  pcm: 'Now',
}

const NEXT_LABEL: MsgTable = {
  en: 'Next',
  fr: 'Ensuite',
  yo: 'Èyí tó kàn',
  pcm: 'Next',
}

const WHY_LABEL: MsgTable = {
  en: 'Why',
  fr: 'Pourquoi',
  yo: 'Ìdí',
  pcm: 'Why',
}

const SUGGESTED_INPUTS: MsgTable = {
  en: 'Suggested inputs:',
  fr: 'Intrants suggérés :',
  yo: 'Àwọn ohun èlò tí a dábàá:',
  pcm: 'Things you fit use:',
}

const NO_PRODUCTS: MsgTable = {
  en: '• (no product links right now)',
  fr: '• (aucun lien produit pour le moment)',
  yo: '• (kò sí ìjápọ̀ ọjà lọ́wọ́lọ́wọ́)',
  pcm: '• (no product link for now)',
}

const SUGGESTED_FOR_AREA: MsgTable = {
  en: '(suggested for your area)',
  fr: '(suggéré pour votre région)',
  yo: '(a dábàá fún agbègbè rẹ)',
  pcm: '(we suggest am for your area)',
}

/**
 * Liability disclaimer. NEEDS HUMAN REVIEW before this ships: the fr/yo/pcm
 * wording below is a faithful translation of the English, but it carries legal
 * weight and no reviewer has signed off on the non-English versions.
 */
const DISCLAIMER: MsgTable = {
  en: 'Confirm sensitive actions with your supervisor. Trovara does not sell these products.',
  fr: 'Confirmez les actions sensibles avec votre superviseur. Trovara ne vend pas ces produits.',
  yo: 'Jẹ́rìí àwọn ìgbésẹ̀ pàtàkì pẹ̀lú alábojútó rẹ. Trovara kò ta àwọn ọjà wọ̀nyí.',
  pcm: 'Confirm any serious action with your supervisor. Trovara no dey sell dis products.',
}

/**
 * Compose the "Now" line from its parts.
 *
 * Called with `'en'` and the untranslated headline it reproduces the string that
 * goes into the database, which is what keeps the stored row and the English
 * push identical.
 */
function composeNowLine(
  locale: ReplyLocale,
  now: AdvisoryNowSource,
  headline: string,
): string {
  if (now.kind === 'subject') return `${headline} (${now.subjectName})`
  // renderWeatherAlert re-renders the alert's `params` (amounts, date, farm-local
  // peak clock) through weather-alert-messages.ts. Without params it returns the
  // alert untouched, so the timing degrades to canonical English rather than to a
  // translated guess at a date.
  const alert = locale === 'en' ? now.alert : renderWeatherAlert(locale, now.alert)
  return withWeatherTiming(headline, alert)
}

function formatAdvisoryMessage(
  locale: ReplyLocale,
  src: AdvisoryMessageSource,
  text: { happeningNow: string; whatNext: string; aiSummary: string | null },
): string {
  const productLines =
    src.products.length > 0
      ? src.products
          .map((p) => {
            if (p.url) return `• ${p.title}: ${p.url}`
            return `• ${p.title}${p.reason ? ` — ${p.reason}` : ''} ${pick(locale, SUGGESTED_FOR_AREA)}`
          })
          .join('\n')
      : pick(locale, NO_PRODUCTS)

  return [
    `${pick(locale, HEADER)} — ${src.farmName}`,
    '',
    `${pick(locale, NOW_LABEL)}: ${text.happeningNow}`,
    `${pick(locale, NEXT_LABEL)}: ${text.whatNext}`,
    text.aiSummary ? `${pick(locale, WHY_LABEL)}: ${text.aiSummary}` : null,
    '',
    pick(locale, SUGGESTED_INPUTS),
    productLines,
    '',
    pick(locale, DISCLAIMER),
  ]
    .filter((line) => line !== null)
    .join('\n')
}

/**
 * One seed line in the recipient's language when the relay could not put it
 * there.
 *
 * Every "Now" and "Next" line the engine pushes is deterministic seed prose,
 * from the playbook or from the batch's own schedule — nothing on this path is
 * generated — so rendering it for a French worker needs the LLM,
 * which is exactly what the degraded path does not have. The relay still runs
 * first, so a working translator keeps producing the specific seed sentence it
 * always has and the LLM-on push is byte-identical. Only when the relay hands
 * back the English it was given does the pre-translated table take over: that is
 * the difference between a French worker reading French and reading English. A
 * reason code the table does not know keeps the English, which is no worse than
 * today.
 */
function seedLine(
  locale: ReplyLocale,
  reasonCode: string,
  key: keyof FallbackText,
  english: string,
  relayed: string,
): string {
  if (locale === 'en' || relayed !== english) return relayed
  if (!isAdvisoryReasonCode(reasonCode)) return relayed
  return renderAdvisoryFallback(reasonCode, locale)[key]
}

/** The English "Now" line exactly as it is stored in advisory_recommendations. */
function englishHappeningNow(now: AdvisoryNowSource): string {
  return composeNowLine('en', now, now.english)
}

/**
 * One renderer for every recipient of one advisory, in their own language.
 *
 * The playbook prose and the AI summary are free-form English with no template,
 * so they go through `relayFreeFormEnglish`; the labels come from the tables
 * above. The result is memoized per language and the same renderer instance is
 * handed to both fan-outs, so a locale costs one render for the whole
 * recommendation no matter how many recipients or channels it reaches.
 *
 * Nothing here can drop a push: the relay already falls back to English on a
 * translation failure, and farm-notify re-renders in English if this throws.
 */
function advisoryRenderer(farmId: string, src: AdvisoryMessageSource): NotifyRenderer {
  const relayNow = relayFreeFormEnglish(src.now.english, farmId)
  const relayNext = relayFreeFormEnglish(src.whatNext, farmId)
  const relaySummary = src.aiSummary ? relayFreeFormEnglish(src.aiSummary, farmId) : null

  const byLocale = new Map<ReplyLocale, Promise<string>>()

  return ({ locale }) => {
    const inFlight = byLocale.get(locale)
    if (inFlight) return inFlight

    const pending = (async () => {
      const ctx = { preferredLocale: locale, locale }
      const [headline, whatNext, aiSummary] = await Promise.all([
        relayNow(ctx),
        relayNext(ctx),
        relaySummary ? relaySummary(ctx) : Promise.resolve(null),
      ])
      return formatAdvisoryMessage(locale, src, {
        happeningNow: composeNowLine(
          locale,
          src.now,
          seedLine(locale, src.reasonCode, 'happeningNow', src.now.english, headline),
        ),
        whatNext: seedLine(locale, src.reasonCode, 'whatNext', src.whatNext, whatNext),
        aiSummary,
      })
    })()

    byLocale.set(locale, pending)
    return pending
  }
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
  now: AdvisoryNowSource
  basePayload: Omit<AdvisoryPayload, 'products' | 'happeningNow'>
  /**
   * The owner's language, and only a hint for sourcing product suggestions. It
   * must not reach the payload as language, and it is not the reader's: one
   * recommendation is stored once, in canonical English, for everyone.
   */
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

  const payload: AdvisoryPayload = {
    ...args.basePayload,
    happeningNow: englishHappeningNow(args.now),
    products,
  }
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

  // Rendering happens strictly after the insert, from the parts rather than from
  // the stored payload, so no reader's language can reach the row above.
  const message = advisoryRenderer(args.farmId, {
    farmName: args.farmName,
    now: args.now,
    whatNext: payload.whatNext,
    aiSummary,
    products,
    reasonCode: payload.reasonCode,
  })
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

  const cyclePlans = await loadCropCycleTasks(cycles.map((cycle) => cycle.id))

  for (const cycle of cycles) {
    const stageStart = cycle.stageEnteredAt ?? cycle.plantedAt
    const dayInStage = daysBetween(stageStart, now)
    const rules = cropRulesForCycle(cycle, cyclePlans.get(cycle.id) ?? [])
    for (const rule of dueRulesForDay(dayInStage, rules)) {
      const row = await persistAndNotify({
        farmId,
        farmName: farm.name,
        farmLocation: farm.location,
        ruleKey: rule.ruleKey,
        sourceType: 'crop_cycle',
        sourceId: cycle.id,
        notifyRolesList: rule.notifyRoles,
        locale,
        now: {
          kind: 'subject',
          english: rule.happeningNow,
          subjectName: cycle.plotName,
        },
        basePayload: {
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

  const batches = await db
    .select()
    .from(livestockBatches)
    .where(and(eq(livestockBatches.farmId, farmId), eq(livestockBatches.active, true)))

  const schedules = await loadBatchScheduleEntries(batches.map((batch) => batch.id))

  for (const batch of batches) {
    const rules = advisoryRulesForBatch(batch, schedules.get(batch.id) ?? [])
    const dayInCycle = daysBetween(batch.acquiredAt, now)
    for (const rule of dueRulesForDay(dayInCycle, rules)) {
      const row = await persistAndNotify({
        farmId,
        farmName: farm.name,
        farmLocation: farm.location,
        ruleKey: rule.ruleKey,
        sourceType: 'livestock_batch',
        sourceId: batch.id,
        notifyRolesList: rule.notifyRoles,
        locale,
        now: { kind: 'subject', english: rule.happeningNow, subjectName: batch.name },
        basePayload: {
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
        now: { kind: 'weather', english: rule.happeningNow, alert },
        basePayload: {
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

  const cycleIds = cycles.map((cycle) => cycle.id)
  const [cyclePlans, cycleStages] = await Promise.all([
    loadCropCycleTasks(cycleIds),
    loadCropCycleStages(cycleIds),
  ])

  for (const cycle of cycles) {
    const stageStart = cycle.stageEnteredAt ?? cycle.plantedAt
    const dayInStage = daysBetween(stageStart, now)
    const rules = cropRulesForCycle(cycle, cyclePlans.get(cycle.id) ?? [])
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
      // How long the stage should run is per cycle, so it is read off the
      // cycle's own row. A cycle with no plan reports nothing rather than a
      // length borrowed from a crop it may not be.
      totalStageDays:
        cycleStages.get(cycle.id)?.find((entry) => entry.stage === cycle.stage)?.durationDays ??
        null,
      daysUntilNextHint: upcoming?.daysUntil ?? null,
      nextHint: upcoming?.rule.whatNext ?? null,
    })
  }

  const batches = await db
    .select()
    .from(livestockBatches)
    .where(and(eq(livestockBatches.farmId, farmId), eq(livestockBatches.active, true)))

  const schedules = await loadBatchScheduleEntries(batches.map((batch) => batch.id))

  for (const batch of batches) {
    const dayInCycle = daysBetween(batch.acquiredAt, now)
    const upcoming = advisoryRulesForBatch(batch, schedules.get(batch.id) ?? [])
      .map((r) => ({ rule: r, daysUntil: r.offsetDays - dayInCycle }))
      .filter((x) => x.daysUntil >= 0)
      .sort((a, b) => a.daysUntil - b.daysUntil)[0]

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

export type { InsightKey, InsightTip } from './advisory-insights.js'
export { buildInsightTips, isLocalizedFallbackTip } from './advisory-insights.js'
