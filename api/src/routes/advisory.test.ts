import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdvisoryRecommendationRow, AdvisorySubject, InsightTip } from '../lib/advisory-engine.js'
import { renderAdvisoryFallback } from '../lib/advisory-fallback-messages.js'

type Row = Record<string, unknown>

let sessionUser: Row = {
  id: 'user-worker',
  farmId: 'farm-1',
  role: 'field_worker',
  email: 'worker@trovara.farm',
}

/** The French worker reads the page; the English owner must not decide its language. */
const localeByUserId: Record<string, string> = {
  'user-worker': 'fr',
  'user-owner': 'en',
}

/** Observation rows the advisory reads see, and every row written back. */
const observationRows: Row[] = []
const insertedObservations: Row[] = []

vi.mock('drizzle-orm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('drizzle-orm')>()),
  // Marker instead of SQL so the db mock can see which user row is read.
  eq: (column: unknown, value: unknown) => ({ __eq: [column, value] }),
}))

vi.mock('../db/index.js', async () => {
  const { advisoryObservations, farms, users } = await import('../db/schema.js')

  const chain = () => {
    let table: unknown = null
    let userId: string | null = null
    const rows = () => {
      if (table === users) {
        return userId ? [{ preferredLocale: localeByUserId[userId] ?? null }] : []
      }
      if (table === advisoryObservations) return observationRows
      if (table === farms) return [{ id: 'farm-1', location: 'Ibadan' }]
      return []
    }
    const self = {
      from: (source: unknown) => {
        table = source
        return self
      },
      where: (marker: unknown) => {
        const value = (marker as { __eq?: [unknown, unknown] }).__eq?.[1]
        if (typeof value === 'string') userId = value
        return self
      },
      orderBy: () => self,
      limit: async () => rows(),
      then: (resolve: (value: Row[]) => unknown, reject: (err: unknown) => unknown) =>
        Promise.resolve(rows()).then(resolve, reject),
    }
    return self
  }

  return {
    db: {
      select: () => chain(),
      insert: () => ({
        values: (values: Row) => ({
          returning: async () => {
            insertedObservations.push(values)
            return [{ id: 'obs-new', translationAttempts: 0, ...values }]
          },
        }),
      }),
    },
  }
})

vi.mock('../middleware/auth.js', () => ({
  authMiddleware: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set('user', sessionUser)
    await next()
  },
}))

vi.mock('../lib/advisory-engine.js', async () => ({
  // The real predicate: which tips arrive pre-rendered from the fallback table
  // is the contract between the insights builder and this route, and a stub
  // here would let the two drift apart unnoticed.
  isLocalizedFallbackTip: (await import('../lib/advisory-insights.js')).isLocalizedFallbackTip,
  buildInsightTips: vi.fn(),
  listAdvisorySubjects: vi.fn(),
  listRecommendationsForRole: vi.fn(),
  listOpenRecommendations: vi.fn(),
  listCompletedRecommendations: vi.fn(),
  recommendationStats: vi.fn(async () => ({ pending: 1 })),
  runAdvisoryEngine: vi.fn(async () => ({ created: 0 })),
  updateRecommendationStatus: vi.fn(),
}))

type CanonicalArgs = { text: string; farmId: string; sourceLocale?: string | null }
type CanonicalLocale = 'en' | 'fr' | 'yo' | 'pcm'

/** The locale the service would resolve: the hint when set, else detected 'en'. */
function resolvedLocale(hint?: string | null): CanonicalLocale {
  return (hint ?? 'en') as CanonicalLocale
}

vi.mock('../lib/content-locale.js', () => ({
  toViewerLocaleMany: vi.fn(),
  toViewerLocale: vi.fn(),
  // Real behaviour: the default 'en' preference means nobody chose a language,
  // so it is dropped and the language is detected from the text instead.
  authorLocaleHint: (preferred?: string | null) =>
    !preferred || preferred === 'en' ? null : preferred,
  toCanonicalEnglish: vi.fn(async ({ text, sourceLocale }: CanonicalArgs) => ({
    english: text,
    sourceLocale: resolvedLocale(sourceLocale),
    status: 'done' as const,
  })),
}))

