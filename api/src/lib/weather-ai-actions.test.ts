import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderWeatherTheme } from './advisory-fallback-messages.js'
import {
  localizeWeatherActions,
  resolveWeatherActions,
  validateWeatherActionsFromLlm,
} from './weather-ai-actions.js'
import type { WeatherAlert, WeatherDay } from './weather-alerts.js'

vi.mock('./llm.js', () => ({
  isLlmConfigured: vi.fn(() => false),
  completeChat: vi.fn(),
  parseJsonFromLlm: vi.fn(),
}))

vi.mock('./llm-budget.js', () => ({
  checkLlmBudget: vi.fn(() => ({ allowed: true, used: 0, limit: 500 })),
  consumeLlmBudget: vi.fn(),
}))

vi.mock('./content-locale.js', () => ({
  toViewerLocaleMany: vi.fn(),
  toViewerLocale: vi.fn(),
}))

// loadFarmWeatherSnippet reads crops and livestock: db.select().from().where().limit()
vi.mock('../db/index.js', () => {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => [],
  }
  return { db: { select: () => chain } }
})

const { completeChat, isLlmConfigured, parseJsonFromLlm } = await import('./llm.js')
const { toViewerLocaleMany } = await import('./content-locale.js')

const mockCompleteChat = vi.mocked(completeChat)
const mockIsLlmConfigured = vi.mocked(isLlmConfigured)
const mockParseJson = vi.mocked(parseJsonFromLlm)
const mockTranslateMany = vi.mocked(toViewerLocaleMany)

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

