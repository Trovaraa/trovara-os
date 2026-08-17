import { getTableName, type Table } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderAdvisoryFallback } from './advisory-fallback-messages.js'
import { renderWeatherAlert, type WeatherAlert } from './weather-alerts.js'

/**
 * The advisory cron pushes one recommendation to several roles at once, and the
 * farm's staff do not share a language. These tests pin two things: every
 * recipient is served their own `preferred_locale`, and the row written to
 * `advisory_recommendations` stays canonical English while that happens.
 */

const FARM_ID = 'farm-1'
const FARM_NAME = 'Oke Farms Ltd'
const PLOT_NAME = 'Block A'
const BATCH_NAME = 'Kesari 12'
/** Fixed clock: day-in-stage maths and the forecast day labels both read it. */
const NOW = new Date('2026-03-10T09:00:00Z')
const STAGE_START = new Date('2026-02-24T09:00:00Z')

const AI_SUMMARY = 'Mulch now keeps soil moisture in before the dry spell.'

// ---------------------------------------------------------------------------
// db double: resolves each drizzle chain by the table it touches.
// ---------------------------------------------------------------------------

type QueryState = {
  op: 'select' | 'insert' | 'update'
  table: string
  /** Projection passed to `select({...})`, used to tell two users queries apart. */
  fields?: Record<string, unknown>
  values?: Record<string, unknown>
}

type Chain = {
  from(table: unknown): Chain
  innerJoin(...args: unknown[]): Chain
  where(...args: unknown[]): Chain
  orderBy(...args: unknown[]): Chain
  groupBy(...args: unknown[]): Chain
  limit(...args: unknown[]): Chain
  set(...args: unknown[]): Chain
  values(v: Record<string, unknown>): Chain
  returning(...args: unknown[]): Chain
  then(ok: (v: unknown) => unknown, err?: (e: unknown) => unknown): Promise<unknown>
}

let farmRows: Array<Record<string, unknown>> = []
let ownerRows: Array<{ preferredLocale: string }> = []
let cycleRows: Array<Record<string, unknown>> = []
let cropTaskRows: Array<Record<string, unknown>> = []
/** Reads of `crop_cycle_tasks`, to pin the batched fetch. */
let cropTaskSelects = 0
let batchRows: Array<Record<string, unknown>> = []
let scheduleRows: Array<Record<string, unknown>> = []
/** Reads of `livestock_schedule_entries`, to pin the batched fetch. */
let scheduleSelects = 0
let guidelineRows: Array<{ title: string; category: string; body: string }> = []
let existingRows: Array<{ id: string }> = []
/** Every `insert(...).values(...)` payload, in insert order. */
let insertedRows: Array<Record<string, unknown>> = []

/**
 * Staff on the farm, by `preferred_locale`. The real fan-out reads these, so the
 * ids and phone numbers are generated rather than spelled out per test.
 *
 * Role filtering happens in SQL, which this double does not model: every
 * recipient here receives every recommendation regardless of the rule's
 * notifyRoles. These tests are about language, not about who is on the list.
 */
let recipients: Array<{ preferredLocale: string }> = []

function recipientRows(): Array<{ id: string; phone: string; preferredLocale: string }> {
  return recipients.map((r, i) => ({
    id: `u${i + 1}`,
    phone: `+23480000000${i + 1}`,
    preferredLocale: r.preferredLocale,
  }))
}

/** One Telegram link per recipient, so both channels reach the same people. */
function telegramLinkRows(): Array<{ afterValue: { userId: string; chatId: number } }> {
  return recipientRows().map((r, i) => ({ afterValue: { userId: r.id, chatId: 100 + i } }))
}

function tableName(table: unknown): string {
  return getTableName(table as Table)
}

function resolveQuery(state: QueryState): unknown {
  if (state.op === 'insert') {
    const values = state.values ?? {}
    insertedRows.push(values)
    return [{ id: `rec-${insertedRows.length}`, status: 'pending', ...values }]
  }
  if (state.op === 'update') return [{ id: 'rec-1', status: 'notified' }]

  switch (state.table) {
    case 'farms':
      return farmRows
    // Two queries read users: the engine's owner lookup, which asks for the
    // locale alone, and farm-notify's recipient fan-out, which needs a phone.
    case 'users':
      return state.fields && 'phone' in state.fields ? recipientRows() : ownerRows
    case 'farm_events':
      return telegramLinkRows()
    case 'crop_cycles':
      return cycleRows
    case 'crop_cycle_tasks':
      cropTaskSelects += 1
      return cropTaskRows
    case 'livestock_batches':
      return batchRows
    case 'livestock_schedule_entries':
      scheduleSelects += 1
      return scheduleRows
    case 'operation_guidelines':
      return guidelineRows
    case 'advisory_recommendations':
      return existingRows
    default:
      return []
  }
}