vi.mock('../lib/marketplace-search.js', () => ({ resolveMarketplaceProducts: vi.fn(async () => []) }))

const {
  buildInsightTips,
  listAdvisorySubjects,
  listRecommendationsForRole,
  listOpenRecommendations,
} = await import('../lib/advisory-engine.js')
const { toCanonicalEnglish, toViewerLocaleMany } = await import('../lib/content-locale.js')

const mockBuildInsightTips = vi.mocked(buildInsightTips)
const mockSubjects = vi.mocked(listAdvisorySubjects)
const mockRecommendationsForRole = vi.mocked(listRecommendationsForRole)
const mockOpenRecommendations = vi.mocked(listOpenRecommendations)
const mockTranslateMany = vi.mocked(toViewerLocaleMany)
const mockCanonical = vi.mocked(toCanonicalEnglish)

const COMPOST = {
  title: 'Sunshine Organic Compost 50kg',
  url: 'https://market.example/compost',
  source: 'search' as const,
  priceText: '₦18,500',
}

function tip(n: number): InsightTip {
  return {
    id: `insight:cycle-${n}:maize.topdress`,
    sourceType: 'crop_cycle',
    sourceId: `cycle-${n}`,
    ruleKey: `maize.vegetative.topdress.${n}`,
    reasonCode: 'inputs_due',
    happeningNow: `Maize in Block ${n} is ready for top-dressing.`,
    whatNext: `Apply compost around each stand in Block ${n}.`,
    needQuery: 'organic fertilizer compost',
    products: [COMPOST],
    source: 'ai',
    ephemeral: true,
  }
}

/**
 * A tip that fell back to playbook seed prose. `buildInsightTips` has already
 * rendered it from the pre-translated table in the viewer's language, because
 * the translator this route would otherwise use needs the LLM that was missing
 * when the fallback fired.
 */
function seedTip(n: number): InsightTip {
  return {
    ...tip(n),
    id: `insight:cycle-${n}:plantain.mulch`,
    ruleKey: `plantain.vegetative.mulch.${n}`,
    reasonCode: 'crop_stage_mulch',
    happeningNow: `Le paillage retient le mieux l'humidité à ce stade. (Block ${n})`,
    whatNext: 'Paillez autour du pied et dégagez la tige.',
    source: 'playbook',
  }
}

function recommendation(n: number): AdvisoryRecommendationRow {
  return {
    id: `rec-${n}`,
    farmId: 'farm-1',
    ruleKey: `noiler.vaccination.${n}`,
    sourceType: 'livestock_batch',
    sourceId: `batch-${n}`,
    status: 'notified',
    notifyRoles: ['field_worker'],
    payload: {
      happeningNow: `Batch ${n} is due for its Gumboro vaccination.`,
      whatNext: `Give the vaccine in clean drinking water at dawn.`,
      needQuery: 'gumboro vaccine',
      products: [COMPOST],
      reasonCode: 'vaccination_due',
    },
    aiSummary: `Missing this window costs birds later in the cycle.`,
    firedAt: new Date('2026-07-25T06:00:00Z'),
    resolvedAt: null,
    resolvedBy: null,
    createdAt: new Date('2026-07-25T06:00:00Z'),
    updatedAt: new Date('2026-07-25T06:00:00Z'),
  }
}

const subject: AdvisorySubject = {
  kind: 'crop',
  id: 'cycle-1',
  label: 'Maize · Block A',
  cropType: 'maize',
  plotName: 'Block A',
  stage: 'vegetative',
  plantedAt: '2026-06-01T00:00:00.000Z',
  stageEnteredAt: '2026-07-01T00:00:00.000Z',
  dayInStage: 24,
  totalStageDays: null,
  daysUntilNextHint: 3,
  nextHint: 'Top-dress with compost and weed between the rows.',
}

/**
 * A logged observation. `tiles` and `sourceId` are identifiers the advisory
 * engine matches exactly; `note` is the only prose on the row.
 */
