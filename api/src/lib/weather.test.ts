import { describe, expect, it } from 'vitest'
import { buildWeatherAlerts, type WeatherDay } from './weather-alerts.js'

describe('buildWeatherAlerts', () => {
  const baseDay = (overrides: Partial<WeatherDay>): WeatherDay => ({
    date: '2026-07-17',
    tempMinC: 22,
    tempMaxC: 30,
    precipMm: 0,
    precipProb: 10,
    windKmh: 12,
    condition: 'Clear',
    ...overrides,
  })

  it('deduplicates to one alert per type', () => {
    const daily = [
      baseDay({
        date: '2026-07-17',
        precipMm: 8,
        precipProb: 80,
        tempMaxC: 37,
        windKmh: 45,
        tempMinC: 12,
      }),
      baseDay({
        date: '2026-07-18',
        precipMm: 12,
        precipProb: 90,
        tempMaxC: 38,
        windKmh: 50,
        tempMinC: 11,
      }),
    ]
    const alerts = buildWeatherAlerts(daily, 42)
    const types = alerts.map((a) => a.type).sort()
    expect(types).toEqual(['cold', 'heat', 'rain', 'wind'])
  })

  it('returns no alerts for mild conditions', () => {
    expect(buildWeatherAlerts([baseDay({})], 10)).toEqual([])
  })

  it('flags rain from probability alone', () => {
    const alerts = buildWeatherAlerts([baseDay({ precipMm: 1, precipProb: 70 })], 5)
    expect(alerts.some((a) => a.type === 'rain')).toBe(true)
  })
})