vi.mock('../db/index.js', () => {
  function builder(state: QueryState): Chain {
    const chain: Chain = {
      from(table) {
        state.table = tableName(table)
        return chain
      },
      innerJoin: () => chain,
      where: () => chain,
      orderBy: () => chain,
      groupBy: () => chain,
      limit: () => chain,
      set: () => chain,
      values(v) {
        state.values = v
        return chain
      },
      returning: () => chain,
      then: (ok, err) => Promise.resolve(resolveQuery(state)).then(ok, err),
    }
    return chain
  }

  return {
    db: {
      select: (fields?: Record<string, unknown>) =>
        builder({ op: 'select', table: '', fields }),
      insert: (table: unknown) => builder({ op: 'insert', table: tableName(table) }),
      update: (table: unknown) => builder({ op: 'update', table: tableName(table) }),
    },
  }
})

// ---------------------------------------------------------------------------
// Channels. farm-notify itself is NOT mocked: these tests run the real fan-out
// so that "one render per language" and the English fallback are asserted
// against the code that ships, not against a copy of its logic.
// ---------------------------------------------------------------------------

let telegramBodies: string[] = []
let whatsappBodies: string[] = []

vi.mock('./whatsapp-meta.js', () => ({
  isWhatsAppConfigured: () => true,
  sendWhatsAppText: async (to: string, body: string) => {
    whatsappBodies.push(body)
    return { messageId: `wa-${to}` }
  },
}))

vi.mock('./telegram.js', () => ({
  sendTelegramMessage: async (_chatId: number, text: string) => {
    telegramBodies.push(text)
  },
}))

const toViewerLocale = vi.fn(
  async (args: { english: string; targetLocale?: string | null; farmId: string }) =>
    args.targetLocale && args.targetLocale !== 'en'
      ? `[${args.targetLocale}] ${args.english}`
      : args.english,
)

vi.mock('./content-locale.js', () => ({
  toViewerLocale: (args: { english: string; targetLocale?: string | null; farmId: string }) =>
    toViewerLocale(args),
}))

vi.mock('./farm-events.js', () => ({
  recordFarmEvent: async () => undefined,
}))

let llmConfigured = true
const completeChat = vi.fn(async (_system: string, _user: string) => ({
  text: AI_SUMMARY,
  model: 'test-model',
}))
const parseJsonFromLlm = vi.fn((text: string) => {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
})

vi.mock('./llm.js', () => ({
  isLlmConfigured: () => llmConfigured,
  completeChat: (system: string, user: string) => completeChat(system, user),
  parseJsonFromLlm: (text: string) => parseJsonFromLlm(text),
}))

vi.mock('./llm-budget.js', () => ({
  checkLlmBudget: () => ({ allowed: true }),
  consumeLlmBudget: () => undefined,
}))

const PRODUCTS = [
  { title: 'Organic Mulch 50kg', url: 'https://example.com/mulch', source: 'search' as const },
  {
    title: 'Compost Booster',
    url: null,
    source: 'search' as const,
    reason: 'Locally stocked in Lagos',
  },
]

const resolveMarketplaceProducts = vi.fn(async (_args: unknown) => PRODUCTS)

vi.mock('./marketplace-search.js', () => ({
  resolveMarketplaceProducts: (args: unknown) => resolveMarketplaceProducts(args),
}))

let weatherSnapshot: { status: string; alerts: WeatherAlert[]; locationLabel: string | null } = {
  status: 'unavailable',
  alerts: [],
  locationLabel: null,
}

const getFarmWeather = vi.fn(async (_farmId: string) => weatherSnapshot)

vi.mock('./weather.js', () => ({
  getFarmWeather: (farmId: string) => getFarmWeather(farmId),
}))

const { runAdvisoryEngine } = await import('./advisory-engine.js')

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Rain alert as the weather layer builds it: English prose plus its params. */
const RAIN_ALERT: WeatherAlert = renderWeatherAlert(
  'en',
  {
    type: 'rain',
    severity: 'high',
    title: '',
    message: '',
    date: '2026-03-11',
    params: {
      type: 'rain',
      timeZone: 'Africa/Lagos',
      date: '2026-03-11',
      precipMm: 18.4,
      precipProb: 80,
      peakClock: { hour: 15, minute: 0 },
      peakLabel: 'around 3:00 PM',
    },
  },
  NOW,
)

/** The crop rule that fires: plantain.vegetative.mulch, day 14 of the stage. */
const MULCH_SEED = 'Plantain is in vegetative growth.'
const MULCH_NEXT = 'Weed between rows and refresh mulch.'

function useCropCycle(): void {
  cycleRows = [
    {
      id: 'cycle-1',
      cropType: 'plantain',
      stage: 'vegetative',
      plantedAt: STAGE_START,
      stageEnteredAt: STAGE_START,
      plotName: PLOT_NAME,
    },
  ]
}

/** Day 1 of its cycle at NOW, so the day-1 fallback rule is the one that fires. */
function useNoilerBatch(): void {
  batchRows = [
    {
      id: 'batch-1',
      name: BATCH_NAME,
      species: 'Noiler chicken',
      batchType: 'noiler',
      acquiredAt: new Date('2026-03-09T09:00:00Z'),
      active: true,
    },
  ]
}

