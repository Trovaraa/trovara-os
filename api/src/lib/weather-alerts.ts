import {
  forecastDayLabel,
  localizeWeatherAlerts,
  parseClockLabel,
  renderWeatherAlert,
  type WeatherAlertLocaleParams,
} from './weather-alert-messages.js'

export type WeatherAlertType = 'rain' | 'heat' | 'wind' | 'cold'

export type WeatherAlert = {
  type: WeatherAlertType
  severity: 'high' | 'medium'
  title: string
  message: string
  /** Human-readable when window, e.g. "Tomorrow around 3–6 PM". */
  whenLabel?: string
  /** ISO date (YYYY-MM-DD) the alert is tied to. */
  date?: string
  /**
   * When window plus amounts, in the same language as `message`. Lets
   * withWeatherTiming append timing without parsing English prose.
   */
  timingDetail?: string
  /** Numbers behind title/message, so any viewer language can be rendered. */
  params?: WeatherAlertLocaleParams
}

export type WeatherDay = {
  date: string
  tempMinC: number
  tempMaxC: number
  precipMm: number
  precipProb: number | null
  windKmh: number
  condition: string
  /** Local clock label for peak precip slot, e.g. "around 3:00 PM". */
  peakPrecipLocal?: string | null
  /** Start of peak precip window as ISO string. */
  peakPrecipAt?: string | null
}

type Thresholds = {
  heatC: number
  coldC: number
  windKmh: number
  rainMm: number
  rainProb: number
}

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

export function weatherThresholds(): Thresholds {
  return {
    heatC: numEnv('WEATHER_HEAT_C', 35),
    coldC: numEnv('WEATHER_COLD_C', 15),
    windKmh: numEnv('WEATHER_WIND_KMH', 40),
    rainMm: numEnv('WEATHER_RAIN_MM', 5),
    rainProb: numEnv('WEATHER_RAIN_PROB', 60),
  }
}

/** Relative day label in the farm timezone, in canonical English. */
export function formatForecastDayLabel(dateStr: string, timeZone: string, now = new Date()): string {
  return forecastDayLabel('en', dateStr, timeZone, now)
}

/**
 * Peak-precip clock label written into the forecast cache, so it stays
 * language-neutral English; viewers see it re-rendered by renderWeatherAlert.
 */
export function formatLocalClockLabel(iso: string, timeZone: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  // 'en-US' deliberately: the viewer-side table in weather-alert-messages must
  // reproduce this exact string for an English reader, and locale tags disagree
  // on whether it is 'PM' or 'pm'.
  const clock = new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone || 'Africa/Lagos',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(d)
  return `around ${clock}`
}

/** Append forecast timing onto the existing playbook headline. */
export function withWeatherTiming(headline: string, alert: WeatherAlert): string {
  const when = alert.whenLabel?.trim()
  if (!when) return headline
  // Keep the familiar playbook line; add when rain/heat/etc. peaks. Localized
  // alerts carry timingDetail; the English fallback reads it off the prose.
  const detail =
    alert.timingDetail?.trim() ||
    (alert.type === 'rain' && alert.message.includes('(')
      ? alert.message.replace(/^Expected\s+/i, '').replace(/\.$/, '')
      : when)
  return `${headline.replace(/\.$/, '')} — ${detail}.`
}

/**
 * Threshold alerts for the next three forecast days, in canonical English.
 *
 * Rendered through the same locale table the viewer's language uses, so English
 * is one locale rather than a second copy of the templates. Serve-time callers
 * pass the result through localizeWeatherAlerts; cache writers must not.
 */
export function buildWeatherAlerts(
  daily: WeatherDay[],
  currentWindKmh: number,
  timeZone = 'Africa/Lagos',
  now = new Date(),
): WeatherAlert[] {
  const t = weatherThresholds()
  const alerts: WeatherAlert[] = []
  const today = daily[0]
  const horizon = daily.slice(0, 3)

  const english = (
    type: WeatherAlertType,
    severity: WeatherAlert['severity'],
    params: WeatherAlertLocaleParams,
    date?: string,
  ) => renderWeatherAlert('en', { type, severity, title: '', message: '', date, params }, now)

  const rainy = horizon.find(
    (d) => d.precipMm >= t.rainMm || (d.precipProb != null && d.precipProb >= t.rainProb),
  )
  if (rainy) {
    const peakLabel = rainy.peakPrecipLocal?.trim() || null
    alerts.push(
      english(
        'rain',
        rainy.precipMm >= t.rainMm * 2 ? 'high' : 'medium',
        {
          type: 'rain',
          timeZone,
          date: rainy.date,
          precipMm: rainy.precipMm,
          precipProb: rainy.precipProb,
          peakClock: parseClockLabel(peakLabel),
          peakLabel,
        },
        rainy.date,
      ),
    )
  }

  const hot = horizon.find((d) => d.tempMaxC >= t.heatC)
  if (hot) {
    alerts.push(
      english(
        'heat',
        hot.tempMaxC >= t.heatC + 3 ? 'high' : 'medium',
        { type: 'heat', timeZone, date: hot.date, tempMaxC: hot.tempMaxC },
        hot.date,
      ),
    )
  }

  const windyDay = horizon.find((d) => d.windKmh >= t.windKmh)
  const windPeak = Math.max(currentWindKmh, windyDay?.windKmh ?? 0)
  if (windPeak >= t.windKmh) {
    alerts.push(
      english(
        'wind',
        windPeak >= t.windKmh + 15 ? 'high' : 'medium',
        { type: 'wind', timeZone, date: windyDay?.date ?? null, windKmh: windPeak },
        windyDay?.date,
      ),
    )
  }

  const cold =
    horizon.find((d) => d.tempMinC <= t.coldC) ??
    (today && today.tempMinC <= t.coldC ? today : null)
  if (cold) {
    alerts.push(
      english(
        'cold',
        cold.tempMinC <= t.coldC - 3 ? 'high' : 'medium',
        { type: 'cold', timeZone, date: cold.date, tempMinC: cold.tempMinC },
        cold.date,
      ),
    )
  }

  return alerts
}

export { localizeWeatherAlerts, renderWeatherAlert }
