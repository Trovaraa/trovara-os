import { and, eq, isNull } from 'drizzle-orm'
import { db } from '../db/index.js'
import { cropCycles, livestockBatches } from '../db/schema.js'
import { renderWeatherTheme } from './advisory-fallback-messages.js'
import { buildWeatherActionsPrompt } from './ai-advisor.js'
import { toViewerLocaleMany } from './content-locale.js'
import { completeChat, isLlmConfigured, parseJsonFromLlm } from './llm.js'
import { checkLlmBudget, consumeLlmBudget } from './llm-budget.js'
import { resolveStaffReplyLocale, type ReplyLocale } from './reply-locale.js'
import { sanitizeForLlm } from './sanitize-input.js'
import {
  buildWeatherActions,
  type WeatherAction,
  type WeatherActionPriority,
} from './weather-actions.js'
import type { WeatherAlert, WeatherAlertType, WeatherDay } from './weather-alerts.js'

type ForecastInput = {
  current: {
    tempC: number
    feelsLikeC: number | null
    humidity: number | null
    windKmh: number
    condition: string
  }
  daily: WeatherDay[]
}

type LlmActionRow = {
  id?: unknown
  priority?: unknown
  title?: unknown
  detail?: unknown
  relatedAlert?: unknown
}

const PRIORITIES = new Set<WeatherActionPriority>(['high', 'medium', 'low'])
const ALERT_TYPES = new Set<WeatherAlertType>(['rain', 'heat', 'wind', 'cold'])
const MAX_ACTIONS = 4

export function validateWeatherActionsFromLlm(raw: unknown, alerts: WeatherAlert[]): WeatherAction[] | null {
  if (!raw || typeof raw !== 'object') return null
  const actionsRaw = (raw as { actions?: unknown }).actions
  if (!Array.isArray(actionsRaw)) return null

  const out: WeatherAction[] = []
  const seen = new Set<string>()

  for (const row of actionsRaw.slice(0, MAX_ACTIONS) as LlmActionRow[]) {
    const id = typeof row.id === 'string' ? row.id.trim().slice(0, 64) : ''
    const title = typeof row.title === 'string' ? row.title.trim().slice(0, 80) : ''
    const detail = typeof row.detail === 'string' ? row.detail.trim().slice(0, 240) : ''
    const priority =
      typeof row.priority === 'string' && PRIORITIES.has(row.priority as WeatherActionPriority)
        ? (row.priority as WeatherActionPriority)
        : null
    if (!id || !title || !detail || !priority) continue
    if (seen.has(id)) continue
    seen.add(id)

    let relatedAlert: WeatherAlertType | undefined
    if (
      typeof row.relatedAlert === 'string' &&
      ALERT_TYPES.has(row.relatedAlert as WeatherAlertType)
    ) {
      relatedAlert = row.relatedAlert as WeatherAlertType
    }

    out.push({ id, priority, title, detail, relatedAlert })
  }

  if (out.length === 0 && alerts.length > 0) return null
  return out
}

async function loadFarmWeatherSnippet(farmId: string): Promise<string> {
  const [crops, livestock] = await Promise.all([
    db
      .select({
        cropType: cropCycles.cropType,
        stage: cropCycles.stage,
      })
      .from(cropCycles)
      .where(and(eq(cropCycles.farmId, farmId), isNull(cropCycles.actualHarvestAt)))
      .limit(12),
    db
      .select({
        name: livestockBatches.name,
        species: livestockBatches.species,
        headCount: livestockBatches.headCount,
      })
      .from(livestockBatches)
      .where(and(eq(livestockBatches.farmId, farmId), eq(livestockBatches.active, true)))
      .limit(12),
  ])

  const cropLines = crops.map((c) => `- ${c.cropType} (${c.stage})`)
  const stockLines = livestock.map((b) => `- ${b.name}: ${b.species}, ${b.headCount} head`)

  const parts: string[] = []
  parts.push(cropLines.length ? `Active crops:\n${cropLines.join('\n')}` : 'Active crops: none listed')
  parts.push(
    stockLines.length ? `Active livestock:\n${stockLines.join('\n')}` : 'Active livestock: none listed',
  )
  return parts.join('\n')
}

function buildUserPayload(
  forecast: ForecastInput,
  alerts: WeatherAlert[],
  farmSnippet: string,
): string {
  const horizon = forecast.daily.slice(0, 3).map((d) => ({
    date: d.date,
    tempMinC: d.tempMinC,
    tempMaxC: d.tempMaxC,
    precipMm: d.precipMm,
    precipProb: d.precipProb,
    windKmh: d.windKmh,
    condition: d.condition,
  }))

  return sanitizeForLlm(
    [
      'Farm context:',
      farmSnippet,
      '',
      'Current weather:',
      JSON.stringify(forecast.current),
      '',
      'Next 3 days:',
      JSON.stringify(horizon),
      '',
      'Threshold alerts:',
      JSON.stringify(alerts),
    ].join('\n'),
  )
}