/** A `crop_cycle_tasks` row of the plantain cycle above, due at NOW. */
function cropTask(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cropCycleId: 'cycle-1',
    stage: 'vegetative',
    offsetDays: 16,
    templateName: 'Row mulching',
    description: 'Refresh mulch between the rows',
    translationStatus: 'done',
    ...over,
  }
}

function scheduleEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    batchId: 'batch-1',
    dayOffset: 2,
    name: 'Gumboro vaccination',
    vaccine: 'Gumboro (IBD)',
    translationStatus: 'done',
    ...over,
  }
}

function payloadOf(index = 0): Record<string, unknown> {
  return insertedRows[index].payload as Record<string, unknown>
}

/** English text handed to the translator, in call order. */
function translatedTexts(): string[] {
  return toViewerLocale.mock.calls.map(([args]) => args.english)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)

  farmRows = [{ id: FARM_ID, name: FARM_NAME, location: 'Lagos' }]
  ownerRows = [{ preferredLocale: 'en' }]
  cycleRows = []
  cropTaskRows = []
  cropTaskSelects = 0
  batchRows = []
  scheduleRows = []
  scheduleSelects = 0
  guidelineRows = []
  existingRows = []
  insertedRows = []
  recipients = []
  telegramBodies = []
  whatsappBodies = []
  llmConfigured = true
  weatherSnapshot = { status: 'unavailable', alerts: [], locationLabel: null }

  completeChat.mockResolvedValue({ text: AI_SUMMARY, model: 'test-model' })
  resolveMarketplaceProducts.mockResolvedValue(PRODUCTS)
  toViewerLocale.mockImplementation(async (args) =>
    args.targetLocale && args.targetLocale !== 'en'
      ? `[${args.targetLocale}] ${args.english}`
      : args.english,
  )
})

afterEach(() => {
  vi.useRealTimers()
})

describe('runAdvisoryEngine per-recipient language', () => {
  it('pushes one recommendation to en/fr/yo recipients in their own language', async () => {
    useCropCycle()
    recipients = [{ preferredLocale: 'en' }, { preferredLocale: 'fr' }, { preferredLocale: 'yo' }]

    const { created } = await runAdvisoryEngine(FARM_ID)

    expect(created).toBe(1)
    expect(whatsappBodies).toHaveLength(3)
    expect(new Set(whatsappBodies).size).toBe(3)

    const [en, fr, yo] = whatsappBodies
    expect(en).toContain('Now: Plantain is in vegetative growth. (Block A)')
    expect(fr).toContain('Maintenant: [fr] Plantain is in vegetative growth. (Block A)')
    expect(yo).toContain('Lọ́wọ́lọ́wọ́: [yo] Plantain is in vegetative growth. (Block A)')

    // Both channels carry the same three messages.
    expect(telegramBodies).toEqual(whatsappBodies)
  })

  it("no longer serves every role the owner's language", async () => {
    useCropCycle()
    ownerRows = [{ preferredLocale: 'fr' }]
    recipients = [{ preferredLocale: 'fr' }, { preferredLocale: 'en' }]

    await runAdvisoryEngine(FARM_ID)

    const [forFrancophone, forAnglophone] = whatsappBodies
    expect(forFrancophone).toContain('Intrants suggérés :')
    expect(forAnglophone).toContain('Suggested inputs:')
    expect(forAnglophone).not.toContain('[fr]')
  })

  it('renders a language once for both channels, however many recipients share it', async () => {
    useCropCycle()
    recipients = [
      { preferredLocale: 'fr' },
      { preferredLocale: 'fr' },
      { preferredLocale: 'fr' },
      { preferredLocale: 'en' },
    ]

    await runAdvisoryEngine(FARM_ID)

    expect(whatsappBodies).toHaveLength(4)
    expect(telegramBodies).toHaveLength(4)
    // Three free-form fragments (now, next, why) translated once for French,
    // shared by both fan-outs. English is never sent to the translator.
    expect(translatedTexts()).toEqual([MULCH_SEED, MULCH_NEXT, AI_SUMMARY])
  })

  it('costs one generation call per recommendation on a mixed-locale farm', async () => {
    useCropCycle()
    recipients = [
      { preferredLocale: 'en' },
      { preferredLocale: 'fr' },
      { preferredLocale: 'yo' },
      { preferredLocale: 'pcm' },
    ]

    await runAdvisoryEngine(FARM_ID)

    expect(completeChat).toHaveBeenCalledTimes(1)
  })

  it('treats an unrecognized or blank preferred_locale as English', async () => {
    useCropCycle()
    recipients = [{ preferredLocale: 'de' }, { preferredLocale: '' }]

    await runAdvisoryEngine(FARM_ID)

    expect(whatsappBodies).toHaveLength(2)
    for (const body of whatsappBodies) {
      expect(body).toContain('Now: Plantain is in vegetative growth. (Block A)')
    }
    // An unsupported language is English, not a translation attempt into it.
    expect(toViewerLocale).not.toHaveBeenCalled()
  })
})

