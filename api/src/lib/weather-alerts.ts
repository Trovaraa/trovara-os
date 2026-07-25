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

function middayUtc(dateStr: string): Date {
  return new Date(`${dateStr}T12:00:00Z`)
}

/** Relative day label in the farm timezone. */
export function formatForecastDayLabel(dateStr: string, timeZone: string, now = new Date()): string {
  const tz = timeZone || 'Africa/Lagos'
  const todayStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000)
  const tomorrowStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(tomorrow)

  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(middayUtc(dateStr))

  if (dateStr === todayStr) return `Today (${weekday})`
  if (dateStr === tomorrowStr) return `Tomorrow (${weekday})`
  return weekday
}

export function formatLocalClockLabel(iso: string, timeZone: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const clock = new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone || 'Africa/Lagos',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(d)
  return `around ${clock}`
}

function rainWhenLabel(day: WeatherDay, timeZone: string): string {
  const dayLabel = formatForecastDayLabel(day.date, timeZone)
  const peak = day.peakPrecipLocal?.trim()
  if (peak) return `${dayLabel} ${peak}`
  // Daily-only forecast: give a sensible daytime window rather than a fake clock.
  return `${dayLabel}, mainly afternoon / evening`
}

/** Append forecast timing onto the existing playbook headline. */
export function withWeatherTiming(headline: string, alert: WeatherAlert): string {
  const when = alert.whenLabel?.trim()
  if (!when) return headline
  // Keep the familiar playbook line; add when rain/heat/etc. peaks.
  const detail =
    alert.type === 'rain' && alert.message.includes('(')
      ? alert.message.replace(/^Expected\s+/i, '').replace(/\.$/, '')
      : when
  return `${headline.replace(/\.$/, '')} — ${detail}.`
}

export function buildWeatherAlerts(
  daily: WeatherDay[],
  currentWindKmh: number,
  timeZone = 'Africa/Lagos',
): WeatherAlert[] {
  const t = weatherThresholds()
  const alerts: WeatherAlert[] = []
  const today = daily[0]
  const horizon = daily.slice(0, 3)

  const rainy = horizon.find(
    (d) => d.precipMm >= t.rainMm || (d.precipProb != null && d.precipProb >= t.rainProb),
  )
  if (rainy) {
    const when = rainWhenLabel(rainy, timeZone)
    const amount = `${rainy.precipMm.toFixed(1)} mm`
    const chance = rainy.precipProb != null ? ` · ${rainy.precipProb}% chance` : ''
    alerts.push({
      type: 'rain',
      severity: rainy.precipMm >= t.rainMm * 2 ? 'high' : 'medium',
      title: 'Heavy rain risk',
      message: `Expected ${when} (${amount}${chance}).`,
      whenLabel: when,
      date: rainy.date,
    })
  }

  const hot = horizon.find((d) => d.tempMaxC >= t.heatC)
  if (hot) {
    const when = formatForecastDayLabel(hot.date, timeZone)
    alerts.push({
      type: 'heat',
      severity: hot.tempMaxC >= t.heatC + 3 ? 'high' : 'medium',
      title: 'Heat stress risk',
      message: `${when}: high around ${hot.tempMaxC.toFixed(0)}°C — shade, water, and livestock cooling.`,
      whenLabel: `${when}, peak afternoon heat`,
      date: hot.date,
    })
  }

  const windyDay = horizon.find((d) => d.windKmh >= t.windKmh)
  const windPeak = Math.max(currentWindKmh, windyDay?.windKmh ?? 0)
  if (windPeak >= t.windKmh) {
    const when = windyDay
      ? formatForecastDayLabel(windyDay.date, timeZone)
      : 'in the current period'
    alerts.push({
      type: 'wind',
      severity: windPeak >= t.windKmh + 15 ? 'high' : 'medium',
      title: 'Strong wind',
      message: `Up to ${windPeak.toFixed(0)} km/h ${when} — secure covers, irrigation lines, and light structures.`,
      whenLabel: when,
      date: windyDay?.date,
    })
  }

  const cold =
    horizon.find((d) => d.tempMinC <= t.coldC) ??
    (today && today.tempMinC <= t.coldC ? today : null)
  if (cold) {
    const when = formatForecastDayLabel(cold.date, timeZone)
    alerts.push({
      type: 'cold',
      severity: cold.tempMinC <= t.coldC - 3 ? 'high' : 'medium',
      title: 'Low temperature',
      message: `${when}: low around ${cold.tempMinC.toFixed(0)}°C (early morning) — protect tender crops and young stock.`,
      whenLabel: `${when}, early morning`,
      date: cold.date,
    })
  }

  return alerts
}
