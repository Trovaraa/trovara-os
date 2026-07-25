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

  it('includes when the rain is expected', () => {
    const alerts = buildWeatherAlerts(
      [
        baseDay({
          date: '2026-07-26',
          precipMm: 12,
          precipProb: 80,
          peakPrecipLocal: 'around 3:00 PM',
        }),
      ],
      5,
      'Africa/Lagos',
    )
    const rain = alerts.find((a) => a.type === 'rain')
    expect(rain?.whenLabel).toMatch(/around 3:00 PM/)
    expect(rain?.message).toMatch(/around 3:00 PM/)
    expect(rain?.message).toMatch(/12\.0 mm/)
  })

  it('keeps playbook headline and appends timing', async () => {
    const { withWeatherTiming } = await import('./weather-alerts.js')
    const alerts = buildWeatherAlerts(
      [baseDay({ date: '2026-07-26', precipMm: 8, precipProb: 70, peakPrecipLocal: 'around 4:00 PM' })],
      5,
      'Africa/Lagos',
    )
    const rain = alerts.find((a) => a.type === 'rain')!
    const line = withWeatherTiming('Heavy rain risk is in the forecast.', rain)
    expect(line.startsWith('Heavy rain risk is in the forecast')).toBe(true)
    expect(line).toMatch(/around 4:00 PM/)
  })
})
