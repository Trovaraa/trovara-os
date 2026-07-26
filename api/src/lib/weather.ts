import { eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { farms, weatherCache } from '../db/schema.js'
import {
  buildWeatherAlerts,
  formatLocalClockLabel,
  localizeWeatherAlerts,
  type WeatherAlert,
  type WeatherDay,
} from './weather-alerts.js'
import { buildWeatherActions, type WeatherAction } from './weather-actions.js'
import { localizeWeatherActions, resolveWeatherActions } from './weather-ai-actions.js'
import { resolveStaffReplyLocale } from './reply-locale.js'

export type { WeatherAlert, WeatherAlertType, WeatherDay } from './weather-alerts.js'
export { buildWeatherAlerts } from './weather-alerts.js'
export type { WeatherAction, WeatherActionPriority } from './weather-actions.js'
export { buildWeatherActions } from './weather-actions.js'

export type WeatherSnapshot = {
  status: 'ok' | 'stale' | 'unavailable' | 'unconfigured'
  provider: string
  attribution: string
  fetchedAt: string | null
  timezone: string | null
  locationLabel: string | null
  current: {
    tempC: number
    feelsLikeC: number | null
    humidity: number | null
    windKmh: number
    condition: string
  } | null
  daily: WeatherDay[]
  alerts: WeatherAlert[]
  actions: WeatherAction[]
  actionsSource?: 'ai' | 'rules'
  /** Language the actions were rendered into for this viewer, not generated in. */
  actionsLocale?: string
  message?: string
}

type NormalizedForecast = {
  provider: string
  attribution: string
  current: NonNullable<WeatherSnapshot['current']>
  daily: WeatherDay[]
}

type CachedWeatherPayload = NormalizedForecast & {
  /** Canonical English actions. Viewer language is applied when serving, never here. */
  actions?: WeatherAction[]
  actionsSource?: 'ai' | 'rules'
  /**
   * Language of the STORED actions, always 'en'. Older cache entries were
   * written in the requesting viewer's language; those are discarded on read.
   */
  actionsLocale?: string
}

const STORED_ACTIONS_LOCALE = 'en'

const HOUR_MS = 60 * 60 * 1000
const MINUTE_MS = 60 * 1000

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

function cacheTtlMs(): number {
  return Math.max(5, numEnv('WEATHER_CACHE_TTL_MINUTES', 30)) * MINUTE_MS
}

function staleMaxMs(): number {
  return Math.max(1, numEnv('WEATHER_STALE_MAX_HOURS', 6)) * HOUR_MS
}

function providerName(): string {
  return (process.env.WEATHER_PROVIDER?.trim().toLowerCase() || 'openweathermap') as string
}

function parseCoord(value: string | null | undefined): number | null {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function asNormalizedForecast(payload: CachedWeatherPayload): NormalizedForecast {
  return {
    provider: payload.provider,
    attribution: payload.attribution,
    current: payload.current,
    daily: payload.daily,
  }
}

async function snapshotFromNormalized(
  status: WeatherSnapshot['status'],
  normalized: NormalizedForecast,
  fetchedAt: Date,
  timezone: string | null,
  locationLabel: string | null,
  farmId: string,
  options?: {
    message?: string
    actions?: WeatherAction[]
    actionsSource?: 'ai' | 'rules'
    actionsLocale?: string
    preferredLocale?: string | null
  },
): Promise<WeatherSnapshot> {
  // English alerts feed the rules engine; the viewer's copy is rendered below.
  const alerts = buildWeatherAlerts(normalized.daily, normalized.current.windKmh, timezone ?? 'Africa/Lagos')
  const locale = resolveStaffReplyLocale(options?.preferredLocale)
  const cachedActionsOk =
    Array.isArray(options?.actions) &&
    options?.actionsSource === 'ai' &&
    (options?.actionsLocale ?? STORED_ACTIONS_LOCALE) === STORED_ACTIONS_LOCALE

  const actionsSource = cachedActionsOk ? 'ai' : 'rules'
  const english = cachedActionsOk
    ? (options!.actions as WeatherAction[])
    : buildWeatherActions(normalized.daily, normalized.current.windKmh, alerts)

  // Both hold canonical English, but they are rendered differently: generated
  // text is translated, the rules themes come off a pre-translated table that
  // still works with the LLM off.
  const actions = await localizeWeatherActions(farmId, english, locale, actionsSource)

  return {
    status,
    provider: normalized.provider,
    attribution: normalized.attribution,
    fetchedAt: fetchedAt.toISOString(),
    timezone,
    locationLabel,
    current: normalized.current,
    daily: normalized.daily,
    // Localized at serve time from a language-neutral cache, so the API returns
    // alert text the client can print as-is in any of the four languages.
    alerts: localizeWeatherAlerts(locale, alerts),
    actions,
    actionsSource,
    actionsLocale: locale,
    message: options?.message,
  }
}

async function persistWeatherCache(
  farmId: string,
  payload: CachedWeatherPayload,
  fetchedAt: Date,
  expiresAt: Date,
): Promise<void> {
  await db
    .insert(weatherCache)
    .values({
      farmId,
      provider: payload.provider,
      payload: payload as unknown as Record<string, unknown>,
      fetchedAt,
      expiresAt,
    })
    .onConflictDoUpdate({
      target: weatherCache.farmId,
      set: {
        provider: payload.provider,
        payload: payload as unknown as Record<string, unknown>,
        fetchedAt,
        expiresAt,
      },
    })
}

async function fetchOpenWeatherMap(
  lat: number,
  lon: number,
  timezone: string,
): Promise<NormalizedForecast> {
  const key = process.env.WEATHER_API_KEY?.trim()
  if (!key) throw new Error('WEATHER_API_KEY is required for openweathermap')

  const base =
    process.env.WEATHER_API_BASE_URL?.trim() || 'https://api.openweathermap.org/data/2.5'
  const qs = `lat=${lat}&lon=${lon}&appid=${encodeURIComponent(key)}&units=metric`
  const timeout = AbortSignal.timeout(10_000)
  const tz = timezone || 'Africa/Lagos'

  const [currentRes, forecastRes] = await Promise.all([
    fetch(`${base}/weather?${qs}`, { signal: timeout }),
    fetch(`${base}/forecast?${qs}`, { signal: timeout }),
  ])

  if (!currentRes.ok || !forecastRes.ok) {
    if (currentRes.status === 401 || forecastRes.status === 401) {
      throw new Error(
        'OpenWeatherMap rejected the API key (401). Confirm WEATHER_API_KEY in .env, restart the API, and wait up to ~2 hours if the key is brand new.',
      )
    }
    throw new Error(`OpenWeatherMap error: ${currentRes.status}/${forecastRes.status}`)
  }

  const currentJson = (await currentRes.json()) as {
    main?: { temp?: number; feels_like?: number; humidity?: number }
    wind?: { speed?: number }
    weather?: Array<{ description?: string }>
  }
  const forecastJson = (await forecastRes.json()) as {
    list?: Array<{
      dt: number
      main?: { temp_min?: number; temp_max?: number }
      wind?: { speed?: number }
      rain?: { '3h'?: number }
      pop?: number
      weather?: Array<{ description?: string }>
    }>
  }

  const byDay = new Map<
    string,
    {
      mins: number[]
      maxs: number[]
      precip: number
      pop: number
      wind: number[]
      conditions: string[]
      peakScore: number
      peakPrecipAt: string | null
    }
  >()

  for (const row of forecastJson.list ?? []) {
    const at = new Date(row.dt * 1000)
    const date = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(at)
    const bucket = byDay.get(date) ?? {
      mins: [],
      maxs: [],
      precip: 0,
      pop: 0,
      wind: [],
      conditions: [],
      peakScore: -1,
      peakPrecipAt: null,
    }
    if (row.main?.temp_min != null) bucket.mins.push(row.main.temp_min)
    if (row.main?.temp_max != null) bucket.maxs.push(row.main.temp_max)
    const slotMm = row.rain?.['3h'] ?? 0
    const popPct = (row.pop ?? 0) * 100
    bucket.precip += slotMm
    // Prefer the 3h slot with the strongest rain signal (mm, then probability).
    const score = slotMm * 10 + popPct
    if (score > bucket.peakScore) {
      bucket.peakScore = score
      bucket.peakPrecipAt = at.toISOString()
    }
    bucket.pop = Math.max(bucket.pop, popPct)
    if (row.wind?.speed != null) bucket.wind.push(row.wind.speed * 3.6)
    const cond = row.weather?.[0]?.description
    if (cond) bucket.conditions.push(cond)
    byDay.set(date, bucket)
  }

  const daily: WeatherDay[] = [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, 5)
    .map(([date, b]) => {
      const peakAt = b.peakPrecipAt
      return {
        date,
        tempMinC: Math.min(...(b.mins.length ? b.mins : [0])),
        tempMaxC: Math.max(...(b.maxs.length ? b.maxs : [0])),
        precipMm: Math.round(b.precip * 10) / 10,
        precipProb: Math.round(b.pop),
        windKmh: b.wind.length ? Math.round(Math.max(...b.wind)) : 0,
        condition: b.conditions[0] ?? '—',
        peakPrecipAt: peakAt,
        peakPrecipLocal: peakAt ? formatLocalClockLabel(peakAt, tz) : null,
      }
    })

  return {
    provider: 'openweathermap',
    attribution: 'Weather data by OpenWeather',
    current: {
      tempC: Math.round((currentJson.main?.temp ?? 0) * 10) / 10,
      feelsLikeC:
        currentJson.main?.feels_like != null
          ? Math.round(currentJson.main.feels_like * 10) / 10
          : null,
      humidity: currentJson.main?.humidity ?? null,
      windKmh: Math.round((currentJson.wind?.speed ?? 0) * 3.6),
      condition: currentJson.weather?.[0]?.description ?? '—',
    },
    daily,
  }
}

async function fetchOpenMeteo(lat: number, lon: number, timezone: string): Promise<NormalizedForecast> {
  const base =
    process.env.WEATHER_API_BASE_URL?.trim() || 'https://api.open-meteo.com/v1/forecast'
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    timezone,
    current: 'temperature_2m,relative_humidity_2m,apparent_temperature,wind_speed_10m,weather_code',
    daily:
      'temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,weather_code',
    hourly: 'precipitation,precipitation_probability',
    forecast_days: '5',
    wind_speed_unit: 'kmh',
  })

  const res = await fetch(`${base}?${params}`, { signal: AbortSignal.timeout(10_000) })
  if (!res.ok) throw new Error(`Open-Meteo error: ${res.status}`)

  const json = (await res.json()) as {
    current?: {
      temperature_2m?: number
      apparent_temperature?: number
      relative_humidity_2m?: number
      wind_speed_10m?: number
      weather_code?: number
    }
    daily?: {
      time?: string[]
      temperature_2m_max?: number[]
      temperature_2m_min?: number[]
      precipitation_sum?: number[]
      precipitation_probability_max?: (number | null)[]
      wind_speed_10m_max?: number[]
      weather_code?: number[]
    }
    hourly?: {
      time?: string[]
      precipitation?: number[]
      precipitation_probability?: (number | null)[]
    }
  }

  const peakByDate = new Map<string, { score: number; at: string }>()
  const hourlyTimes = json.hourly?.time ?? []
  for (let i = 0; i < hourlyTimes.length; i++) {
    const localStamp = hourlyTimes[i] // e.g. 2026-07-25T15:00
    const date = localStamp.slice(0, 10)
    const mm = json.hourly?.precipitation?.[i] ?? 0
    const pop = json.hourly?.precipitation_probability?.[i] ?? 0
    // Ignore empty hours so we don't pin "peak" to midnight.
    if (mm <= 0 && (pop ?? 0) < 30) continue
    const score = mm * 10 + (pop ?? 0)
    const prev = peakByDate.get(date)
    if (!prev || score > prev.score) {
      const at = localStamp.length === 16 ? `${localStamp}:00` : localStamp
      peakByDate.set(date, { score, at })
    }
  }

  const daily: WeatherDay[] = (json.daily?.time ?? []).slice(0, 5).map((date, i) => {
    const peak = peakByDate.get(date)
    let peakPrecipLocal: string | null = null
    if (peak?.at) {
      // Format clock from the local wall-time stamp without shifting TZ twice.
      const hourPart = peak.at.slice(11, 16) // HH:mm
      const [hh, mm] = hourPart.split(':').map(Number)
      if (Number.isFinite(hh)) {
        const period = hh >= 12 ? 'PM' : 'AM'
        const h12 = ((hh + 11) % 12) + 1
        peakPrecipLocal = `around ${h12}:${String(mm || 0).padStart(2, '0')} ${period}`
      }
    }
    return {
      date,
      tempMinC: json.daily?.temperature_2m_min?.[i] ?? 0,
      tempMaxC: json.daily?.temperature_2m_max?.[i] ?? 0,
      precipMm: Math.round((json.daily?.precipitation_sum?.[i] ?? 0) * 10) / 10,
      precipProb: json.daily?.precipitation_probability_max?.[i] ?? null,
      windKmh: Math.round(json.daily?.wind_speed_10m_max?.[i] ?? 0),
      condition: weatherCodeLabel(json.daily?.weather_code?.[i] ?? 0),
      peakPrecipAt: peak?.at ?? null,
      peakPrecipLocal,
    }
  })

  return {
    provider: 'open-meteo',
    attribution: 'Weather data by Open-Meteo.com',
    current: {
      tempC: Math.round((json.current?.temperature_2m ?? 0) * 10) / 10,
      feelsLikeC:
        json.current?.apparent_temperature != null
          ? Math.round(json.current.apparent_temperature * 10) / 10
          : null,
      humidity: json.current?.relative_humidity_2m ?? null,
      windKmh: Math.round(json.current?.wind_speed_10m ?? 0),
      condition: weatherCodeLabel(json.current?.weather_code ?? 0),
    },
    daily,
  }
}

