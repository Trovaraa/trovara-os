import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderAdvisoryFallback } from './advisory-fallback-messages.js'
import type { AdviceBundle, AdviceRequest } from './advisory-generate.js'

type Rows = unknown[]

let queue: Rows[] = []
let selectCalls = 0

function queryBuilder(rows: Rows) {
  const builder: Record<string, unknown> = {}
  const self = () => builder
  Object.assign(builder, {
    from: self,
    where: self,
    innerJoin: self,
    leftJoin: self,
    orderBy: self,
    limit: async () => rows,
    then: (resolve: (r: Rows) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
  })
  return builder
}

vi.mock('../db/index.js', () => ({
  db: {
    select: () => {
      selectCalls += 1
      return queryBuilder(queue.shift() ?? [])
    },
  },
}))

const getFarmWeather = vi.fn(async (_farmId: string, _opts?: unknown) => ({
  status: 'ok' as const,
  current: { condition: 'Moderate rain', tempC: 26, feelsLikeC: 27, humidity: 80, windKmh: 9 },
  alerts: [{ type: 'rain', severity: 'high', title: 'Heavy rain', message: '20mm' }],
  locationLabel: 'Ogun',
}))
vi.mock('./weather.js', () => ({
  getFarmWeather: (farmId: string, opts?: unknown) => getFarmWeather(farmId, opts),
}))

const resolveMarketplaceProducts = vi.fn(async (_args: unknown) => [
  { title: 'Mulch', url: null, source: 'search' as const },
])
vi.mock('./marketplace-search.js', () => ({
  resolveMarketplaceProducts: (args: unknown) => resolveMarketplaceProducts(args),
}))

const generateFarmAdvice = vi.fn(
  async (input: { requests: AdviceRequest[] }): Promise<AdviceBundle> => ({
    source: 'playbook',
    texts: input.requests.map((r) => ({
      happeningNow: r.seedHappeningNow,
      whatNext: r.seedWhatNext,
      source: 'playbook',
      reasonCode: r.reasonCode,
    })),
  }),
)
vi.mock('./advisory-generate.js', () => ({
  generateFarmAdvice: (input: unknown) => generateFarmAdvice(input as never),
}))

const { buildInsightTips } = await import('./advisory-insights.js')

const FARM = { id: 'farm-1', name: 'Ilaro Farm', location: 'Ogun' }

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000)
}

/** A batch the way a legacy row looks: species text only, no batch type. */
function livestockBatch(species: string, batchType: string | null = null) {
  return {
    id: 'batch-1',
    name: 'Shed A',
    species,
    batchType,
    headCount: 480,
    acquiredAt: daysAgo(7),
    active: true,
  }
}

function plantainCycle(id: string, plotName: string) {
  return {
    id,
    cropType: 'plantain',
    stage: 'vegetative',
    plantedAt: daysAgo(40),
    stageEnteredAt: daysAgo(16),
    plotName,
    plotAreaAcres: '2.5',
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  selectCalls = 0
  queue = []
})

describe('buildInsightTips viewer locale', () => {
  it('uses the viewer locale and never queries the farm owner', async () => {
    queue = [[FARM], [plantainCycle('cycle-1', 'Block A')], []]

    const tips = await buildInsightTips('farm-1', 'inputs', 'fr')

    expect(tips).toHaveLength(1)
    // farm + crop cycles + their plans + livestock batches — no owner lookup.
    expect(selectCalls).toBe(4)
    expect(resolveMarketplaceProducts).toHaveBeenCalledWith(
      expect.objectContaining({ locale: 'fr', farmId: 'farm-1' }),
    )
  })

  it('falls back to the owner locale when the caller passes nothing', async () => {
    queue = [[FARM], [{ preferredLocale: 'yo' }], [plantainCycle('cycle-1', 'Block A')], []]

    await buildInsightTips('farm-1', 'inputs')

    expect(selectCalls).toBe(5)
    expect(resolveMarketplaceProducts).toHaveBeenCalledWith(
      expect.objectContaining({ locale: 'yo' }),
    )
  })
})