describe('resolveWeatherActions language handling', () => {
  const FARM_ID = 'farm-1'

  const daily: WeatherDay[] = [
    {
      date: '2026-07-26',
      tempMinC: 23,
      tempMaxC: 31,
      precipMm: 14,
      precipProb: 85,
      windKmh: 18,
      condition: 'Rain',
      peakPrecipAt: null,
      peakPrecipLocal: 'around 3:00 PM',
    },
  ]

  const forecast = {
    current: { tempC: 27, feelsLikeC: 30, humidity: 84, windKmh: 12, condition: 'Rain' },
    daily,
  }

  const alerts: WeatherAlert[] = [
    { type: 'rain', severity: 'high', title: 'Heavy rain', message: '14mm expected' },
  ]

  const llmActions = [
    {
      id: 'delay-irrigation',
      priority: 'high',
      title: 'Delay irrigation on the plantain beds',
      detail: 'Skip watering today — 14 mm of rain is expected by mid afternoon.',
      relatedAlert: 'rain',
    },
    {
      id: 'clear-drains',
      priority: 'high',
      title: 'Clear drains around the oil palm nursery',
      detail: 'Open the side channels so seedling bags do not sit in standing water.',
      relatedAlert: 'rain',
    },
    {
      id: 'postpone-spray',
      priority: 'medium',
      title: 'Postpone foliar feeding',
      detail: 'Rain will wash the product off the leaves before it is absorbed.',
      relatedAlert: 'rain',
    },
    {
      id: 'litter-check',
      priority: 'medium',
      title: 'Check poultry litter for damp',
      detail: 'Wet litter after heavy rain drives coccidiosis; top up dry bedding.',
      relatedAlert: 'rain',
    },
  ]

  function useLlm(): void {
    mockIsLlmConfigured.mockReturnValue(true)
    mockCompleteChat.mockResolvedValue({ text: JSON.stringify({ actions: llmActions }) } as never)
    mockParseJson.mockImplementation((text: string) => JSON.parse(text))
  }

  /** Stand-in translator: prefixes so we can trace each output to its English source. */
  function translateWithPrefix(): void {
    mockTranslateMany.mockImplementation(async ({ texts }) => texts.map((t) => `FR::${t}`))
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockIsLlmConfigured.mockReturnValue(false)
    mockTranslateMany.mockImplementation(async ({ texts }) => texts)
  })

  it('generates in English and sends no locale instruction to the model', async () => {
    useLlm()
    translateWithPrefix()

    await resolveWeatherActions(FARM_ID, forecast, alerts, 'fr')

    expect(mockCompleteChat).toHaveBeenCalledTimes(1)
    const systemPrompt = mockCompleteChat.mock.calls[0][0]
    expect(systemPrompt).toContain('Write every title and detail in English')
    expect(systemPrompt).not.toMatch(/French|Yoruba|Nigerian Pidgin/)
    expect(systemPrompt).not.toMatch(/Always reply entirely in/)
  })

  it('uses the identical generation prompt regardless of viewer locale', async () => {
    useLlm()
    translateWithPrefix()

    await resolveWeatherActions(FARM_ID, forecast, alerts, 'en')
    await resolveWeatherActions(FARM_ID, forecast, alerts, 'fr')

    expect(mockCompleteChat.mock.calls[0][0]).toBe(mockCompleteChat.mock.calls[1][0])
    expect(mockCompleteChat.mock.calls[0][1]).toBe(mockCompleteChat.mock.calls[1][1])
  })

  it('gives a French and an English viewer the same underlying advice', async () => {
    useLlm()

    const english = await resolveWeatherActions(FARM_ID, forecast, alerts, 'en')

    translateWithPrefix()
    const french = await resolveWeatherActions(FARM_ID, forecast, alerts, 'fr')

    // Same canonical English generation behind both viewers.
    expect(french.actions).toEqual(english.actions)

    // The French rendering derives from that identical English source, action for action.
    expect(french.localizedActions.map((a) => a.title)).toEqual(
      english.localizedActions.map((a) => `FR::${a.title}`),
    )
    expect(french.localizedActions.map((a) => a.detail)).toEqual(
      english.localizedActions.map((a) => `FR::${a.detail}`),
    )
    expect(french.localizedActions.map((a) => a.id)).toEqual(
      english.localizedActions.map((a) => a.id),
    )
    expect(french.source).toBe('ai')
    expect(french.renderedLocale).toBe('fr')
    expect(english.renderedLocale).toBe('en')
  })

  it('translates every field in one batch call', async () => {
    useLlm()
    translateWithPrefix()

    await resolveWeatherActions(FARM_ID, forecast, alerts, 'fr')

    expect(mockTranslateMany).toHaveBeenCalledTimes(1)
    const { texts, targetLocale, farmId } = mockTranslateMany.mock.calls[0][0]
    expect(texts).toHaveLength(llmActions.length * 2)
    expect(texts).toEqual(llmActions.flatMap((a) => [a.title, a.detail]))
    expect(targetLocale).toBe('fr')
    expect(farmId).toBe(FARM_ID)
  })

  it('does no translation work for an English viewer', async () => {
    useLlm()

    const result = await resolveWeatherActions(FARM_ID, forecast, alerts, 'en')

    expect(mockTranslateMany).not.toHaveBeenCalled()
    expect(result.localizedActions).toBe(result.actions)
    expect(result.localizedActions[0].title).toBe(llmActions[0].title)
  })

  it('falls back to readable English when translation fails', async () => {
    useLlm()
    mockTranslateMany.mockRejectedValue(new Error('translation service down'))

    const result = await resolveWeatherActions(FARM_ID, forecast, alerts, 'fr')

    expect(result.source).toBe('ai')
    expect(result.localizedActions).toEqual(result.actions)
    expect(result.localizedActions.map((a) => a.title)).toEqual(llmActions.map((a) => a.title))
    expect(result.localizedActions.every((a) => a.detail.length > 0)).toBe(true)
  })

  /**
   * The regression: the rules fallback fires when the LLM is off, over budget or
   * unusable — and the translator that used to render its themes needs that same
   * LLM. A French viewer was shown the hardcoded English theme text at exactly
   * the moment the fallback existed to help. The seed ids are the table's keys,
   * so the themes now render with no model at all.
   */
  it('renders the rules fallback for a French viewer from the table, not the translator', async () => {
    mockIsLlmConfigured.mockReturnValue(false)
    translateWithPrefix()

    const result = await resolveWeatherActions(FARM_ID, forecast, alerts, 'fr')

    expect(result.source).toBe('rules')
    expect(mockCompleteChat).not.toHaveBeenCalled()
    expect(result.actions.length).toBeGreaterThan(0)
    expect(mockTranslateMany).not.toHaveBeenCalled()

    for (const [i, action] of result.localizedActions.entries()) {
      const theme = renderWeatherTheme(action.id, 'fr')
      expect(theme).not.toBeNull()
      expect(action.title).toBe(theme?.title)
      expect(action.detail).toBe(theme?.detail)
      // Same theme, same priority and alert — only the words change.
      expect(action.id).toBe(result.actions[i].id)
      expect(action.priority).toBe(result.actions[i].priority)
      expect(action.relatedAlert).toBe(result.actions[i].relatedAlert)
    }
  })

  it('keeps the cache holding canonical English on the fallback path', async () => {
    mockIsLlmConfigured.mockReturnValue(false)

    const english = await resolveWeatherActions(FARM_ID, forecast, alerts, 'en')
    const french = await resolveWeatherActions(FARM_ID, forecast, alerts, 'fr')

    // `actions` is what callers persist; only `localizedActions` follows a reader.
    expect(french.actions).toEqual(english.actions)
    expect(french.actions[0].detail).toMatch(/plantain|oil palm|coconut|poultry/i)
  })

  it('does no lookup and no translation for an English viewer on the fallback path', async () => {
    mockIsLlmConfigured.mockReturnValue(false)

    const result = await resolveWeatherActions(FARM_ID, forecast, alerts, 'en')

    expect(mockTranslateMany).not.toHaveBeenCalled()
    expect(result.localizedActions).toBe(result.actions)
    // The seeds themselves, not the deliberately generic table entries.
    expect(result.localizedActions[0].detail).not.toBe(
      renderWeatherTheme(result.actions[0].id, 'en')?.detail,
    )
  })
})