function observation(n: number, note: string | null): Row {
  return {
    id: `obs-${n}`,
    farmId: 'farm-1',
    loggedAt: new Date('2026-07-20T06:00:00Z'),
    sourceType: 'crop_cycle',
    sourceId: 'cycle-1',
    tiles: ['yellowing', 'pests_spotted'],
    note,
    sourceLocale: 'fr',
    translationStatus: 'done',
    translationAttempts: 0,
    createdBy: 'user-worker',
    createdAt: new Date('2026-07-20T06:00:00Z'),
  }
}

/** Stand-in translator: prefixes so a translated string is unmistakable. */
function frenchify() {
  mockTranslateMany.mockImplementation(async ({ texts }) => texts.map((t) => `[fr] ${t}`))
}

async function get(path: string) {
  const { advisoryRoutes } = await import('./advisory.js')
  const app = new Hono()
  app.route('/advisory', advisoryRoutes)
  return app.request(path)
}

async function post(path: string, body: unknown) {
  const { advisoryRoutes } = await import('./advisory.js')
  const app = new Hono()
  app.route('/advisory', advisoryRoutes)
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function translatedTexts(): string[] {
  return mockTranslateMany.mock.calls[0]?.[0].texts ?? []
}

beforeEach(() => {
  vi.clearAllMocks()
  sessionUser = {
    id: 'user-worker',
    farmId: 'farm-1',
    role: 'field_worker',
    email: 'worker@trovara.farm',
  }
  observationRows.length = 0
  insertedObservations.length = 0
  mockSubjects.mockResolvedValue([subject])
  mockRecommendationsForRole.mockResolvedValue([recommendation(1)])
  mockOpenRecommendations.mockResolvedValue([recommendation(1)])
  mockBuildInsightTips.mockResolvedValue([tip(1), tip(2)])
  mockCanonical.mockImplementation(async ({ text, sourceLocale }: CanonicalArgs) => ({
    english: text,
    sourceLocale: resolvedLocale(sourceLocale),
    status: 'done' as const,
  }))
  frenchify()
})

describe('GET /advisory/insights/:key', () => {
  it('renders tip prose in the French viewer language', async () => {
    const res = await get('/advisory/insights/inputs')
    expect(res.status).toBe(200)

    const body = (await res.json()) as { tips: InsightTip[] }
    expect(body.tips[0].happeningNow).toBe('[fr] Maize in Block 1 is ready for top-dressing.')
    expect(body.tips[0].whatNext).toBe('[fr] Apply compost around each stand in Block 1.')
    expect(body.tips[1].happeningNow).toBe('[fr] Maize in Block 2 is ready for top-dressing.')
  })

  it('asks the engine for the viewer locale, not the farm owner locale', async () => {
    await get('/advisory/insights/vaccination')
    expect(mockBuildInsightTips).toHaveBeenCalledWith('farm-1', 'vaccination', 'fr')

    // The English owner reading the same farm gets the owner's own locale, not 'fr'.
    sessionUser = { id: 'user-owner', farmId: 'farm-1', role: 'owner', email: 'o@trovara.farm' }
    await get('/advisory/insights/vaccination')
    expect(mockBuildInsightTips).toHaveBeenLastCalledWith('farm-1', 'vaccination', 'en')
  })

  it('never falls back to the owner lookup by omitting the locale argument', async () => {
    await get('/advisory/insights/inputs')
    expect(mockBuildInsightTips.mock.calls[0]?.[2]).toBeDefined()
  })

  it('sends every tip through a single batched translation call', async () => {
    mockBuildInsightTips.mockResolvedValue([tip(1), tip(2), tip(3), tip(4)])
    await get('/advisory/insights/inputs')

    expect(mockTranslateMany).toHaveBeenCalledTimes(1)
    expect(translatedTexts()).toEqual([
      'Maize in Block 1 is ready for top-dressing.',
      'Apply compost around each stand in Block 1.',
      'Maize in Block 2 is ready for top-dressing.',
      'Apply compost around each stand in Block 2.',
      'Maize in Block 3 is ready for top-dressing.',
      'Apply compost around each stand in Block 3.',
      'Maize in Block 4 is ready for top-dressing.',
      'Apply compost around each stand in Block 4.',
    ])
  })

  it('leaves machine keys and marketplace products untranslated', async () => {
    const res = await get('/advisory/insights/inputs')
    const body = (await res.json()) as { tips: InsightTip[] }

    expect(body.tips[0].ruleKey).toBe('maize.vegetative.topdress.1')
    expect(body.tips[0].reasonCode).toBe('inputs_due')
    expect(body.tips[0].needQuery).toBe('organic fertilizer compost')
    expect(body.tips[0].source).toBe('ai')
    expect(body.tips[0].id).toBe('insight:cycle-1:maize.topdress')
    expect(body.tips[0].products).toEqual([COMPOST])

    const staged = translatedTexts()
    expect(staged).not.toContain(COMPOST.title)
    expect(staged).not.toContain(COMPOST.priceText)
    expect(staged).not.toContain('organic fertilizer compost')
  })

  it('costs an English viewer no translation work at all', async () => {
    sessionUser = { id: 'user-owner', farmId: 'farm-1', role: 'owner', email: 'o@trovara.farm' }
    const res = await get('/advisory/insights/inputs')

    const body = (await res.json()) as { tips: InsightTip[] }
    expect(mockTranslateMany).not.toHaveBeenCalled()
    expect(body.tips[0].happeningNow).toBe('Maize in Block 1 is ready for top-dressing.')
    expect(body.tips[0].whatNext).toBe('Apply compost around each stand in Block 1.')
  })

  it('serves readable English when the translator fails', async () => {
    mockTranslateMany.mockRejectedValue(new Error('llm unavailable'))
    const res = await get('/advisory/insights/inputs')

    expect(res.status).toBe(200)
    const body = (await res.json()) as { tips: InsightTip[] }
    expect(body.tips[0].happeningNow).toBe('Maize in Block 1 is ready for top-dressing.')
    expect(body.tips[0].whatNext).toBe('Apply compost around each stand in Block 1.')
  })

  it('serves an already-localized seed tip untouched, with no translator call', async () => {
    mockBuildInsightTips.mockResolvedValue([seedTip(1)])
    const res = await get('/advisory/insights/inputs')

    const body = (await res.json()) as { tips: InsightTip[] }
    expect(body.tips[0].happeningNow).toBe(
      "Le paillage retient le mieux l'humidité à ce stade. (Block 1)",
    )
    expect(body.tips[0].whatNext).toBe('Paillez autour du pied et dégagez la tige.')
    // The bug: this French line used to be posted to the content translator,
    // which needs the same LLM whose absence produced the fallback.
    expect(mockTranslateMany).not.toHaveBeenCalled()
  })

  // A page can hold a rule served from an earlier generation next to a rule that
  // just fell back, so the choice is per tip and not per response.
  it('localizes a generated tip and a seed tip in the same response, each its own way', async () => {
    mockBuildInsightTips.mockResolvedValue([tip(1), seedTip(2), tip(3)])
    const res = await get('/advisory/insights/inputs')

    const body = (await res.json()) as { tips: InsightTip[] }
    expect(body.tips.map((t) => t.happeningNow)).toEqual([
      '[fr] Maize in Block 1 is ready for top-dressing.',
      "Le paillage retient le mieux l'humidité à ce stade. (Block 2)",
      '[fr] Maize in Block 3 is ready for top-dressing.',
    ])
    expect(body.tips[1].whatNext).toBe('Paillez autour du pied et dégagez la tige.')

    // Only the generated pair is staged, and still in one batched call.
    expect(mockTranslateMany).toHaveBeenCalledTimes(1)
    expect(translatedTexts()).toEqual([
      'Maize in Block 1 is ready for top-dressing.',
      'Apply compost around each stand in Block 1.',
      'Maize in Block 3 is ready for top-dressing.',
      'Apply compost around each stand in Block 3.',
    ])
  })

  // `weather_general` and `weather_unavailable` are seed tips the table has no
  // entry for. The generic line would be less true than the English they carry,
  // so they stay with the translator.
  it('still translates seed prose under a reason code the table does not know', async () => {
    mockBuildInsightTips.mockResolvedValue([
      { ...seedTip(1), reasonCode: 'weather_general', happeningNow: 'Current conditions: Rain, 26°C.' },
    ])
    await get('/advisory/insights/weather')

    expect(translatedTexts()).toContain('Current conditions: Rain, 26°C.')
  })

  it('costs an English viewer no translation work on the fallback path either', async () => {
    sessionUser = { id: 'user-owner', farmId: 'farm-1', role: 'owner', email: 'o@trovara.farm' }
    mockBuildInsightTips.mockResolvedValue([seedTip(1)])
    const res = await get('/advisory/insights/inputs')

    const body = (await res.json()) as { tips: InsightTip[] }
    expect(mockTranslateMany).not.toHaveBeenCalled()
    expect(body.tips[0]).toEqual(JSON.parse(JSON.stringify(seedTip(1))))
  })

  it('keeps English for any string the translator leaves blank', async () => {
    mockTranslateMany.mockImplementation(async ({ texts }) => texts.map(() => ''))
    const res = await get('/advisory/insights/inputs')

    const body = (await res.json()) as { tips: InsightTip[] }
    expect(body.tips[0].happeningNow).toBe('Maize in Block 1 is ready for top-dressing.')
  })
})

describe('GET /advisory/home', () => {
  type HomeBody = {
    subjects: AdvisorySubject[]
    recommendations: Array<{ payload: Record<string, unknown>; aiSummary: string | null }>
  }

  it('localizes stored recommendation prose, aiSummary and subject hints in one batch', async () => {
    const res = await get('/advisory/home')
    expect(res.status).toBe(200)

    const body = (await res.json()) as HomeBody
    expect(body.recommendations[0].payload.happeningNow).toBe(
      '[fr] Batch 1 is due for its Gumboro vaccination.',
    )
    expect(body.recommendations[0].payload.whatNext).toBe(
      '[fr] Give the vaccine in clean drinking water at dawn.',
    )
    expect(body.recommendations[0].aiSummary).toBe(
      '[fr] Missing this window costs birds later in the cycle.',
    )
    expect(body.subjects[0].nextHint).toBe('[fr] Top-dress with compost and weed between the rows.')
    expect(mockTranslateMany).toHaveBeenCalledTimes(1)
  })

  it('keeps recommendation keys, products and subject labels as stored', async () => {
    const res = await get('/advisory/home')
    const body = (await res.json()) as HomeBody

    expect(body.recommendations[0].payload.reasonCode).toBe('vaccination_due')
    expect(body.recommendations[0].payload.needQuery).toBe('gumboro vaccine')
    expect(body.recommendations[0].payload.products).toEqual([COMPOST])
    expect(body.subjects[0].label).toBe('Maize · Block A')
    expect(translatedTexts()).not.toContain('Maize · Block A')
  })

  it('costs an English viewer no translation work at all', async () => {
    sessionUser = { id: 'user-owner', farmId: 'farm-1', role: 'owner', email: 'o@trovara.farm' }
    const res = await get('/advisory/home')

    const body = (await res.json()) as HomeBody
    expect(mockTranslateMany).not.toHaveBeenCalled()
    expect(body.recommendations[0].payload.happeningNow).toBe(
      'Batch 1 is due for its Gumboro vaccination.',
    )
    expect(body.subjects[0].nextHint).toBe('Top-dress with compost and weed between the rows.')
  })

  // This row's 'vaccination_due' is not one of the table's reason codes, so
  // English is the honest answer: there is nothing pre-translated to show.
  it('serves readable English when the translator fails and the reason code is unknown', async () => {
    mockTranslateMany.mockRejectedValue(new Error('llm unavailable'))
    const res = await get('/advisory/home')

    expect(res.status).toBe(200)
    const body = (await res.json()) as HomeBody
    expect(body.recommendations[0].payload.happeningNow).toBe(
      'Batch 1 is due for its Gumboro vaccination.',
    )
    expect(body.recommendations[0].aiSummary).toBe(
      'Missing this window costs birds later in the cycle.',
    )
  })

  // Stored prose is playbook seed text, and translating it needs the same LLM
  // whose absence is being handled — so without the table a French worker reads
  // English here, which is the bug this covers.
  it('falls back to pre-translated prose when the translator is unavailable', async () => {
    const row = recommendation(1)
    mockRecommendationsForRole.mockResolvedValue([
      { ...row, payload: { ...(row.payload as object), reasonCode: 'poultry_vaccination' } },
    ])
    mockTranslateMany.mockRejectedValue(new Error('llm unavailable'))

    const res = await get('/advisory/home')
    expect(res.status).toBe(200)

    const body = (await res.json()) as HomeBody
    const expected = renderAdvisoryFallback('poultry_vaccination', 'fr')
    expect(body.recommendations[0].payload.happeningNow).toBe(expected.happeningNow)
    expect(body.recommendations[0].payload.whatNext).toBe(expected.whatNext)
    expect(body.recommendations[0].payload.happeningNow).not.toMatch(/vaccination\.$/)
  })

  // The summary is genuinely generated prose, so no table entry can stand in for
  // it and replacing it with a generic line would lose real information.
  it('leaves the AI summary in English when it cannot be translated', async () => {
    const row = recommendation(1)
    mockRecommendationsForRole.mockResolvedValue([
      { ...row, payload: { ...(row.payload as object), reasonCode: 'poultry_vaccination' } },
    ])
    mockTranslateMany.mockRejectedValue(new Error('llm unavailable'))

    const res = await get('/advisory/home')
    const body = (await res.json()) as HomeBody
    expect(body.recommendations[0].aiSummary).toBe(
      'Missing this window costs birds later in the cycle.',
    )
  })

  it('uses the translator, not the table, when translation succeeds', async () => {
    const row = recommendation(1)
    mockRecommendationsForRole.mockResolvedValue([
      { ...row, payload: { ...(row.payload as object), reasonCode: 'poultry_vaccination' } },
    ])

    const res = await get('/advisory/home')
    const body = (await res.json()) as HomeBody
    expect(body.recommendations[0].payload.happeningNow).toBe(
      '[fr] Batch 1 is due for its Gumboro vaccination.',
    )
  })

  it('tolerates a legacy row whose payload carries no prose', async () => {
    const legacy = { ...recommendation(9), payload: { note: 'no prose here' }, aiSummary: null }
    mockRecommendationsForRole.mockResolvedValue([legacy])

    const res = await get('/advisory/home')
    expect(res.status).toBe(200)
    const body = (await res.json()) as HomeBody
    expect(body.recommendations[0].payload).toEqual({ note: 'no prose here' })
    expect(translatedTexts()).toEqual(['Top-dress with compost and weed between the rows.'])
  })
})

describe('POST /advisory/observations', () => {
  const FRENCH_NOTE = 'Feuilles jaunes sur le bloc A'
  const ENGLISH_NOTE = 'Yellow leaves in Block A'

  type ObservationBody = { observation: Row }

  function frenchNoteTranslates() {
    mockCanonical.mockResolvedValue({
      english: ENGLISH_NOTE,
      sourceLocale: 'fr',
      status: 'done',
    })
  }

  it('stores a French note as canonical English with the author locale', async () => {
    frenchNoteTranslates()
    const res = await post('/advisory/observations', {
      tiles: ['yellowing'],
      note: FRENCH_NOTE,
      sourceType: 'crop_cycle',
      sourceId: 'cycle-1',
    })

    expect(res.status).toBe(201)
    expect(mockCanonical).toHaveBeenCalledWith({
      text: FRENCH_NOTE,
      farmId: 'farm-1',
      sourceLocale: 'fr',
    })
    expect(insertedObservations[0]).toMatchObject({
      note: ENGLISH_NOTE,
      sourceLocale: 'fr',
      translationStatus: 'done',
    })
  })

  it('echoes the words the author wrote while the row holds the English', async () => {
    frenchNoteTranslates()
    const res = await post('/advisory/observations', { tiles: ['yellowing'], note: FRENCH_NOTE })

    const body = (await res.json()) as ObservationBody
    expect(body.observation.note).toBe(FRENCH_NOTE)
    expect(insertedObservations[0].note).toBe(ENGLISH_NOTE)
  })

  it('stores the original as pending when the translation fails, and still succeeds', async () => {
    mockCanonical.mockResolvedValue({
      english: FRENCH_NOTE,
      sourceLocale: 'fr',
      status: 'pending',
    })
    const res = await post('/advisory/observations', { tiles: ['yellowing'], note: FRENCH_NOTE })

    expect(res.status).toBe(201)
    expect(insertedObservations[0]).toMatchObject({
      note: FRENCH_NOTE,
      sourceLocale: 'fr',
      translationStatus: 'pending',
    })
  })

  it('never fails the write when the translator throws', async () => {
    mockCanonical.mockRejectedValue(new Error('llm unavailable'))
    const res = await post('/advisory/observations', { tiles: ['yellowing'], note: FRENCH_NOTE })

    expect(res.status).toBe(201)
    expect(insertedObservations[0]).toMatchObject({
      note: FRENCH_NOTE,
      sourceLocale: 'fr',
      translationStatus: 'pending',
    })
  })

  it('never sends tiles or the source id to the translator', async () => {
    frenchNoteTranslates()
    await post('/advisory/observations', {
      tiles: ['yellowing', 'pests_spotted'],
      note: FRENCH_NOTE,
      sourceType: 'crop_cycle',
      sourceId: 'cycle-1',
    })

    expect(mockCanonical.mock.calls.map((call) => call[0].text)).toEqual([FRENCH_NOTE])
    expect(insertedObservations[0]).toMatchObject({
      tiles: ['yellowing', 'pests_spotted'],
      sourceId: 'cycle-1',
      sourceType: 'crop_cycle',
    })
  })

  it('lets the text decide the language for an author on the default locale', async () => {
    sessionUser = { id: 'user-owner', farmId: 'farm-1', role: 'owner', email: 'o@trovara.farm' }
    await post('/advisory/observations', { tiles: ['yellowing'], note: 'Yellow leaves' })

    expect(mockCanonical).toHaveBeenCalledWith({
      text: 'Yellow leaves',
      farmId: 'farm-1',
      sourceLocale: null,
    })
  })

  it('writes no note and translates nothing when the worker only taps tiles', async () => {
    const res = await post('/advisory/observations', { tiles: ['yellowing'] })

    expect(res.status).toBe(201)
    expect(mockCanonical).not.toHaveBeenCalled()
    expect(insertedObservations[0]).toMatchObject({
      note: undefined,
      sourceLocale: null,
      translationStatus: 'done',
    })
  })
})

describe('GET /advisory/calendar', () => {
  type CalendarBody = { observations: Row[]; subjects: AdvisorySubject[] }

  beforeEach(() => {
    observationRows.push(
      observation(1, 'Yellow leaves in Block A'),
      observation(2, 'Two hens are lethargic'),
    )
  })

  it('localizes observation notes in the same batch as the rest of the prose', async () => {
    const res = await get('/advisory/calendar')
    expect(res.status).toBe(200)

    const body = (await res.json()) as CalendarBody
    expect(body.observations[0].note).toBe('[fr] Yellow leaves in Block A')
    expect(body.observations[1].note).toBe('[fr] Two hens are lethargic')
    expect(mockTranslateMany).toHaveBeenCalledTimes(1)
    expect(translatedTexts()).toContain('Yellow leaves in Block A')
  })

  it('keeps observation tiles and source ids as stored', async () => {
    const res = await get('/advisory/calendar')
    const body = (await res.json()) as CalendarBody

    expect(body.observations[0].tiles).toEqual(['yellowing', 'pests_spotted'])
    expect(body.observations[0].sourceId).toBe('cycle-1')
    expect(translatedTexts()).not.toContain('yellowing')
    expect(translatedTexts()).not.toContain('cycle-1')
  })

  it('returns byte-identical observations to an English viewer', async () => {
    sessionUser = { id: 'user-owner', farmId: 'farm-1', role: 'owner', email: 'o@trovara.farm' }
    const res = await get('/advisory/calendar')

    const body = (await res.json()) as CalendarBody
    expect(mockTranslateMany).not.toHaveBeenCalled()
    expect(body.observations).toEqual(JSON.parse(JSON.stringify(observationRows)))
  })

  it('leaves a note-less observation untouched', async () => {
    observationRows.length = 0
    observationRows.push(observation(3, null))
    const res = await get('/advisory/calendar')

    const body = (await res.json()) as CalendarBody
    expect(body.observations[0].note).toBeNull()
    // Only the subject hint and the recommendation prose are staged.
    expect(translatedTexts()).toHaveLength(4)
  })

  it('serves readable English when the translator fails', async () => {
    mockTranslateMany.mockRejectedValue(new Error('llm unavailable'))
    const res = await get('/advisory/calendar')

    expect(res.status).toBe(200)
    const body = (await res.json()) as CalendarBody
    expect(body.observations[0].note).toBe('Yellow leaves in Block A')
  })
})

describe('GET /advisory/analysis', () => {
  type AnalysisBody = {
    recentObservations: Row[]
    insights: Array<{ key: string; label: string }>
  }

  beforeEach(() => {
    observationRows.push(observation(1, 'Yellow leaves in Block A'))
  })

  it('localizes recent observation notes for a French viewer', async () => {
    const res = await get('/advisory/analysis')
    expect(res.status).toBe(200)

    const body = (await res.json()) as AnalysisBody
    expect(body.recentObservations[0].note).toBe('[fr] Yellow leaves in Block A')
    expect(mockTranslateMany).toHaveBeenCalledTimes(1)
  })

  it('costs an English viewer no translation work at all', async () => {
    sessionUser = { id: 'user-owner', farmId: 'farm-1', role: 'owner', email: 'o@trovara.farm' }
    const res = await get('/advisory/analysis')

    const body = (await res.json()) as AnalysisBody
    expect(mockTranslateMany).not.toHaveBeenCalled()
    expect(body.recentObservations).toEqual(JSON.parse(JSON.stringify(observationRows)))
  })

  it('sends the four category keys with English labels for the client to resolve', async () => {
    const res = await get('/advisory/analysis')
    const body = (await res.json()) as AnalysisBody

    expect(body.insights).toEqual([
      { key: 'weather', label: 'Weather risks' },
      { key: 'inputs', label: 'Input suggestions' },
      { key: 'vaccination', label: 'Vaccination windows' },
      { key: 'harvest', label: 'Harvest prep' },
    ])
    // Fixed UI chrome: the labels never reach the content translator, in any
    // viewer language.
    expect(translatedTexts()).not.toContain('Weather risks')
    expect(translatedTexts()).not.toContain('Harvest prep')
  })
})

describe('GET /advisory/recommendations', () => {
  it('localizes the open bucket for a French viewer', async () => {
    const res = await get('/advisory/recommendations?bucket=open')
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      recommendations: Array<{ payload: Record<string, unknown> }>
    }
    expect(body.recommendations[0].payload.happeningNow).toBe(
      '[fr] Batch 1 is due for its Gumboro vaccination.',
    )
    expect(mockTranslateMany).toHaveBeenCalledTimes(1)
  })

  it('costs an English viewer no translation work at all', async () => {
    sessionUser = { id: 'user-owner', farmId: 'farm-1', role: 'owner', email: 'o@trovara.farm' }
    const res = await get('/advisory/recommendations?bucket=open')

    expect(res.status).toBe(200)
    expect(mockTranslateMany).not.toHaveBeenCalled()
  })
})