describe('buildInsightTips grounding', () => {
  it('passes live crop, plot and weather state to the generator in one batch', async () => {
    queue = [
      [FARM],
      [plantainCycle('cycle-1', 'Block A'), plantainCycle('cycle-2', 'Block B')],
      [],
      [
        {
          id: 'batch-1',
          name: 'Batch 3',
          species: 'Noiler',
          batchType: 'noiler',
          headCount: 480,
          acquiredAt: daysAgo(7),
          active: true,
        },
      ],
    ]

    await buildInsightTips('farm-1', 'inputs', 'en')

    expect(generateFarmAdvice).toHaveBeenCalledTimes(1)
    const input = generateFarmAdvice.mock.calls[0][0] as {
      farmId: string
      weather: { condition: string; alerts: unknown[] } | null
      requests: AdviceRequest[]
    }
    expect(input.farmId).toBe('farm-1')
    expect(input.weather?.condition).toBe('Moderate rain')
    expect(input.weather?.alerts).toHaveLength(1)
    expect(input.requests.length).toBeGreaterThanOrEqual(3)
    expect(input.requests[0].subject).toEqual({
      kind: 'crop',
      cropType: 'plantain',
      stage: 'vegetative',
      dayInStage: 16,
      plotName: 'Block A',
      areaAcres: '2.5',
    })
    expect(input.requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subject: expect.objectContaining({ kind: 'livestock', headCount: 480, dayInCycle: 7 }),
        }),
      ]),
    )
  })

  it('resolves each marketplace query once per call instead of once per cycle', async () => {
    queue = [
      [FARM],
      [
        plantainCycle('cycle-1', 'Block A'),
        plantainCycle('cycle-2', 'Block B'),
        plantainCycle('cycle-3', 'Block C'),
      ],
      [],
    ]

    const tips = await buildInsightTips('farm-1', 'inputs', 'en')

    expect(tips).toHaveLength(3)
    expect(new Set(tips.map((t) => t.needQuery)).size).toBe(1)
    expect(resolveMarketplaceProducts).toHaveBeenCalledTimes(1)
    expect(tips.every((t) => t.products.length === 1)).toBe(true)
  })

  it('keeps the plot name suffix on seed fallback text', async () => {
    queue = [[FARM], [plantainCycle('cycle-1', 'Block A')], []]

    const [tip] = await buildInsightTips('farm-1', 'inputs', 'en')

    expect(tip.source).toBe('playbook')
    expect(tip.happeningNow).toBe('Plantain is in vegetative growth. (Block A)')
    // An English viewer reads the seed itself, not the deliberately generic
    // table entry: the seed names the crop, and there is nothing to translate.
    expect(tip.whatNext).toBe('Weed between rows and refresh mulch.')
    expect(tip.whatNext).not.toBe(renderAdvisoryFallback('crop_stage_mulch', 'en').whatNext)
  })

  /**
   * The regression these cover: generation and translation both need the LLM,
   * so the seed fallback used to be handed to a translator that was already
   * unavailable, and a French worker read English at exactly the moment the
   * fallback existed to help. The expected strings come from the shared table
   * rather than being spelled out here, so this asserts the wiring and the
   * table's own test asserts the French.
   */
  it('renders seed prose in the viewer language, with no translator', async () => {
    queue = [[FARM], [plantainCycle('cycle-1', 'Block A')], []]

    const [tip] = await buildInsightTips('farm-1', 'inputs', 'fr')
    const french = renderAdvisoryFallback('crop_stage_mulch', 'fr')

    expect(tip.source).toBe('playbook')
    expect(tip.reasonCode).toBe('crop_stage_mulch')
    expect(tip.happeningNow).toBe(`${french.happeningNow} (Block A)`)
    expect(tip.whatNext).toBe(french.whatNext)
    // The English seed is what a French worker used to be shown.
    expect(tip.whatNext).not.toBe('Weed between rows and refresh mulch.')
  })

  it('keeps the plot name on the fallback line, the only farm detail left in it', async () => {
    queue = [[FARM], [plantainCycle('cycle-1', 'Bloc Nord')], []]

    const [tip] = await buildInsightTips('farm-1', 'inputs', 'yo')

    expect(tip.happeningNow).toContain('(Bloc Nord)')
  })

  it('leaves generated prose for the translator, in every viewer language', async () => {
    const generated = {
      happeningNow: 'Block A plantain is 16 days into vegetative growth under rain.',
      whatNext: 'Weed Block A by hand and top up mulch before the next downpour.',
      source: 'ai' as const,
      reasonCode: 'crop_stage_mulch',
    }
    generateFarmAdvice.mockResolvedValueOnce({ source: 'ai', texts: [generated] })
    queue = [[FARM], [plantainCycle('cycle-1', 'Block A')], []]

    const [tip] = await buildInsightTips('farm-1', 'inputs', 'fr')

    // Untouched canonical English: the route stages it for the content
    // translator exactly as it always has.
    expect(tip.source).toBe('ai')
    expect(tip.happeningNow).toBe(generated.happeningNow)
    expect(tip.whatNext).toBe(generated.whatNext)
  })

  it('drops the plot suffix once the prose is generated for the farm', async () => {
    generateFarmAdvice.mockResolvedValueOnce({
      source: 'ai',
      texts: [
        {
          happeningNow: 'Block A plantain is 16 days into vegetative growth under rain.',
          whatNext: 'Weed Block A by hand and top up mulch before the next downpour.',
          source: 'ai',
          reasonCode: 'crop_stage_mulch',
        },
      ],
    })
    queue = [[FARM], [plantainCycle('cycle-1', 'Block A')], []]

    const [tip] = await buildInsightTips('farm-1', 'inputs', 'en')

    expect(tip.source).toBe('ai')
    expect(tip.happeningNow).toBe('Block A plantain is 16 days into vegetative growth under rain.')
  })
})