describe('localizeWeatherActions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('keeps the English text when the translator returns blanks', async () => {
    mockTranslateMany.mockResolvedValue(['', ''])

    const [action] = await localizeWeatherActions(
      'farm-1',
      [{ id: 'a', priority: 'high', title: 'Delay irrigation', detail: 'Rain is coming.' }],
      'fr',
    )

    expect(action.title).toBe('Delay irrigation')
    expect(action.detail).toBe('Rain is coming.')
  })

  // A theme added to weather-actions.ts before its translation lands still gets
  // rendered, just the old way: degraded, not blank and not crashed.
  it('translates a rules action whose theme id the table does not know', async () => {
    mockTranslateMany.mockImplementation(async ({ texts }) => texts.map((t) => `FR::${t}`))

    const [known, unknown] = await localizeWeatherActions(
      'farm-1',
      [
        { id: 'rain-delay-irrigation', priority: 'high', title: 'Delay irrigation', detail: 'Rain is coming.' },
        { id: 'fog-hold-harvest', priority: 'low', title: 'Hold the harvest', detail: 'Visibility is poor.' },
      ],
      'fr',
      'rules',
    )

    expect(known.title).toBe(renderWeatherTheme('rain-delay-irrigation', 'fr')?.title)
    expect(unknown.title).toBe('FR::Hold the harvest')
    expect(mockTranslateMany.mock.calls[0][0].texts).toEqual([
      'Hold the harvest',
      'Visibility is poor.',
    ])
  })

  it('skips the translator for an empty action list', async () => {
    await expect(localizeWeatherActions('farm-1', [], 'fr')).resolves.toEqual([])
    expect(mockTranslateMany).not.toHaveBeenCalled()
  })
})