export type GeneratedWeatherActions = {
  /** Canonical English actions. This is what gets cached and stored. */
  actions: WeatherAction[]
  source: 'ai' | 'rules'
}

export type ResolvedWeatherActions = GeneratedWeatherActions & {
  /**
   * The same advice rendered into the viewer's language. Identical to
   * `actions` for an English viewer.
   */
  localizedActions: WeatherAction[]
  /**
   * The language the actions were RENDERED into for this viewer — not the
   * language they were generated in. Generation is always English.
   */
  renderedLocale: ReplyLocale
}

/**
 * Generate weather actions once, in English, so every viewer of the same
 * forecast and farm state gets the same underlying advice. Prefers LLM
 * farm-grounded actions and falls back to rule-based English themes.
 */
export async function generateWeatherActions(
  farmId: string,
  forecast: ForecastInput,
  alerts: WeatherAlert[],
): Promise<GeneratedWeatherActions> {
  const rules = (): GeneratedWeatherActions => ({
    actions: buildWeatherActions(forecast.daily, forecast.current.windKmh, alerts),
    source: 'rules',
  })

  if (!isLlmConfigured()) return rules()
  const budget = checkLlmBudget(farmId)
  if (!budget.allowed) return rules()

  try {
    const farmSnippet = await loadFarmWeatherSnippet(farmId)
    const { text } = await completeChat(
      buildWeatherActionsPrompt(),
      buildUserPayload(forecast, alerts, farmSnippet),
    )
    consumeLlmBudget(farmId)
    const parsed = parseJsonFromLlm<unknown>(text)
    const validated = validateWeatherActionsFromLlm(parsed, alerts)
    if (!validated) return rules()
    return { actions: validated, source: 'ai' }
  } catch {
    return rules()
  }
}

/**
 * Render stored English actions into the viewer's language.
 *
 * Generated actions are real English prose about this farm and go to the content
 * translator, one batched call for every title and detail. Rules-fallback
 * actions do not: they are the fixed `THEME_BY_ALERT` seeds, keyed by theme id,
 * and the translator needs the same LLM the fallback exists to survive. Sending
 * them there is what showed a French worker English at exactly the wrong moment,
 * so they render from the pre-translated table instead — instantly, and with no
 * model. A theme the table has never heard of still goes to the translator,
 * which is no worse than before.
 *
 * An English viewer does no work at all. Translation failures leave the English
 * text in place rather than blanking the card.
 */
export async function localizeWeatherActions(
  farmId: string,
  actions: WeatherAction[],
  preferredLocale?: string | null,
  source: GeneratedWeatherActions['source'] = 'ai',
): Promise<WeatherAction[]> {
  const locale = resolveStaffReplyLocale(preferredLocale)
  if (locale === 'en' || actions.length === 0) return actions

  const themed = actions.map((action) =>
    source === 'rules' ? renderWeatherTheme(action.id, locale) : null,
  )
  const withThemes = (): WeatherAction[] =>
    actions.map((action, i) => {
      const theme = themed[i]
      return theme ? { ...action, title: theme.title, detail: theme.detail } : action
    })

  const pending = actions.filter((_, i) => themed[i] === null)
  if (pending.length === 0) return withThemes()

  try {
    const rendered = await toViewerLocaleMany({
      texts: pending.flatMap((a) => [a.title, a.detail]),
      targetLocale: locale,
      farmId,
    })
    let next = 0
    return actions.map((action, i) => {
      const theme = themed[i]
      if (theme) return { ...action, title: theme.title, detail: theme.detail }
      const slot = next++
      return {
        ...action,
        title: rendered[slot * 2] || action.title,
        detail: rendered[slot * 2 + 1] || action.detail,
      }
    })
  } catch {
    return withThemes()
  }
}

/**
 * Generate English weather actions and render them for one viewer.
 * Callers persist `actions` (English) and serve `localizedActions`.
 *
 * The two paths meet here: `generated.source` says whether the English behind
 * this viewer's copy was written by the model or came off the rules seeds, and
 * that is what decides between the translator and the pre-translated table.
 * Only `localizedActions` differs by reader — `actions` stays canonical English
 * for the cache, whichever path produced it.
 */
export async function resolveWeatherActions(
  farmId: string,
  forecast: ForecastInput,
  alerts: WeatherAlert[],
  preferredLocale?: string | null,
): Promise<ResolvedWeatherActions> {
  const renderedLocale = resolveStaffReplyLocale(preferredLocale)
  const generated = await generateWeatherActions(farmId, forecast, alerts)
  const localizedActions = await localizeWeatherActions(
    farmId,
    generated.actions,
    renderedLocale,
    generated.source,
  )
  return { ...generated, localizedActions, renderedLocale }
}