describe('buildInsightTips noiler recognition', () => {
  // The bug this shares with the livestock routes: the advisory layer matched
  // the species with `includes` and the routes with `===`, so "Noiler chicken"
  // got tips here and a 400 there. Both call the shared predicate now, and
  // routes/livestock.test.ts asserts the other half.
  for (const species of ['Noiler chicken', 'poulet noiler', 'adìẹ noiler', 'Noiler (day old)']) {
    it(`advises a batch whose species reads "${species}"`, async () => {
      queue = [[FARM], [], [livestockBatch(species)]]

      const tips = await buildInsightTips('farm-1', 'vaccination', 'en')

      expect(tips.length).toBeGreaterThan(0)
      expect(tips.every((tip) => tip.sourceType === 'livestock_batch')).toBe(true)
      expect(tips.every((tip) => tip.sourceId === 'batch-1')).toBe(true)
    })
  }

  it('advises a batch classified by the enum whatever the species text says', async () => {
    queue = [[FARM], [], [livestockBatch('500 day-old chicks from Amo', 'noiler')]]

    const tips = await buildInsightTips('farm-1', 'vaccination', 'en')

    expect(tips.length).toBeGreaterThan(0)
  })

  it('leaves goats, fish and layers out of the fallback playbook', async () => {
    for (const species of ['Goats', 'chèvre', 'Catfish', 'poule pondeuse', 'Kuroiler cockerel']) {
      queue = [[FARM], [], [livestockBatch(species)]]
      expect(await buildInsightTips('farm-1', 'vaccination', 'en')).toEqual([])
    }
  })

  it('leaves a batch explicitly typed as something else alone', async () => {
    queue = [[FARM], [], [livestockBatch('noiler', 'layer')]]
    expect(await buildInsightTips('farm-1', 'vaccination', 'en')).toEqual([])
  })
})

/**
 * The offsets in `advisory-playbooks.ts` are a generic fallback, not this farm's
 * agronomy. A batch that has a calendar of its own is advised off that calendar
 * and off nothing else, or the farm reads a correction it made and a hard-coded
 * date contradicting it side by side.
 */
