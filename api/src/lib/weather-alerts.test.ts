import { beforeEach, describe, expect, it, vi } from 'vitest'
import { localizeWeatherAlerts, renderWeatherAlert } from './weather-alert-messages.js'
import {
  buildWeatherAlerts,
  withWeatherTiming,
  type WeatherAlert,
  type WeatherDay,
} from './weather-alerts.js'

/** Lagos is UTC+1, so this is the morning of 2026-07-25 on the farm. */
const NOW = new Date('2026-07-25T09:00:00Z')
const TZ = 'Africa/Lagos'

function severeDay(): WeatherDay {
  return {
    date: '2026-07-26',
    tempMinC: 12,
    tempMaxC: 37,
    precipMm: 12,
    precipProb: 80,
    windKmh: 50,
    condition: 'Rain',
    peakPrecipLocal: 'around 3:00 PM',
    peakPrecipAt: '2026-07-26T15:00:00',
  }
}

describe('buildWeatherAlerts English output', () => {
  beforeEach(() => {
    vi.stubEnv('WEATHER_HEAT_C', '35')
    vi.stubEnv('WEATHER_COLD_C', '15')
    vi.stubEnv('WEATHER_WIND_KMH', '40')
    vi.stubEnv('WEATHER_RAIN_MM', '5')
    vi.stubEnv('WEATHER_RAIN_PROB', '60')
  })

  /**
   * Regression guard: these are the exact strings the hardcoded templates
   * produced before the alerts were routed through the locale table.
   */
  it('matches the pre-localization templates verbatim', () => {
    const alerts = buildWeatherAlerts([severeDay()], 42, TZ, NOW)
    const byType = new Map(alerts.map((a) => [a.type, a]))

    expect(byType.get('rain')).toMatchObject({
      severity: 'high',
      title: 'Heavy rain risk',
      message: 'Expected Tomorrow (Sun, Jul 26) around 3:00 PM (12.0 mm · 80% chance).',
      whenLabel: 'Tomorrow (Sun, Jul 26) around 3:00 PM',
      date: '2026-07-26',
    })
    expect(byType.get('heat')).toMatchObject({
      severity: 'medium',
      title: 'Heat stress risk',
      message: 'Tomorrow (Sun, Jul 26): high around 37°C — shade, water, and livestock cooling.',
      whenLabel: 'Tomorrow (Sun, Jul 26), peak afternoon heat',
      date: '2026-07-26',
    })
    expect(byType.get('wind')).toMatchObject({
      severity: 'medium',
      title: 'Strong wind',
      message:
        'Up to 50 km/h Tomorrow (Sun, Jul 26) — secure covers, irrigation lines, and light structures.',
      whenLabel: 'Tomorrow (Sun, Jul 26)',
      date: '2026-07-26',
    })
    expect(byType.get('cold')).toMatchObject({
      severity: 'high',
      title: 'Low temperature',
      message:
        'Tomorrow (Sun, Jul 26): low around 12°C (early morning) — protect tender crops and young stock.',
      whenLabel: 'Tomorrow (Sun, Jul 26), early morning',
      date: '2026-07-26',
    })
  })

  it('carries the numbers behind each alert as params', () => {
    const alerts = buildWeatherAlerts([severeDay()], 42, TZ, NOW)
    const byType = new Map(alerts.map((a) => [a.type, a.params]))

    expect(byType.get('rain')).toEqual({
      type: 'rain',
      timeZone: TZ,
      date: '2026-07-26',
      precipMm: 12,
      precipProb: 80,
      peakClock: { hour: 15, minute: 0 },
      peakLabel: 'around 3:00 PM',
    })
    expect(byType.get('heat')).toMatchObject({ tempMaxC: 37 })
    expect(byType.get('wind')).toMatchObject({ windKmh: 50 })
    expect(byType.get('cold')).toMatchObject({ tempMinC: 12 })
  })
})

describe('withWeatherTiming', () => {
  beforeEach(() => {
    vi.stubEnv('WEATHER_RAIN_MM', '5')
    vi.stubEnv('WEATHER_RAIN_PROB', '60')
  })

  const rain = () => buildWeatherAlerts([severeDay()], 5, TZ, NOW)[0]

  it('appends English rain timing to the playbook headline', () => {
    expect(withWeatherTiming('Heavy rain risk is in the forecast.', rain())).toBe(
      'Heavy rain risk is in the forecast — Tomorrow (Sun, Jul 26) around 3:00 PM (12.0 mm · 80% chance).',
    )
  })

  it('appends localized timing when the alert was rendered for a viewer', () => {
    const line = withWeatherTiming(
      'Risque de fortes pluies dans les prévisions.',
      renderWeatherAlert('fr', rain(), NOW),
    )
    expect(line).toContain('vers 15:00')
    expect(line).toContain('12.0 mm')
    expect(line).not.toContain('Expected')
  })

  it('still reads timing off English prose for an alert without timingDetail', () => {
    const legacy: WeatherAlert = {
      type: 'rain',
      severity: 'high',
      title: 'Heavy rain risk',
      message: 'Expected Tomorrow (12.0 mm · 80% chance).',
      whenLabel: 'Tomorrow',
    }
    expect(withWeatherTiming('Heavy rain risk is in the forecast.', legacy)).toBe(
      'Heavy rain risk is in the forecast — Tomorrow (12.0 mm · 80% chance).',
    )
  })

  it('leaves the headline alone when there is no when window', () => {
    const alert: WeatherAlert = { type: 'heat', severity: 'medium', title: 'Heat', message: 'Hot.' }
    expect(withWeatherTiming('Heat stress risk is elevated.', alert)).toBe(
      'Heat stress risk is elevated.',
    )
  })
})

