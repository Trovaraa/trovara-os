import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdviceRequest, FarmWeatherContext } from './advisory-generate.js'

const isLlmConfigured = vi.fn(() => true)
const completeChat = vi.fn(async (_system: string, _user: string) => ({
  text: '{"advice":[]}',
  model: 'gpt-4o-mini',
}))
const checkLlmBudget = vi.fn((_farmId: string) => ({ allowed: true, used: 0, limit: 500 }))
const consumeLlmBudget = vi.fn((_farmId: string) => {})

vi.mock('./llm.js', () => ({
  isLlmConfigured: () => isLlmConfigured(),
  completeChat: (system: string, user: string) => completeChat(system, user),
  parseJsonFromLlm: (raw: string) => JSON.parse(raw),
}))

vi.mock('./llm-budget.js', () => ({
  checkLlmBudget: (farmId: string) => checkLlmBudget(farmId),
  consumeLlmBudget: (farmId: string) => consumeLlmBudget(farmId),
}))

let cacheRows: Array<{ fingerprint: string; happeningNow: string; whatNext: string }> = []
const inserted: Array<Record<string, unknown>> = []

vi.mock('../db/index.js', () => ({
  db: {
    select: () => ({ from: () => ({ where: async () => cacheRows }) }),
    insert: () => ({
      values: (rows: Array<Record<string, unknown>>) => ({
        onConflictDoUpdate: async () => {
          inserted.push(...rows)
        },
      }),
    }),
  },
}))

const { adviceFingerprint, generateFarmAdvice, validateGeneratedAdviceFromLlm } = await import(
  './advisory-generate.js'
)

function cropRequest(over: Partial<Extract<AdviceRequest['subject'], { kind: 'crop' }>> = {}): AdviceRequest {
  return {
    ruleKey: 'plantain.vegetative.mulch',
    reasonCode: 'crop_stage_mulch',
    seedHappeningNow: 'Plantain is in vegetative growth.',
    seedWhatNext: 'Weed between rows and refresh mulch.',
    subject: {
      kind: 'crop',
      cropType: 'plantain',
      stage: 'vegetative',
      dayInStage: 16,
      plotName: 'Block A',
      areaAcres: '2.5',
      ...over,
    },
  }
}

function livestockRequest(dayInCycle = 7): AdviceRequest {
  return {
    ruleKey: 'noiler.day7.gumboro',
    reasonCode: 'poultry_vaccination',
    seedHappeningNow: 'Gumboro vaccination window is due.',
    seedWhatNext: 'Confirm Gumboro vaccine with your vet/agrovet and schedule the dose.',
    subject: {
      kind: 'livestock',
      species: 'noiler',
      batchName: 'Batch 3',
      headCount: 480,
      dayInCycle,
    },
  }
}

const rainyWeather: FarmWeatherContext = {
  condition: 'Moderate rain',
  tempC: 26,
  alerts: [{ type: 'rain', severity: 'high', title: 'Heavy rain expected' }],
}

const hotWeather: FarmWeatherContext = {
  condition: 'Clear sky',
  tempC: 37,
  alerts: [{ type: 'heat', severity: 'high', title: 'Heat stress risk' }],
}

/** Answer like a model that actually read the farm state it was given. */
function echoFarmState(payload: string): string {
  const ids = [...payload.matchAll(/"id":"([^"]+)"/g)].map((m) => m[1])
  const crops = [...payload.matchAll(/"crop":"([^"]+)"/g)].map((m) => m[1])
  const stages = [...payload.matchAll(/"stage":"([^"]+)"/g)].map((m) => m[1])
  const condition = payload.match(/"condition":"([^"]*)"/)?.[1] ?? 'unknown weather'
  return JSON.stringify({
    advice: ids.map((id, i) => ({
      id,
      happeningNow: `Your ${crops[i] ?? 'flock'} in ${stages[i] ?? 'the pen'} sits under ${condition}.`,
      whatNext: `Send the crew to the ${crops[i] ?? 'flock'} while it stays ${condition}.`,
    })),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  isLlmConfigured.mockReturnValue(true)
  checkLlmBudget.mockReturnValue({ allowed: true, used: 0, limit: 500 })
  cacheRows = []
  inserted.length = 0
})