describe('the stored row stays canonical English', () => {
  it('uses a validated AI plan to personalize the action and SerpAPI search intent', async () => {
    useCropCycle()
    guidelineRows = [
      {
        title: 'Rain readiness SOP',
        category: 'operations',
        body: 'Move exposed inputs under the covered store before evening rain.',
      },
    ]
    completeChat.mockResolvedValue({
      text: JSON.stringify({
        actionPlan: 'Move exposed mulch into the covered store, then weed the plantain rows after the rain window.',
        explanation: 'This protects the planned field work while keeping inputs dry and ready for the next safe window.',
        searchIntent: 'waterproof farm tarpaulin for crop inputs Lagos',
        confidence: 'high',
      }),
      model: 'prediction-model',
    })

    await runAdvisoryEngine(FARM_ID)

    expect(payloadOf()).toMatchObject({
      whatNext: 'Move exposed mulch into the covered store, then weed the plantain rows after the rain window.',
      needQuery: 'waterproof farm tarpaulin for crop inputs Lagos',
      prediction: {
        mode: 'ai_plan',
        confidence: 'high',
        model: 'prediction-model',
        searchIntentSource: 'ai',
        guidanceContext: ['Rain readiness SOP'],
      },
    })
    expect((payloadOf().prediction as { evidence: string[] }).evidence).toEqual([
      'Farm signal: Plantain is in vegetative growth. (Block A)',
      'Crop: plantain',
      'Stage: vegetative',
      'Cycle day: 14',
    ])
    expect(insertedRows[0].aiSummary).toContain('protects the planned field work')
    expect(resolveMarketplaceProducts).toHaveBeenCalledWith(
      expect.objectContaining({ needQuery: 'waterproof farm tarpaulin for crop inputs Lagos' }),
    )
    expect(String(completeChat.mock.calls[0]?.[1])).toContain('Rain readiness SOP')
  })

  it('rejects unsafe AI action and search fields while retaining the safe explanation', async () => {
    useCropCycle()
    completeChat.mockResolvedValue({
      text: JSON.stringify({
        actionPlan: 'Apply pesticide before workers enter the plot.',
        explanation: 'The scheduled work should be moved to a safer weather window.',
        searchIntent: 'pesticide supplier Lagos',
        confidence: 'medium',
      }),
      model: 'prediction-model',
    })

    await runAdvisoryEngine(FARM_ID)

    expect(payloadOf().whatNext).toBe('Weed between rows and refresh mulch.')
    expect(payloadOf().needQuery).toBe('mulch organic plantain farm')
    expect(payloadOf()).toMatchObject({
      prediction: {
        mode: 'ai_summary',
        searchIntentSource: 'rule',
      },
    })
    expect(resolveMarketplaceProducts).toHaveBeenCalledWith(
      expect.objectContaining({ needQuery: 'mulch organic plantain farm' }),
    )
  })

  it('persists English payload and aiSummary when the owner is francophone', async () => {
    useCropCycle()
    ownerRows = [{ preferredLocale: 'fr' }]
    recipients = [{ preferredLocale: 'fr' }, { preferredLocale: 'fr' }]

    await runAdvisoryEngine(FARM_ID)

    expect(insertedRows).toHaveLength(1)
    expect(payloadOf()).toMatchObject({
      happeningNow: 'Plantain is in vegetative growth. (Block A)',
      whatNext: 'Weed between rows and refresh mulch.',
      needQuery: 'mulch organic plantain farm',
      reasonCode: 'crop_stage_mulch',
      cropType: 'plantain',
      stage: 'vegetative',
      dayInCycle: 14,
    })
    expect(insertedRows[0].aiSummary).toBe(AI_SUMMARY)

    // The regression: no reader's language may reach a content column. The
    // translator marker below is exactly what a locale leaking into payload
    // construction would look like.
    expect(JSON.stringify(insertedRows[0])).not.toContain('[fr]')
  })

  it('writes the same row for a francophone owner as for an anglophone one', async () => {
    useCropCycle()
    ownerRows = [{ preferredLocale: 'en' }]
    recipients = [{ preferredLocale: 'en' }]
    await runAdvisoryEngine(FARM_ID)
    const english = JSON.stringify(payloadOf())

    insertedRows = []
    ownerRows = [{ preferredLocale: 'fr' }]
    recipients = [{ preferredLocale: 'fr' }, { preferredLocale: 'yo' }]
    await runAdvisoryEngine(FARM_ID)

    expect(JSON.stringify(payloadOf())).toBe(english)
  })

  it('never sends a proper noun or a stored payload field to the translator', async () => {
    useCropCycle()
    recipients = [{ preferredLocale: 'fr' }]

    await runAdvisoryEngine(FARM_ID)

    for (const text of translatedTexts()) {
      expect(text).not.toContain(FARM_NAME)
      expect(text).not.toContain(PLOT_NAME)
      expect(text).not.toContain('https://example.com/mulch')
      expect(text).not.toContain('Organic Mulch 50kg')
    }
  })

  it('leaves the English push byte-identical to the pre-fix message', async () => {
    useCropCycle()
    recipients = [{ preferredLocale: 'en' }]

    await runAdvisoryEngine(FARM_ID)

    expect(whatsappBodies[0]).toBe(
      [
        '🌱 Trovara OS Advisory — Oke Farms Ltd',
        '',
        'Now: Plantain is in vegetative growth. (Block A)',
        'Next: Weed between rows and refresh mulch.',
        `Why: ${AI_SUMMARY}`,
        '',
        'Suggested inputs:',
        '• Organic Mulch 50kg: https://example.com/mulch',
        '• Compost Booster — Locally stocked in Lagos (suggested for your area)',
        '',
        'Confirm sensitive actions with your supervisor. Trovara does not sell these products.',
      ].join('\n'),
    )
  })
})