// The forecast cache must stay language-neutral: a localized entry would be
// served to the next viewer in the wrong language.
const dbCalls: { selects: unknown[][]; payloads: Record<string, unknown>[] } = {
  selects: [],
  payloads: [],
}

vi.mock('../db/index.js', () => {
  const selectChain = {
    from: () => selectChain,
    where: () => selectChain,
    limit: async () => dbCalls.selects.shift() ?? [],
  }
  const insertChain = {
    values: (row: { payload: Record<string, unknown> }) => {
      dbCalls.payloads.push(row.payload)
      return insertChain
    },
    onConflictDoUpdate: async () => undefined,
  }
  return { db: { select: () => selectChain, insert: () => insertChain } }
})

vi.mock('./weather-ai-actions.js', () => ({
  localizeWeatherActions: async (_farmId: string, actions: unknown[]) => actions,
  resolveWeatherActions: vi.fn(),
}))

describe('getFarmWeather serve-time localization', () => {
  beforeEach(() => {
    dbCalls.selects = []
    dbCalls.payloads = []
    vi.stubEnv('WEATHER_PROVIDER', 'open-meteo')
    vi.stubEnv('WEATHER_HEAT_C', '35')
    vi.stubEnv('WEATHER_COLD_C', '15')
    vi.stubEnv('WEATHER_WIND_KMH', '40')
    vi.stubEnv('WEATHER_RAIN_MM', '5')
    vi.stubEnv('WEATHER_RAIN_PROB', '60')

    // farm row, then an empty weather_cache lookup so a fresh fetch happens.
    dbCalls.selects.push([
      { location: 'Ibadan', latitude: '7.38', longitude: '3.94', timezone: TZ },
    ])
    dbCalls.selects.push([])

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          current: {
            temperature_2m: 30,
            apparent_temperature: 32,
            relative_humidity_2m: 70,
            wind_speed_10m: 42,
            weather_code: 61,
          },
          daily: {
            time: ['2026-07-26'],
            temperature_2m_max: [37],
            temperature_2m_min: [12],
            precipitation_sum: [12],
            precipitation_probability_max: [80],
            wind_speed_10m_max: [50],
            weather_code: [61],
          },
          hourly: {
            time: ['2026-07-26T15:00'],
            precipitation: [8],
            precipitation_probability: [80],
          },
        }),
      })),
    )
  })

  it('serves French alerts while caching a language-neutral payload', async () => {
    const { getFarmWeather } = await import('./weather.js')
    const snapshot = await getFarmWeather('farm-1', { preferredLocale: 'fr' })

    expect(snapshot.status).toBe('ok')
    const rain = snapshot.alerts.find((a) => a.type === 'rain')!
    expect(rain.title).toBe('Risque de fortes pluies')
    expect(rain.message).toContain('12.0 mm')
    expect(rain.whenLabel).toContain('vers 15:00')
    // Enum fields survive: routes/today.ts derives exception types from them.
    expect(snapshot.alerts.map((a) => a.type).sort()).toEqual(['cold', 'heat', 'rain', 'wind'])

    const [payload] = dbCalls.payloads
    expect(payload).toBeDefined()
    expect(payload.alerts).toBeUndefined()
    const daily = payload.daily as WeatherDay[]
    expect(daily[0].peakPrecipLocal).toBe('around 3:00 PM')
    expect(JSON.stringify(payload)).not.toContain('Risque')
    expect(JSON.stringify(payload)).not.toContain('vers 15:00')
  })

  it('serves English by default from the same cached payload', async () => {
    const { getFarmWeather } = await import('./weather.js')
    const snapshot = await getFarmWeather('farm-1', {})

    const rain = snapshot.alerts.find((a) => a.type === 'rain')!
    expect(rain.title).toBe('Heavy rain risk')
    expect(rain.whenLabel).toContain('around 3:00 PM')

    // Same forecast, two languages, one canonical cache entry.
    const cached = dbCalls.payloads[0]
    expect(localizeWeatherAlerts('en', [rain])[0].title).toBe('Heavy rain risk')
    expect(JSON.stringify(cached)).not.toContain('Heavy rain risk')
  })
})
