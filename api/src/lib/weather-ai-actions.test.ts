import { describe, expect, it, vi, beforeEach } from 'vitest'
import { validateWeatherActionsFromLlm } from './weather-ai-actions.js'
import type { WeatherAlert } from './weather-alerts.js'

vi.mock('./llm.js', () => ({
  isLlmConfigured: vi.fn(() => false),
  completeChat: vi.fn(),
  parseJsonFromLlm: vi.fn(),
}))

vi.mock('./llm-budget.js', () => ({
  checkLlmBudget: vi.fn(() => ({ allowed: true, used: 0, limit: 500 })),
  consumeLlmBudget: vi.fn(),
}))

describe('validateWeatherActionsFromLlm', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const rainAlert: WeatherAlert[] = [
    { type: 'rain', severity: 'high', title: 'Rain', message: '10mm' },
  ]

  it('accepts valid actions', () => {
    const result = validateWeatherActionsFromLlm(
      {
        actions: [
          {
            id: 'delay-water',
            priority: 'high',
            title: 'Delay irrigation',
            detail: 'Skip watering while rain is expected.',
            relatedAlert: 'rain',
          },
        ],
      },
      rainAlert,
    )
    expect(result).toHaveLength(1)
    expect(result?.[0].id).toBe('delay-water')
  })

  it('returns null when empty while alerts exist', () => {
    expect(validateWeatherActionsFromLlm({ actions: [] }, rainAlert)).toBeNull()
  })

  it('allows empty actions when no alerts', () => {
    expect(validateWeatherActionsFromLlm({ actions: [] }, [])).toEqual([])
  })

  it('clamps to four actions and drops invalid rows', () => {
    const actions = Array.from({ length: 6 }, (_, i) => ({
      id: `a-${i}`,
      priority: 'medium' as const,
      title: `Tip ${i}`,
      detail: `Detail ${i}`,
      relatedAlert: null as null,
    }))
    actions.push({
      id: 'bad',
      priority: 'medium' as const,
      title: '',
      detail: '',
      relatedAlert: null,
    })
    const result = validateWeatherActionsFromLlm({ actions }, [])
    expect(result).toHaveLength(4)
  })
})