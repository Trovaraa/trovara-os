export type WeatherAlertType = 'rain' | 'heat' | 'wind' | 'cold'

export type WeatherAlert = {
  type: WeatherAlertType
  severity: 'high' | 'medium'
  title: string
  message: string
}

export type WeatherDay = {
  date: string
  tempMinC: number
  tempMaxC: number
  precipMm: number
  precipProb: number | null
  windKmh: number
  condition: string
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

export function buildWeatherAlerts(daily: WeatherDay[], currentWindKmh: number): WeatherAlert[] {
  const t = weatherThresholds()
  const alerts: WeatherAlert[] = []
  const today = daily[0]
  const horizon = daily.slice(0, 3)

  const rainy = horizon.find(
    (d) => d.precipMm >= t.rainMm || (d.precipProb != null && d.precipProb >= t.rainProb),
  )
  if (rainy) {
    alerts.push({
      type: 'rain',
      severity: rainy.precipMm >= t.rainMm * 2 ? 'high' : 'medium',
      title: 'Rain expected',
      message:
        `${rainy.date}: ${rainy.precipMm.toFixed(1)} mm` +
        (rainy.precipProb != null ? ` (${rainy.precipProb}% chance)` : ''),
    })
  }

  const hot = horizon.find((d) => d.tempMaxC >= t.heatC)
  if (hot) {
    alerts.push({
      type: 'heat',
      severity: hot.tempMaxC >= t.heatC + 3 ? 'high' : 'medium',
      title: 'Heat stress risk',
      message: `${hot.date}: high ${hot.tempMaxC.toFixed(0)}°C — shade, water, and livestock cooling`,
    })
  }

  const windyDay = horizon.find((d) => d.windKmh >= t.windKmh)
  const windPeak = Math.max(currentWindKmh, windyDay?.windKmh ?? 0)
  if (windPeak >= t.windKmh) {
    alerts.push({
      type: 'wind',
      severity: windPeak >= t.windKmh + 15 ? 'high' : 'medium',
      title: 'Strong wind',
      message: `Up to ${windPeak.toFixed(0)} km/h — secure covers, irrigation lines, and light structures`,
    })
  }

  const cold =
    horizon.find((d) => d.tempMinC <= t.coldC) ??
    (today && today.tempMinC <= t.coldC ? today : null)
  if (cold) {
    alerts.push({
      type: 'cold',
      severity: cold.tempMinC <= t.coldC - 3 ? 'high' : 'medium',
      title: 'Low temperature',
      message: `${cold.date}: low ${cold.tempMinC.toFixed(0)}°C — protect tender crops and young stock`,
    })
  }

  return alerts
}