describe('generateFarmAdvice', () => {
  it('writes different advice for two farms with different crops, stages and weather', async () => {
    completeChat.mockImplementation(async (_system, user) => ({
      text: echoFarmState(user),
      model: 'gpt-4o-mini',
    }))

    const plantainFarm = await generateFarmAdvice({
      farmId: 'farm-1',
      farmName: 'Ilaro Plantain',
      farmLocation: 'Ogun',
      weather: rainyWeather,
      requests: [cropRequest()],
    })

    const coconutFarm = await generateFarmAdvice({
      farmId: 'farm-2',
      farmName: 'Badagry Coconut',
      farmLocation: 'Lagos',
      weather: hotWeather,
      requests: [
        {
          ...cropRequest(),
          ruleKey: 'coconut.flowering.inspect',
          subject: {
            kind: 'crop',
            cropType: 'coconut',
            stage: 'flowering',
            dayInStage: 33,
            plotName: 'Shore Row',
          },
        },
      ],
    })

    expect(plantainFarm.source).toBe('ai')
    expect(coconutFarm.source).toBe('ai')
    expect(plantainFarm.texts[0].happeningNow).not.toBe(coconutFarm.texts[0].happeningNow)
    expect(plantainFarm.texts[0].happeningNow).toContain('plantain')
    expect(plantainFarm.texts[0].happeningNow).toContain('Moderate rain')
    expect(coconutFarm.texts[0].happeningNow).toContain('coconut')
    expect(coconutFarm.texts[0].happeningNow).toContain('Clear sky')
    // The seed string is no longer what the farmer reads.
    expect(plantainFarm.texts[0].happeningNow).not.toBe('Plantain is in vegetative growth.')
  })

  it('asks for English only and never takes a viewer locale', async () => {
    completeChat.mockImplementation(async (_system, user) => ({
      text: echoFarmState(user),
      model: 'gpt-4o-mini',
    }))

    const result = await generateFarmAdvice({
      farmId: 'farm-1',
      farmName: 'Ferme du Littoral',
      farmLocation: 'Cotonou',
      weather: rainyWeather,
      requests: [cropRequest({ plotName: 'Parcelle Nord' })],
    })

    const [systemPrompt, userPayload] = completeChat.mock.calls[0]
    expect(systemPrompt).toContain('ENGLISH ONLY')
    expect(userPayload).not.toMatch(/locale/i)
    expect(result.texts[0].happeningNow).toContain('plantain')
  })

  it('sends every due rule in exactly one LLM call', async () => {
    completeChat.mockImplementation(async (_system, user) => ({
      text: echoFarmState(user),
      model: 'gpt-4o-mini',
    }))

    const requests = [
      cropRequest(),
      cropRequest({ cropType: 'coconut', stage: 'vegetative', dayInStage: 95, plotName: 'Block B' }),
      cropRequest({ stage: 'flowering', dayInStage: 11, plotName: 'Block C' }),
      livestockRequest(7),
      livestockRequest(21),
    ]

    const result = await generateFarmAdvice({
      farmId: 'farm-1',
      farmLocation: 'Ogun',
      weather: rainyWeather,
      requests,
    })

    expect(completeChat).toHaveBeenCalledTimes(1)
    expect(consumeLlmBudget).toHaveBeenCalledTimes(1)
    expect(result.texts).toHaveLength(5)
    expect(result.texts.every((t) => t.source === 'ai')).toBe(true)
    expect(inserted).toHaveLength(5)
  })

  it('reuses cached advice for an unchanged fingerprint without calling the LLM', async () => {
    const request = cropRequest()
    cacheRows = [
      {
        fingerprint: adviceFingerprint(request, rainyWeather),
        happeningNow: 'Cached line about the Block A plantain.',
        whatNext: 'Cached action for the Block A plantain.',
      },
    ]

    const result = await generateFarmAdvice({
      farmId: 'farm-1',
      farmLocation: 'Ogun',
      weather: rainyWeather,
      requests: [request],
    })

    expect(completeChat).not.toHaveBeenCalled()
    expect(result.source).toBe('ai')
    expect(result.texts[0].happeningNow).toBe('Cached line about the Block A plantain.')
  })

  it('shares one generation between two plots in the same state', async () => {
    completeChat.mockImplementation(async (_system, user) => ({
      text: echoFarmState(user),
      model: 'gpt-4o-mini',
    }))

    const result = await generateFarmAdvice({
      farmId: 'farm-1',
      weather: rainyWeather,
      requests: [cropRequest({ plotName: 'Block A' }), cropRequest({ plotName: 'Block B' })],
    })

    expect(completeChat).toHaveBeenCalledTimes(1)
    expect(inserted).toHaveLength(1)
    expect(result.texts[0].happeningNow).toBe(result.texts[1].happeningNow)
  })

  it.each([
    ['missing whatNext', { advice: [{ id: 'plantain.vegetative.mulch', happeningNow: 'A real sentence here.' }] }],
    ['wrong types', { advice: [{ id: 42, happeningNow: 12, whatNext: null }] }],
    [
      'over-length happeningNow',
      {
        advice: [
          {
            id: 'plantain.vegetative.mulch',
            happeningNow: 'x'.repeat(400),
            whatNext: 'Weed the rows this week.',
          },
        ],
      },
    ],
    ['not an array', { advice: 'nope' }],
    ['unknown id', { advice: [{ id: 'other.rule', happeningNow: 'A real sentence.', whatNext: 'Do the thing.' }] }],
  ])('falls back to the seed text when the model returns %s', async (_label, payload) => {
    completeChat.mockResolvedValue({ text: JSON.stringify(payload), model: 'gpt-4o-mini' })

    const result = await generateFarmAdvice({
      farmId: 'farm-1',
      weather: rainyWeather,
      requests: [cropRequest()],
    })

    expect(result.source).toBe('playbook')
    expect(result.texts[0]).toEqual({
      happeningNow: 'Plantain is in vegetative growth.',
      whatNext: 'Weed between rows and refresh mulch.',
      source: 'playbook',
      reasonCode: 'crop_stage_mulch',
    })
    expect(inserted).toHaveLength(0)
  })

  it('falls back to the seed text when the LLM is not configured', async () => {
    isLlmConfigured.mockReturnValue(false)

    const result = await generateFarmAdvice({
      farmId: 'farm-1',
      weather: rainyWeather,
      requests: [cropRequest(), livestockRequest()],
    })

    expect(completeChat).not.toHaveBeenCalled()
    expect(result.source).toBe('playbook')
    expect(result.texts.map((t) => t.source)).toEqual(['playbook', 'playbook'])
    expect(result.texts[0].happeningNow).toBe('Plantain is in vegetative growth.')
    expect(result.texts[1].whatNext).toBe(
      'Confirm Gumboro vaccine with your vet/agrovet and schedule the dose.',
    )
  })

  it('falls back to the seed text when the farm budget is spent', async () => {
    checkLlmBudget.mockReturnValue({ allowed: false, used: 500, limit: 500 })

    const result = await generateFarmAdvice({
      farmId: 'farm-1',
      requests: [cropRequest()],
    })

    expect(completeChat).not.toHaveBeenCalled()
    expect(result.source).toBe('playbook')
  })

  it('falls back to the seed text when the LLM call throws', async () => {
    completeChat.mockRejectedValue(new Error('upstream down'))

    const result = await generateFarmAdvice({
      farmId: 'farm-1',
      requests: [cropRequest()],
    })

    expect(result.source).toBe('playbook')
  })

  it('keeps the seed only for the rows that failed validation', async () => {
    completeChat.mockResolvedValue({
      text: JSON.stringify({
        advice: [
          {
            id: 'plantain.vegetative.mulch',
            happeningNow: 'Block A plantain is 16 days into vegetative growth.',
            whatNext: 'Weed Block A by hand and top up mulch before the rain.',
          },
          { id: 'noiler.day7.gumboro', happeningNow: 'too short', whatNext: '' },
        ],
      }),
      model: 'gpt-4o-mini',
    })

    const result = await generateFarmAdvice({
      farmId: 'farm-1',
      requests: [cropRequest(), livestockRequest()],
    })

    expect(result.source).toBe('ai')
    expect(result.texts[0].source).toBe('ai')
    expect(result.texts[1]).toEqual({
      happeningNow: 'Gumboro vaccination window is due.',
      whatNext: 'Confirm Gumboro vaccine with your vet/agrovet and schedule the dose.',
      source: 'playbook',
      reasonCode: 'poultry_vaccination',
    })
    expect(inserted).toHaveLength(1)
  })

  // The read path decides between the translator and the pre-translated
  // fallback table per line, and it needs the reason code to do the lookup.
  // Without it on AdviceText a caller holding a seed line has no way back to the
  // rule it came from.
  it('carries each request reason code onto its text, generated or seed', async () => {
    completeChat.mockResolvedValue({
      text: JSON.stringify({
        advice: [
          {
            id: 'plantain.vegetative.mulch',
            happeningNow: 'Block A plantain is 16 days into vegetative growth.',
            whatNext: 'Weed Block A by hand and top up mulch before the rain.',
          },
        ],
      }),
      model: 'gpt-4o-mini',
    })

    const result = await generateFarmAdvice({
      farmId: 'farm-1',
      requests: [cropRequest(), livestockRequest()],
    })

    expect(result.texts.map((t) => [t.source, t.reasonCode])).toEqual([
      ['ai', 'crop_stage_mulch'],
      ['playbook', 'poultry_vaccination'],
    ])
  })

  it('carries the reason code onto cached text too', async () => {
    const request = livestockRequest()
    cacheRows = [
      {
        fingerprint: adviceFingerprint(request, rainyWeather),
        happeningNow: 'Cached line about Batch 3.',
        whatNext: 'Cached action for Batch 3.',
      },
    ]

    const result = await generateFarmAdvice({
      farmId: 'farm-1',
      weather: rainyWeather,
      requests: [request],
    })

    expect(result.texts[0].source).toBe('ai')
    expect(result.texts[0].reasonCode).toBe('poultry_vaccination')
  })

  it('returns an empty bundle for no requests', async () => {
    const result = await generateFarmAdvice({ farmId: 'farm-1', requests: [] })
    expect(result).toEqual({ source: 'playbook', texts: [] })
    expect(completeChat).not.toHaveBeenCalled()
  })
})