describe("buildInsightTips reads the batch's own schedule", () => {
  function scheduleEntry(over: Partial<Record<string, unknown>> = {}) {
    return {
      batchId: 'batch-1',
      dayOffset: 8,
      name: 'Gumboro booster',
      vaccine: 'Gumboro (IBD)',
      translationStatus: 'done',
      ...over,
    }
  }

  it('fires on the batch day and never on the playbook day', async () => {
    queue = [
      [FARM],
      [],
      [livestockBatch('Noiler chicks')],
      [scheduleEntry(), scheduleEntry({ dayOffset: 45, name: 'Fowl pox', vaccine: 'Fowl pox' })],
    ]

    const tips = await buildInsightTips('farm-1', 'vaccination', 'en')

    expect(tips.map((tip) => tip.ruleKey)).toEqual(['noiler.schedule.d8.gumboro-ibd'])
    expect(tips[0].happeningNow).toBe('Gumboro booster is due on day 8 of this cycle. (Shed A)')
    expect(tips[0].whatNext).toBe(
      'Confirm Gumboro (IBD) with your vet/agrovet and give the scheduled dose.',
    )
    // The framing still comes from the playbook, so the pre-translated fallback
    // and the notify roles keep working for a rule nobody wrote by hand.
    expect(tips[0].reasonCode).toBe('poultry_vaccination')
  })

  it('waits for a batch type before advising a species it cannot place', async () => {
    // A Kuroiler cockerel is poultry, but nothing here can tell it apart from a
    // goat someone wrote a calendar for, and generation refuses it for the same
    // reason. The butler asks the worker which poultry it is; that answer is
    // the batch type the next test carries.
    queue = [[FARM], [], [livestockBatch('Kuroiler cockerel')], [scheduleEntry()]]

    expect(await buildInsightTips('farm-1', 'vaccination', 'en')).toEqual([])
  })

  it('advises that batch off its own schedule once it has a type', async () => {
    queue = [[FARM], [], [livestockBatch('Kuroiler cockerel', 'layer')], [scheduleEntry()]]

    const tips = await buildInsightTips('farm-1', 'vaccination', 'en')

    expect(tips.map((tip) => tip.ruleKey)).toEqual(['noiler.schedule.d8.gumboro-ibd'])
  })

  it('falls back to the playbook for a batch that has no schedule', async () => {
    queue = [[FARM], [], [livestockBatch('Noiler chicks')], []]

    const tips = await buildInsightTips('farm-1', 'vaccination', 'en')

    expect(tips.map((tip) => tip.ruleKey)).toContain('noiler.day7.gumboro')
  })

  /**
   * The trio on a schedule row is the only evidence its words are English. A row
   * that has not settled keeps its day and loses its words, because a
   * recommendation payload is a canonical-English column.
   */
  it("keeps an unsettled row's own language out of the tip", async () => {
    queue = [
      [FARM],
      [],
      [livestockBatch('Noiler chicks')],
      [
        scheduleEntry({
          name: 'Rappel vaccinal contre la maladie de Gumboro',
          vaccine: null,
          translationStatus: 'pending',
        }),
      ],
    ]

    const [tip] = await buildInsightTips('farm-1', 'vaccination', 'en')

    expect(tip.happeningNow).toBe('Gumboro vaccination window is due. (Shed A)')
    expect(JSON.stringify(tip)).not.toContain('Rappel')
  })

  it('reads every batch calendar in one query', async () => {
    queue = [
      [FARM],
      [],
      [
        { ...livestockBatch('Noiler chicks'), id: 'batch-1' },
        { ...livestockBatch('Noiler chicks'), id: 'batch-2' },
        { ...livestockBatch('Noiler chicks'), id: 'batch-3' },
      ],
      [
        scheduleEntry({ batchId: 'batch-1' }),
        scheduleEntry({ batchId: 'batch-2' }),
        scheduleEntry({ batchId: 'batch-3' }),
      ],
    ]

    const tips = await buildInsightTips('farm-1', 'vaccination', 'en')

    expect(tips.map((tip) => tip.sourceId)).toEqual(['batch-1', 'batch-2', 'batch-3'])
    // farm + crop cycles + batches + one schedule read for all three batches.
    // A read per batch would be six.
    expect(selectCalls).toBe(4)
  })
})

/**
 * The offsets in `advisory-playbooks.ts` are a coarse sketch of two crops, not
 * this farm's agronomy. A cycle that has a plan of its own is advised off that
 * plan and off nothing else, or the farm reads a correction it made and a
 * hard-coded date contradicting it side by side.
 */