function weatherCodeLabel(code: number): string {
  if (code === 0) return 'Clear'
  if (code <= 3) return 'Partly cloudy'
  if (code <= 48) return 'Fog'
  if (code <= 57) return 'Drizzle'
  if (code <= 67) return 'Rain'
  if (code <= 77) return 'Snow'
  if (code <= 82) return 'Rain showers'
  if (code <= 99) return 'Thunderstorm'
  return 'Unknown'
}

async function fetchNormalized(
  lat: number,
  lon: number,
  timezone: string,
): Promise<NormalizedForecast> {
  const provider = providerName()
  if (provider === 'open-meteo') return fetchOpenMeteo(lat, lon, timezone)
  return fetchOpenWeatherMap(lat, lon, timezone)
}

function emptySnapshot(
  status: WeatherSnapshot['status'],
  message: string,
  locationLabel: string | null = null,
  timezone: string | null = null,
): WeatherSnapshot {
  return {
    status,
    provider: providerName(),
    attribution: '',
    fetchedAt: null,
    timezone,
    locationLabel,
    current: null,
    daily: [],
    alerts: [],
    actions: [],
    actionsSource: 'rules',
    message,
  }
}

export type GetFarmWeatherOptions = {
  preferredLocale?: string | null
  /** Bypass cache and fetch a fresh forecast (used for on-demand weather insights). */
  forceRefresh?: boolean
}