describe('validateGeneratedAdviceFromLlm', () => {
  const allowed = new Set(['rule.a', 'rule.b'])

  it('accepts well-formed rows', () => {
    const result = validateGeneratedAdviceFromLlm(
      {
        advice: [
          { id: 'rule.a', happeningNow: 'Block A is 16 days in.', whatNext: 'Weed it by hand today.' },
        ],
      },
      allowed,
    )
    expect(result?.get('rule.a')).toEqual({
      happeningNow: 'Block A is 16 days in.',
      whatNext: 'Weed it by hand today.',
    })
  })

  it('rejects non-object and non-array payloads', () => {
    expect(validateGeneratedAdviceFromLlm(null, allowed)).toBeNull()
    expect(validateGeneratedAdviceFromLlm('advice', allowed)).toBeNull()
    expect(validateGeneratedAdviceFromLlm({ advice: {} }, allowed)).toBeNull()
  })

  it('drops rows that recommend a pesticide', () => {
    expect(
      validateGeneratedAdviceFromLlm(
        {
          advice: [
            {
              id: 'rule.a',
              happeningNow: 'Weevils are in the plantain stand.',
              whatNext: 'Spray glyphosate across the block this morning.',
            },
          ],
        },
        allowed,
      ),
    ).toBeNull()
  })

  it('keeps the first row when a duplicate id is returned', () => {
    const result = validateGeneratedAdviceFromLlm(
      {
        advice: [
          { id: 'rule.a', happeningNow: 'First sentence here.', whatNext: 'First action here.' },
          { id: 'rule.a', happeningNow: 'Second sentence here.', whatNext: 'Second action here.' },
        ],
      },
      allowed,
    )
    expect(result?.size).toBe(1)
    expect(result?.get('rule.a')?.happeningNow).toBe('First sentence here.')
  })
})

