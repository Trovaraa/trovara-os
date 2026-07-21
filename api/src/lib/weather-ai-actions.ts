import { and, eq, isNull } from 'drizzle-orm'
import { db } from '../db/index.js'
import { cropCycles, livestockBatches } from '../db/schema.js'
import { buildWeatherActionsPrompt } from './ai-advisor.js'
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

/**
 * Prefer LLM farm-grounded weather actions; fall back to rule-based themes.
 */
export async function resolveWeatherActions(
  farmId: string,
  forecast: ForecastInput,
  alerts: WeatherAlert[],
  preferredLocale?: string | null,
): Promise<{ actions: WeatherAction[]; source: 'ai' | 'rules'; locale: ReplyLocale }> {
  const locale = resolveStaffReplyLocale(preferredLocale)
  const rules = () => ({
    actions: buildWeatherActions(forecast.daily, forecast.current.windKmh, alerts),
    source: 'rules' as const,
    locale,
  })

  if (!isLlmConfigured()) return rules()
  const budget = checkLlmBudget(farmId)
  if (!budget.allowed) return rules()

  try {
    const farmSnippet = await loadFarmWeatherSnippet(farmId)
    const { text } = await completeChat(
      buildWeatherActionsPrompt(locale),
      buildUserPayload(forecast, alerts, farmSnippet),
    )
    consumeLlmBudget(farmId)
    const parsed = parseJsonFromLlm<unknown>(text)
    const validated = validateWeatherActionsFromLlm(parsed, alerts)
    if (!validated) return rules()
    return { actions: validated, source: 'ai', locale }
  } catch {
    return rules()
  }
}