export async function getFarmWeather(
  farmId: string,
  options: GetFarmWeatherOptions = {},
): Promise<WeatherSnapshot> {
  const [farm] = await db
    .select({
      location: farms.location,
      latitude: farms.latitude,
      longitude: farms.longitude,
      timezone: farms.timezone,
    })
    .from(farms)
    .where(eq(farms.id, farmId))
    .limit(1)

  if (!farm) return emptySnapshot('unavailable', 'Farm not found')

  const lat = parseCoord(farm.latitude)
  const lon = parseCoord(farm.longitude)
  const timezone = farm.timezone?.trim() || 'Africa/Lagos'
  const locationLabel = farm.location
  const preferredLocale = options.preferredLocale

  if (lat == null || lon == null) {
    return emptySnapshot(
      'unconfigured',
      'Set farm latitude and longitude in Settings to enable weather.',
      locationLabel,
      timezone,
    )
  }

  const provider = providerName()
  if (provider === 'openweathermap' && !process.env.WEATHER_API_KEY?.trim()) {
    return emptySnapshot(
      'unconfigured',
      'Weather provider is not configured (set WEATHER_API_KEY).',
      locationLabel,
      timezone,
    )
  }

  const now = Date.now()
  const [cached] = await db
    .select()
    .from(weatherCache)
    .where(eq(weatherCache.farmId, farmId))
    .limit(1)

  const cacheFresh = Boolean(cached && cached.expiresAt.getTime() > now)
  const cachedPayload = cached
    ? (cached.payload as unknown as CachedWeatherPayload)
    : null
  const cachedHasPeakTiming = Boolean(
    cachedPayload?.daily?.some((d) => d.peakPrecipLocal || d.peakPrecipAt),
  )

  if (cacheFresh && !options.forceRefresh && cachedHasPeakTiming) {
    return snapshotFromNormalized(
      'ok',
      asNormalizedForecast(cachedPayload!),
      cached!.fetchedAt,
      timezone,
      locationLabel,
      farmId,
      {
        preferredLocale,
        actions: cachedPayload!.actions,
        actionsSource: cachedPayload!.actionsSource,
        actionsLocale: cachedPayload!.actionsLocale,
      },
    )
  }

  try {
    const normalized = await fetchNormalized(lat, lon, timezone)
    const fetchedAt = new Date()
    const expiresAt = new Date(fetchedAt.getTime() + cacheTtlMs())
    // Fresh forecast: clear prior AI actions so the client can regenerate for this horizon.
    const payload: CachedWeatherPayload = { ...normalized }

    await persistWeatherCache(farmId, payload, fetchedAt, expiresAt)

    return snapshotFromNormalized('ok', normalized, fetchedAt, timezone, locationLabel, farmId, {
      preferredLocale,
    })
  } catch (err) {
    if (cached && now - cached.fetchedAt.getTime() <= staleMaxMs()) {
      const payload = cached.payload as unknown as CachedWeatherPayload
      return snapshotFromNormalized(
        'stale',
        asNormalizedForecast(payload),
        cached.fetchedAt,
        timezone,
        locationLabel,
        farmId,
        {
          message: 'Showing cached weather — live fetch failed.',
          preferredLocale,
          actions: payload.actions,
          actionsSource: payload.actionsSource,
          actionsLocale: payload.actionsLocale,
        },
      )
    }

    const message = err instanceof Error ? err.message : 'Weather unavailable'
    return emptySnapshot('unavailable', message, locationLabel, timezone)
  }
}