describe('adviceFingerprint', () => {
  it('is stable inside a day bucket and changes across buckets', () => {
    const day16 = adviceFingerprint(cropRequest({ dayInStage: 16 }), rainyWeather)
    const day20 = adviceFingerprint(cropRequest({ dayInStage: 20 }), rainyWeather)
    const day30 = adviceFingerprint(cropRequest({ dayInStage: 30 }), rainyWeather)

    expect(day20).toBe(day16)
    expect(day30).not.toBe(day16)
  })

  it('ignores the plot name but tracks crop, stage and weather', () => {
    const base = cropRequest()
    expect(adviceFingerprint(cropRequest({ plotName: 'Block Z' }), rainyWeather)).toBe(
      adviceFingerprint(base, rainyWeather),
    )
    expect(adviceFingerprint(cropRequest({ cropType: 'coconut' }), rainyWeather)).not.toBe(
      adviceFingerprint(base, rainyWeather),
    )
    expect(adviceFingerprint(cropRequest({ stage: 'flowering' }), rainyWeather)).not.toBe(
      adviceFingerprint(base, rainyWeather),
    )
    expect(adviceFingerprint(base, hotWeather)).not.toBe(adviceFingerprint(base, rainyWeather))
  })

  it('buckets livestock cycles tighter than crop stages', () => {
    expect(adviceFingerprint(livestockRequest(7), rainyWeather)).toBe(
      adviceFingerprint(livestockRequest(8), rainyWeather),
    )
    expect(adviceFingerprint(livestockRequest(7), rainyWeather)).not.toBe(
      adviceFingerprint(livestockRequest(14), rainyWeather),
    )
  })

  it('treats similar conditions as the same weather bucket', () => {
    const base = cropRequest()
    const lightRain: FarmWeatherContext = { ...rainyWeather, condition: 'Light rain showers', tempC: 24 }
    expect(adviceFingerprint(base, lightRain)).toBe(adviceFingerprint(base, rainyWeather))
  })
})