describe("buildInsightTips reads the cycle's own plan", () => {
  function cropTask(over: Partial<Record<string, unknown>> = {}) {
    return {
      cropCycleId: 'cycle-1',
      stage: 'vegetative',
      offsetDays: 18,
      templateName: 'Row mulching',
      description: 'Refresh mulch between the rows',
      translationStatus: 'done',
      ...over,
    }
  }

  it('fires on the cycle day and never on the playbook day', async () => {
    queue = [
      [FARM],
      [plantainCycle('cycle-1', 'Block A')],
      [cropTask(), cropTask({ offsetDays: 60, templateName: 'Compost top dressing' })],
      [],
    ]

    const tips = await buildInsightTips('farm-1', 'inputs', 'en')

    expect(tips.map((tip) => tip.ruleKey)).toEqual(['crop.plan.vegetative.d18.row-mulching'])
    expect(tips[0].happeningNow).toBe(
      'Row mulching is due on day 18 of the vegetative stage. (Block A)',
    )
    expect(tips[0].whatNext).toBe('Refresh mulch between the rows. Record what was done.')
    // The framing still comes from the playbook, so the pre-translated fallback
    // and the notify roles keep working for a rule nobody wrote by hand.
    expect(tips[0].reasonCode).toBe('crop_stage_mulch')
  })

  it('falls back to the playbook for a cycle that has no plan', async () => {
    queue = [[FARM], [plantainCycle('cycle-1', 'Block A')], [], []]

    const tips = await buildInsightTips('farm-1', 'inputs', 'en')

    expect(tips.map((tip) => tip.ruleKey)).toEqual(['plantain.vegetative.mulch'])
  })

  it('advises a crop the playbook has never heard of, off its own plan', async () => {
    queue = [
      [FARM],
      [{ ...plantainCycle('cycle-1', 'Block A'), cropType: 'cassava' }],
      [cropTask()],
      [],
    ]

    const [tip] = await buildInsightTips('farm-1', 'inputs', 'en')

    expect(tip.ruleKey).toBe('crop.plan.vegetative.d18.row-mulching')
    expect(tip.needQuery).toBe('Row mulching cassava farm')
    // Framing may be borrowed across crops, because the reason codes name none.
    // No borrowed sentence or shopping query may.
    expect(JSON.stringify(tip)).not.toMatch(/plantain|coconut/i)
  })

  /**
   * The trio on a task row is the only evidence its words are English. A row
   * that has not settled keeps its day and loses its words, because a
   * recommendation payload is a canonical-English column.
   */
  it("keeps an unsettled row's own language out of the tip", async () => {
    queue = [
      [FARM],
      [plantainCycle('cycle-1', 'Block A')],
      [
        cropTask({
          templateName: 'Paillage des rangs',
          description: 'Renouveler le paillage entre les rangs',
          translationStatus: 'pending',
        }),
      ],
      [],
    ]

    const [tip] = await buildInsightTips('farm-1', 'inputs', 'en')

    expect(tip.happeningNow).toBe('Plantain is in vegetative growth. (Block A)')
    expect(tip.whatNext).toBe('Weed between rows and refresh mulch.')
    expect(JSON.stringify(tip)).not.toContain('Renouveler')
  })

  it('gives an unsettled row on an unknown crop the generic line, not another crop\'s', async () => {
    queue = [
      [FARM],
      [{ ...plantainCycle('cycle-1', 'Block A'), cropType: 'cassava' }],
      [cropTask({ templateName: 'Paillage des rangs', translationStatus: 'pending' })],
      [],
    ]

    const [tip] = await buildInsightTips('farm-1', 'inputs', 'en')
    const generic = renderAdvisoryFallback('crop_stage_mulch', 'en')

    expect(tip.happeningNow).toBe(`${generic.happeningNow} (Block A)`)
    expect(tip.whatNext).toBe(generic.whatNext)
  })

  it('reads every cycle plan in one query', async () => {
    queue = [
      [FARM],
      [
        plantainCycle('cycle-1', 'Block A'),
        plantainCycle('cycle-2', 'Block B'),
        plantainCycle('cycle-3', 'Block C'),
      ],
      [
        cropTask({ cropCycleId: 'cycle-1' }),
        cropTask({ cropCycleId: 'cycle-2' }),
        cropTask({ cropCycleId: 'cycle-3' }),
      ],
      [],
    ]

    const tips = await buildInsightTips('farm-1', 'inputs', 'en')

    expect(tips.map((tip) => tip.sourceId)).toEqual(['cycle-1', 'cycle-2', 'cycle-3'])
    // farm + crop cycles + one plan read for all three + livestock batches.
    // A read per cycle would be six.
    expect(selectCalls).toBe(4)
  })
})

describe('advisoryRulesForBatch species gate', () => {
  const entry = { dayOffset: 3, name: 'Newcastle / IB', vaccine: 'Lasota', translationStatus: 'done' as const }

  it('advises nothing off a calendar a farm hand-wrote for goats', async () => {
    // Every rule is worded for a flock, and generation refuses non-poultry, so
    // entries on a goat batch can only be the farm's own.
    const { advisoryRulesForBatch } = await import('./advisory-insights.js')

    expect(advisoryRulesForBatch({ species: 'Goats', batchType: null }, [entry])).toEqual([])
    expect(advisoryRulesForBatch({ species: 'Catfish', batchType: null }, [entry])).toEqual([])
  })

  it('advises poultry off its own calendar whatever the species text reads as', async () => {
    const { advisoryRulesForBatch } = await import('./advisory-insights.js')

    const rules = advisoryRulesForBatch({ species: 'Kuroiler cockerel', batchType: 'layer' }, [entry])

    expect(rules.length).toBeGreaterThan(0)
  })

  it('keeps the hard-coded fallback to the one type the playbook covers', async () => {
    const { advisoryRulesForBatch } = await import('./advisory-insights.js')

    expect(advisoryRulesForBatch({ species: 'noiler', batchType: 'noiler' }, []).length).toBeGreaterThan(0)
    expect(advisoryRulesForBatch({ species: 'layer', batchType: 'layer' }, [])).toEqual([])
  })
})