describe('chrome comes from a locale table', () => {
  it('localizes every label with no LLM call at all', async () => {
    useCropCycle()
    llmConfigured = false
    toViewerLocale.mockRejectedValue(new Error('translation disabled'))
    recipients = [{ preferredLocale: 'fr' }]

    await runAdvisoryEngine(FARM_ID)

    const [body] = whatsappBodies
    expect(body).toContain('🌱 Avis Trovara OS — Oke Farms Ltd')
    expect(body).toContain('Maintenant:')
    expect(body).toContain('Ensuite:')
    expect(body).toContain('Intrants suggérés :')
    expect(body).toContain('(suggéré pour votre région)')
    expect(body).toContain(
      'Confirmez les actions sensibles avec votre superviseur. Trovara ne vend pas ces produits.',
    )
    // The prose comes from the table for the same reason the labels do.
    const seed = renderAdvisoryFallback('crop_stage_mulch', 'fr')
    expect(body).toContain(`Maintenant: ${seed.happeningNow} (${PLOT_NAME})`)
    expect(body).toContain(`Ensuite: ${seed.whatNext}`)
    expect(completeChat).not.toHaveBeenCalled()
  })

  it('renders the pidgin chrome, which is not just the English table', async () => {
    useCropCycle()
    recipients = [{ preferredLocale: 'pcm' }]

    await runAdvisoryEngine(FARM_ID)

    const [body] = whatsappBodies
    expect(body).toContain('🌱 Trovara OS Advice — Oke Farms Ltd')
    expect(body).toContain('Things you fit use:')
    expect(body).toContain('(we suggest am for your area)')
    expect(body).toContain(
      'Confirm any serious action with your supervisor. Trovara no dey sell dis products.',
    )
    // pcm shares the one-word labels with English; only the sentences differ.
    expect(body).toContain('Now: [pcm] Plantain is in vegetative growth. (Block A)')
  })

  it('localizes the empty-products line', async () => {
    useCropCycle()
    resolveMarketplaceProducts.mockResolvedValue([])
    recipients = [{ preferredLocale: 'yo' }, { preferredLocale: 'en' }]

    await runAdvisoryEngine(FARM_ID)

    expect(whatsappBodies[0]).toContain('• (kò sí ìjápọ̀ ọjà lọ́wọ́lọ́wọ́)')
    expect(whatsappBodies[1]).toContain('• (no product links right now)')
  })

  it('keeps the farm, plot and batch names verbatim in every locale', async () => {
    useCropCycle()
    useNoilerBatch()
    recipients = [
      { preferredLocale: 'en' },
      { preferredLocale: 'fr' },
      { preferredLocale: 'yo' },
      { preferredLocale: 'pcm' },
    ]

    const { created } = await runAdvisoryEngine(FARM_ID)

    expect(created).toBe(2)
    const cropBodies = whatsappBodies.slice(0, 4)
    const batchBodies = whatsappBodies.slice(4)
    expect(batchBodies).toHaveLength(4)

    for (const body of cropBodies) {
      expect(body).toContain(FARM_NAME)
      expect(body).toContain(`(${PLOT_NAME})`)
    }
    for (const body of batchBodies) {
      expect(body).toContain(FARM_NAME)
      expect(body).toContain(`(${BATCH_NAME})`)
    }
  })
})

/**
 * The offsets in `advisory-playbooks.ts` are a generic fallback, not veterinary
 * timings for whatever is in the pen. A batch that has a calendar of its own is
 * pushed off that calendar and off nothing else, so a farm that moved a
 * vaccination is never told the hard-coded day as well.
 */
