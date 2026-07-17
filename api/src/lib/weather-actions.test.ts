import { describe, expect, it } from 'vitest'
import { buildWeatherAlerts, type WeatherDay } from './weather-alerts.js'
import { buildWeatherActions } from './weather-actions.js'

describe('buildWeatherActions', () => {
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

  it('returns no actions for mild conditions', () => {
    expect(buildWeatherActions([baseDay({})], 10)).toEqual([])
  })

  it('suggests rain themes when rain is expected', () => {
    const actions = buildWeatherActions([baseDay({ precipMm: 12, precipProb: 80 })], 5)
    const ids = actions.map((a) => a.id).sort()
    expect(ids).toEqual([
      'rain-delay-irrigation',
      'rain-postpone-spray',
      'rain-protect-young',
    ])
    expect(actions.every((a) => a.relatedAlert === 'rain')).toBe(true)
  })

  it('suggests heat themes with tropical farm detail', () => {
    const actions = buildWeatherActions([baseDay({ tempMaxC: 38 })], 5)
    expect(actions.some((a) => a.id === 'heat-shade-livestock')).toBe(true)
    expect(actions.some((a) => a.id === 'heat-irrigate-cool-hours')).toBe(true)
    expect(actions.some((a) => a.id === 'heat-electrolytes')).toBe(true)
    expect(actions.find((a) => a.id === 'heat-irrigate-cool-hours')?.detail).toMatch(/plantain/i)
  })

  it('suggests wind and cold themes', () => {
    const actions = buildWeatherActions(
      [baseDay({ windKmh: 50, tempMinC: 12 })],
      48,
    )
    expect(actions.some((a) => a.id === 'wind-secure-covers')).toBe(true)
    expect(actions.some((a) => a.id === 'wind-delay-foliar')).toBe(true)
    expect(actions.some((a) => a.id === 'cold-protect-tender')).toBe(true)
  })

  it('deduplicates by theme id across horizon days', () => {
    const daily = [
      baseDay({ date: '2026-07-17', precipMm: 8, precipProb: 70 }),
      baseDay({ date: '2026-07-18', precipMm: 20, precipProb: 95 }),
    ]
    const actions = buildWeatherActions(daily, 5)
    const ids = actions.map((a) => a.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.filter((id) => id.startsWith('rain-'))).toHaveLength(3)
  })

  it('maps high-severity alerts to high-priority actions', () => {
    // precipMm >= rainMm * 2 (default 10) → high rain severity
    const actions = buildWeatherActions([baseDay({ precipMm: 12 })], 5)
    expect(actions.every((a) => a.priority === 'high')).toBe(true)
  })

  it('accepts precomputed alerts', () => {
    const daily = [baseDay({ precipMm: 12 })]
    const alerts = buildWeatherAlerts(daily, 5)
    const fromAlerts = buildWeatherActions(daily, 5, alerts)
    const fromDaily = buildWeatherActions(daily, 5)
    expect(fromAlerts).toEqual(fromDaily)
  })

  it('sorts high priority before medium', () => {
    const actions = buildWeatherActions(
      [
        baseDay({
          precipMm: 12,
          tempMaxC: 36,
        }),
      ],
      5,
    )
    // Heavy rain → high; heat at threshold → medium
    const priorities = actions.map((a) => a.priority)
    const firstMedium = priorities.indexOf('medium')
    const lastHigh = priorities.lastIndexOf('high')
    expect(lastHigh).toBeGreaterThanOrEqual(0)
    expect(firstMedium).toBeGreaterThan(lastHigh)
  })
})