/**
 * Force AI (or rules fallback) weather actions for the farm's cached forecast.
 * Updates weather_cache actions fields without refetching the provider.
 *
 * The cache holds the English generation; the caller's language is applied to
 * the returned copy only, so two viewers never store divergent advice.
 */
export async function regenerateWeatherActions(
  farmId: string,
  preferredLocale?: string | null,
): Promise<{
  actions: WeatherAction[]
  actionsSource: 'ai' | 'rules'
  actionsLocale: string
  alerts: WeatherAlert[]
} | null> {
  const [cached] = await db
    .select()
    .from(weatherCache)
    .where(eq(weatherCache.farmId, farmId))
    .limit(1)

  if (!cached) return null

  const payload = cached.payload as unknown as CachedWeatherPayload
  const normalized = asNormalizedForecast(payload)
  if (!normalized.current || !normalized.daily?.length) return null

  const [farm] = await db
    .select({ timezone: farms.timezone })
    .from(farms)
    .where(eq(farms.id, farmId))
    .limit(1)
  const alerts = buildWeatherAlerts(
    normalized.daily,
    normalized.current.windKmh,
    farm?.timezone?.trim() || 'Africa/Lagos',
  )
  const resolved = await resolveWeatherActions(farmId, normalized, alerts, preferredLocale)

  const nextPayload: CachedWeatherPayload = {
    ...normalized,
    actions: resolved.actions,
    actionsSource: resolved.source,
    actionsLocale: STORED_ACTIONS_LOCALE,
  }

  await db
    .update(weatherCache)
    .set({
      payload: nextPayload as unknown as Record<string, unknown>,
    })
    .where(eq(weatherCache.farmId, farmId))

  return {
    actions: resolved.localizedActions,
    actionsSource: resolved.source,
    actionsLocale: resolved.renderedLocale,
    // The English `alerts` above drove action generation; the caller gets the
    // viewer's language, matching the /api/today alert path.
    alerts: localizeWeatherAlerts(resolveStaffReplyLocale(preferredLocale), alerts),
  }
}