describe("a batch's own schedule drives its recommendations", () => {
  function ruleKeys(): string[] {
    return insertedRows.map((row) => row.ruleKey as string)
  }

  it('fires on the schedule day and never on the playbook day', async () => {
    useNoilerBatch()
    scheduleRows = [
      scheduleEntry(),
      scheduleEntry({ dayOffset: 40, name: 'Fowl pox booster', vaccine: 'Fowl pox' }),
    ]
    recipients = [{ preferredLocale: 'en' }]

    const { created } = await runAdvisoryEngine(FARM_ID)

    expect(created).toBe(1)
    expect(ruleKeys()).toEqual(['noiler.schedule.d2.gumboro-ibd'])
    expect(payloadOf()).toMatchObject({
      happeningNow: `Gumboro vaccination is due on day 2 of this cycle. (${BATCH_NAME})`,
      whatNext: 'Confirm Gumboro (IBD) with your vet/agrovet and give the scheduled dose.',
      dayInCycle: 1,
    })
    // The framing is still the playbook's: the reason code keys the
    // pre-translated fallback and the roles decide who is woken up, and a
    // schedule row carries neither.
    expect(payloadOf().reasonCode).toBe('poultry_vaccination')
    expect(insertedRows[0].notifyRoles).toEqual(['supervisor', 'owner'])
  })

  it('falls back to the playbook for a batch with no schedule of its own', async () => {
    useNoilerBatch()
    recipients = [{ preferredLocale: 'en' }]

    const { created } = await runAdvisoryEngine(FARM_ID)

    expect(created).toBe(1)
    expect(ruleKeys()).toEqual(['noiler.day1.brooding'])
  })

  it('advises a batch off its schedule once it has a type, whatever the species text reads as', async () => {
    useNoilerBatch()
    batchRows = [{ ...batchRows[0], species: 'Kuroiler cockerel', batchType: 'layer' }]
    scheduleRows = [scheduleEntry()]
    recipients = [{ preferredLocale: 'en' }]

    await runAdvisoryEngine(FARM_ID)

    expect(ruleKeys()).toEqual(['noiler.schedule.d2.gumboro-ibd'])
  })

  it('leaves a batch we cannot place alone even when it carries a calendar', async () => {
    // Only a farm can have written that calendar, since generation refuses a
    // batch it cannot place, and a hand-written one is no evidence of poultry.
    useNoilerBatch()
    batchRows = [{ ...batchRows[0], species: 'Kuroiler cockerel', batchType: null }]
    scheduleRows = [scheduleEntry()]
    recipients = [{ preferredLocale: 'en' }]

    const { created } = await runAdvisoryEngine(FARM_ID)

    expect(created).toBe(0)
  })

  it('leaves a batch we cannot place and cannot read a calendar for alone', async () => {
    useNoilerBatch()
    batchRows = [{ ...batchRows[0], species: 'Kuroiler cockerel', batchType: null }]
    recipients = [{ preferredLocale: 'en' }]

    const { created } = await runAdvisoryEngine(FARM_ID)

    expect(created).toBe(0)
  })

  /**
   * The locale trio on a schedule row is the only evidence its words are
   * English. Until it settles, the row contributes its day and nothing else:
   * `advisory_recommendations.payload` is a canonical-English column.
   */
  it("keeps an unsettled row's own language out of the stored payload", async () => {
    useNoilerBatch()
    scheduleRows = [
      scheduleEntry({
        name: 'Rappel vaccinal contre la maladie de Gumboro',
        vaccine: null,
        translationStatus: 'pending',
      }),
    ]
    recipients = [{ preferredLocale: 'en' }]

    await runAdvisoryEngine(FARM_ID)

    expect(ruleKeys()).toEqual(['noiler.schedule.d2.rappel-vaccinal-contre-la-maladi'])
    expect(payloadOf().happeningNow).toBe(`Gumboro vaccination window is due. (${BATCH_NAME})`)
    expect(JSON.stringify(insertedRows[0])).not.toContain('Rappel')
  })

  it('reads every batch calendar in one query, not one per flock', async () => {
    batchRows = ['batch-1', 'batch-2', 'batch-3'].map((id) => ({
      id,
      name: `Shed ${id}`,
      species: 'Noiler chicken',
      batchType: 'noiler',
      acquiredAt: new Date('2026-03-09T09:00:00Z'),
      active: true,
    }))
    scheduleRows = batchRows.map((batch) => scheduleEntry({ batchId: batch.id }))
    recipients = [{ preferredLocale: 'en' }]

    const { created } = await runAdvisoryEngine(FARM_ID)

    expect(created).toBe(3)
    expect(scheduleSelects).toBe(1)
  })
})

/**
 * The offsets in `advisory-playbooks.ts` are a coarse sketch of two crops, not
 * agronomy for whatever is in the ground. A cycle that has a plan of its own is
 * pushed off that plan and off nothing else, so a farm that moved its fertiliser
 * pass is never told the hard-coded day as well.
 */
describe("a cycle's own plan drives its recommendations", () => {
  function ruleKeys(): string[] {
    return insertedRows.map((row) => row.ruleKey as string)
  }

  it('fires on the plan day and never on the playbook day', async () => {
    useCropCycle()
    cropTaskRows = [
      cropTask(),
      cropTask({ offsetDays: 45, templateName: 'Compost top dressing' }),
    ]
    recipients = [{ preferredLocale: 'en' }]

    const { created } = await runAdvisoryEngine(FARM_ID)

    expect(created).toBe(1)
    expect(ruleKeys()).toEqual(['crop.plan.vegetative.d16.row-mulching'])
    expect(payloadOf()).toMatchObject({
      happeningNow: `Row mulching is due on day 16 of the vegetative stage. (${PLOT_NAME})`,
      whatNext: 'Refresh mulch between the rows. Record what was done.',
      dayInCycle: 14,
    })
    // The framing is still the playbook's: the reason code keys the
    // pre-translated fallback and the roles decide who is woken up, and a task
    // row carries neither.
    expect(payloadOf().reasonCode).toBe('crop_stage_mulch')
    expect(insertedRows[0].notifyRoles).toEqual(['field_worker'])
  })

  it('falls back to the playbook for a cycle with no plan of its own', async () => {
    useCropCycle()
    recipients = [{ preferredLocale: 'en' }]

    const { created } = await runAdvisoryEngine(FARM_ID)

    expect(created).toBe(1)
    expect(ruleKeys()).toEqual(['plantain.vegetative.mulch'])
  })

  it('advises a crop the playbook has never heard of, off its own plan', async () => {
    useCropCycle()
    cycleRows = [{ ...cycleRows[0], cropType: 'cassava' }]
    cropTaskRows = [cropTask()]
    recipients = [{ preferredLocale: 'en' }]

    const { created } = await runAdvisoryEngine(FARM_ID)

    expect(created).toBe(1)
    expect(payloadOf().needQuery).toBe('Row mulching cassava farm')
    // Framing is borrowed across crops, because the reason codes name none.
    // Nothing stored may name a crop this farm is not growing.
    expect(JSON.stringify(insertedRows[0])).not.toMatch(/plantain|coconut/i)
  })

  it('leaves a crop with neither a plan nor a playbook alone', async () => {
    useCropCycle()
    cycleRows = [{ ...cycleRows[0], cropType: 'cassava' }]
    recipients = [{ preferredLocale: 'en' }]

    expect((await runAdvisoryEngine(FARM_ID)).created).toBe(0)
  })

  it('holds back a plan entry that belongs to another stage', async () => {
    useCropCycle()
    cropTaskRows = [
      cropTask({ stage: 'harvest_ready', offsetDays: 2, templateName: 'Harvest prep' }),
    ]
    recipients = [{ preferredLocale: 'en' }]

    const { created } = await runAdvisoryEngine(FARM_ID)

    // Offsets restart at every stage, so a harvest-ready day 2 is not day 2 of
    // the vegetative stage. The playbook does not get to fill the gap either:
    // the farm may have emptied this stage on purpose.
    expect(created).toBe(0)
  })

  /**
   * The locale trio on a task row is the only evidence its words are English.
   * Until it settles, the row contributes its day and nothing else:
   * `advisory_recommendations.payload` is a canonical-English column.
   */
  it("keeps an unsettled row's own language out of the stored payload", async () => {
    useCropCycle()
    cropTaskRows = [
      cropTask({
        templateName: 'Paillage des rangs',
        description: 'Renouveler le paillage entre les rangs',
        translationStatus: 'pending',
      }),
    ]
    recipients = [{ preferredLocale: 'en' }]

    await runAdvisoryEngine(FARM_ID)

    expect(ruleKeys()).toEqual(['crop.plan.vegetative.d16.paillage-des-rangs'])
    expect(payloadOf().happeningNow).toBe(`${MULCH_SEED} (${PLOT_NAME})`)
    expect(payloadOf().whatNext).toBe(MULCH_NEXT)
    expect(JSON.stringify(insertedRows[0])).not.toContain('Renouveler')
  })

  it('reads every cycle plan in one query, not one per cycle', async () => {
    cycleRows = ['cycle-1', 'cycle-2', 'cycle-3'].map((id) => ({
      id,
      cropType: 'plantain',
      stage: 'vegetative',
      plantedAt: STAGE_START,
      stageEnteredAt: STAGE_START,
      plotName: `Block ${id}`,
    }))
    cropTaskRows = cycleRows.map((cycle) => cropTask({ cropCycleId: cycle.id }))
    recipients = [{ preferredLocale: 'en' }]

    const { created } = await runAdvisoryEngine(FARM_ID)

    expect(created).toBe(3)
    expect(cropTaskSelects).toBe(1)
  })
})

/**
 * Product selection is region choice, not translation. It runs before the insert
 * because the chosen products are part of the stored row, so it cannot depend on
 * a reader — the cron has no single viewer. The owner's locale stands in for the
 * farm's market region, and the titles it returns are proper nouns shown
 * verbatim to every reader, so no reader's language reaches a content column.
 */
describe('marketplace region follows the owner, not the reader', () => {
  it("resolves products once per recommendation, from the owner's locale", async () => {
    useCropCycle()
    ownerRows = [{ preferredLocale: 'fr' }]
    recipients = [{ preferredLocale: 'en' }, { preferredLocale: 'yo' }]

    await runAdvisoryEngine(FARM_ID)

    expect(resolveMarketplaceProducts).toHaveBeenCalledTimes(1)
    expect(resolveMarketplaceProducts).toHaveBeenCalledWith({
      farmLocation: 'Lagos',
      needQuery: 'mulch organic plantain farm',
      locale: 'fr',
      farmId: FARM_ID,
    })
  })

  it('shows every reader the same product titles and links', async () => {
    useCropCycle()
    ownerRows = [{ preferredLocale: 'fr' }]
    recipients = [{ preferredLocale: 'en' }, { preferredLocale: 'fr' }, { preferredLocale: 'yo' }]

    await runAdvisoryEngine(FARM_ID)

    for (const body of whatsappBodies) {
      expect(body).toContain('• Organic Mulch 50kg: https://example.com/mulch')
      expect(body).toContain('Compost Booster — Locally stocked in Lagos')
    }
  })
})

describe('weather timing renders from the weather locale table', () => {
  beforeEach(() => {
    weatherSnapshot = { status: 'ok', alerts: [RAIN_ALERT], locationLabel: 'Lagos' }
  })

  it('stores the English timing the forecast produced', async () => {
    recipients = [{ preferredLocale: 'en' }]

    await runAdvisoryEngine(FARM_ID)

    expect(payloadOf().happeningNow).toBe(
      'Heavy rain risk is in the forecast — Tomorrow (Wed, Mar 11) around 3:00 PM (18.4 mm · 80% chance).',
    )
    expect(whatsappBodies[0]).toContain(`Now: ${payloadOf().happeningNow as string}`)
  })

  it('renders the date, clock and amount per locale instead of translating them', async () => {
    recipients = [{ preferredLocale: 'fr' }]

    await runAdvisoryEngine(FARM_ID)

    const [body] = whatsappBodies
    expect(body).toContain('Demain (mer. 11 mars) vers 15:00')
    expect(body).toContain('18.4 mm · 80% de probabilité')
    expect(body).not.toContain('around 3:00 PM')
    expect(body).not.toContain('Tomorrow')

    // Only the playbook headline is free-form; the timing never reaches a
    // translator that could move the rain window.
    for (const text of translatedTexts()) {
      expect(text).not.toContain('3:00 PM')
      expect(text).not.toContain('Tomorrow')
      expect(text).not.toContain('18.4 mm')
    }
  })
})

describe('a translation failure never drops a push', () => {
  /**
   * When translation is unavailable, known reason codes fall back to the
   * pre-translated playbook text rather than English. Generated explanation
   * text has no table entry, so it remains canonical English.
   */
  it('still sends, with the seed lines rendered from the table', async () => {
    useCropCycle()
    toViewerLocale.mockRejectedValue(new Error('llm down'))
    recipients = [{ preferredLocale: 'fr' }, { preferredLocale: 'yo' }, { preferredLocale: 'en' }]

    await runAdvisoryEngine(FARM_ID)

    expect(whatsappBodies).toHaveLength(3)
    expect(telegramBodies).toHaveLength(3)

    const [fr, yo, en] = whatsappBodies
    for (const [body, locale] of [[fr, 'fr'], [yo, 'yo']] as const) {
      const seed = renderAdvisoryFallback('crop_stage_mulch', locale)
      expect(body).toContain(`${seed.happeningNow} (${PLOT_NAME})`)
      expect(body).toContain(seed.whatNext)
      // The regression: this is what the francophone worker used to read.
      expect(body).not.toContain(MULCH_NEXT)
    }
    expect(en).toContain(MULCH_SEED)
    expect(en).toContain(MULCH_NEXT)
    for (const body of whatsappBodies) expect(body).toContain(AI_SUMMARY)
    expect(fr).toContain('Maintenant:')
  })

  it('leaves the working translator in charge, table or no table', async () => {
    useCropCycle()
    recipients = [{ preferredLocale: 'fr' }]

    await runAdvisoryEngine(FARM_ID)

    // Byte-identical to the pre-fix push: the seed sentence names the crop, and
    // a translator that can render it beats the deliberately generic table.
    expect(whatsappBodies[0]).toContain(`Maintenant: [fr] ${MULCH_SEED} (${PLOT_NAME})`)
    expect(whatsappBodies[0]).toContain(`Ensuite: [fr] ${MULCH_NEXT}`)
    expect(translatedTexts()).toEqual([MULCH_SEED, MULCH_NEXT, AI_SUMMARY])
  })

  it('still sends when the summary generation fails', async () => {
    useCropCycle()
    completeChat.mockRejectedValue(new Error('llm down'))
    recipients = [{ preferredLocale: 'fr' }]

    await runAdvisoryEngine(FARM_ID)

    expect(insertedRows[0].aiSummary).toBeNull()
    expect(whatsappBodies[0]).not.toContain('Pourquoi:')
    expect(whatsappBodies[0]).toContain('Maintenant: [fr] Plantain is in vegetative growth.')
  })
})
