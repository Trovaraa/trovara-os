import { Hono } from 'hono'
import { getTableName, type SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CANONICAL_CROP_TYPES } from '../lib/crop-normalize.js'

type Row = Record<string, unknown>

const nameOf = (table: unknown) => getTableName(table as never)

const sessionUser: Row = {
  id: 'user-owner',
  farmId: 'farm-1',
  role: 'owner',
  name: 'Owner',
  email: 'owner@trovara.farm',
}

/** Rows the fake db returns, queued per table so query order does not matter. */
const selectQueue = new Map<string, Row[][]>()
const selectLog: string[] = []
const inserted: { table: string; values: Row }[] = []
const updated: { table: string; values: Row }[] = []
const deleted: string[] = []
/** Every predicate a query was scoped to, so farm scoping can be asserted on. */
const whereLog: { table: string; condition: SQL }[] = []

function queueSelect(table: string, rows: Row[]) {
  const queued = selectQueue.get(table) ?? []
  queued.push(rows)
  selectQueue.set(table, queued)
}

vi.mock('../db/index.js', () => {
  const selectChain = () => {
    let rows: Row[] = []
    let table = ''
    const self: Record<string, unknown> = {}
    const same = () => self
    Object.assign(self, {
      from: (source: unknown) => {
        table = nameOf(source)
        selectLog.push(table)
        rows = selectQueue.get(table)?.shift() ?? []
        return self
      },
      leftJoin: same,
      innerJoin: same,
      where: (condition: SQL) => {
        whereLog.push({ table, condition })
        return self
      },
      orderBy: same,
      limit: same,
      then: (resolve: (value: Row[]) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(rows).then(resolve, reject),
    })
    return self
  }

  return {
    db: {
      select: selectChain,
      insert: (table: unknown) => ({
        values: (values: Row) => {
          inserted.push({ table: nameOf(table), values })
          return {
            returning: async () => [{ id: 'cycle-new', ...values }],
            onConflictDoNothing: async () => undefined,
          }
        },
      }),
      update: (table: unknown) => ({
        set: (values: Row) => {
          updated.push({ table: nameOf(table), values })
          return {
            where: (condition: SQL) => {
              whereLog.push({ table: nameOf(table), condition })
              return { returning: async () => [{ id: 'cycle-1', ...values }] }
            },
          }
        },
      }),
      delete: (table: unknown) => ({
        where: async (condition: SQL) => {
          deleted.push(nameOf(table))
          whereLog.push({ table: nameOf(table), condition })
        },
      }),
    },
  }
})

/**
 * The generator is a unit of its own; here it is stubbed so the route tests see
 * the call the create path makes without an LLM round trip standing in for one.
 */
const generateCropCycleAgronomy = vi.fn(
  async (..._args: unknown[]): Promise<Row> => ({ generated: true, stageCount: 4, taskCount: 3 }),
)

vi.mock('../lib/crop-agronomy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/crop-agronomy.js')>()
  return {
    ...actual,
    generateCropCycleAgronomy: (...args: unknown[]) => generateCropCycleAgronomy(...(args as [])),
  }
})

const completeChat = vi.fn()
const isLlmConfigured = vi.fn(() => true)

vi.mock('../lib/llm.js', () => ({
  completeChat: (...args: unknown[]) => completeChat(...args),
  isLlmConfigured: () => isLlmConfigured(),
}))

vi.mock('../lib/llm-budget.js', () => ({
  checkLlmBudget: () => ({ allowed: true, used: 0, limit: 500 }),
  consumeLlmBudget: vi.fn(),
}))

/**
 * The real canonical-English service runs, with only the LLM and db faked, so
 * the tests see its real short-circuits. The spies count how often the route
 * enters the service at all.
 */
const canonicalCalls = vi.fn()
const viewerBatchCalls = vi.fn()

vi.mock('../lib/content-locale.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/content-locale.js')>()
  return {
    ...actual,
    toCanonicalEnglish: (args: Parameters<typeof actual.toCanonicalEnglish>[0]) => {
      canonicalCalls(args)
      return actual.toCanonicalEnglish(args)
    },
    toViewerLocaleMany: (args: Parameters<typeof actual.toViewerLocaleMany>[0]) => {
      viewerBatchCalls(args)
      return actual.toViewerLocaleMany(args)
    },
  }
})

vi.mock('../middleware/auth.js', () => ({
  authMiddleware: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set('user', sessionUser)
    await next()
  },
}))

const recordFarmEvent = vi.fn(async () => undefined)
vi.mock('../lib/audit.js', () => ({ logAudit: vi.fn() }))
vi.mock('../lib/farm-events.js', () => ({ recordFarmEvent }))

const FRENCH_TO_ENGLISH: Record<string, string> = {
  'Semis clairsemé près du chemin, à replanter après les pluies':
    'Sparse seedlings near the path, replant after the rains',
  'Attaque de chenilles sur la parcelle est': 'Caterpillar attack on the eastern plot',
  'Désherbage des buttes': 'Weeding on the ridges',
  'Passer entre les rangs et arracher les mauvaises herbes':
    'Walk between the rows and pull the weeds',
}

const ENGLISH_TO_FRENCH: Record<string, string> = Object.fromEntries(
  Object.entries(FRENCH_TO_ENGLISH).map(([french, english]) => [english, french]),
)

const FRENCH_NOTES = 'Semis clairsemé près du chemin, à replanter après les pluies'
const ENGLISH_NOTES = 'Sparse seedlings near the path, replant after the rains'
const CYCLE_ID = '33333333-3333-4333-8333-333333333333'

async function cropApp() {
  const { cropRoutes } = await import('./crops.js')
  const app = new Hono()
  app.route('/crops', cropRoutes)
  return app
}

async function createCropCycle(cropType: string, extra: Row = {}, preferredLocale = 'fr') {
  queueSelect('plots', [{ id: 'plot-1', farmId: 'farm-1', name: 'Block 1' }])
  queueSelect('users', [{ preferredLocale }])
  return (await cropApp()).request('/crops', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      plotId: '11111111-1111-4111-8111-111111111111',
      cropType,
      plantedAt: '2026-02-01T08:00:00.000Z',
      ...extra,
    }),
  })
}

/** A stored cycle row: the notes column already holds canonical English. */
function cycleRow(overrides: Row = {}): Row {
  return {
    id: CYCLE_ID,
    plotId: 'plot-1',
    plotName: 'Block A',
    cropType: 'plantain',
    stage: 'vegetative',
    plantedAt: new Date('2026-02-01T08:00:00Z'),
    expectedHarvestAt: null,
    actualHarvestAt: null,
    expectedYieldKg: 1200,
    actualYieldKg: null,
    agronomySkipReason: null,
    notes: ENGLISH_NOTES,
    createdAt: new Date('2026-02-01T08:00:00Z'),
    updatedAt: new Date('2026-02-01T08:00:00Z'),
    sourceLocale: null,
    translationStatus: 'done',
    ...overrides,
  }
}

async function patchCycle(body: Row, existing: Row = cycleRow(), preferredLocale = 'fr') {
  queueSelect('crop_cycles', [existing])
  queueSelect('users', [{ preferredLocale }])
  return (await cropApp()).request(`/crops/${CYCLE_ID}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function insertedCycle(): Row {
  const row = inserted.find((entry) => entry.table === 'crop_cycles')
  expect(row).toBeDefined()
  return row!.values
}

function cyclePatch(): Row {
  const row = updated.find((entry) => entry.table === 'crop_cycles')
  expect(row).toBeDefined()
  return row!.values
}

/** Every string the translator was actually handed, in call order. */
function translatedTexts(): string[] {
  return completeChat.mock.calls.map((call) => call[1] as string)
}

const dialect = new PgDialect()

function paramsOf(entry?: { condition: SQL }): unknown[] {
  expect(entry).toBeDefined()
  return dialect.sqlToQuery(entry!.condition).params
}

/** The values the first query against a table was scoped to: the read that gates the 404. */
function firstWhereParams(table: string): unknown[] {
  return paramsOf(whereLog.find((row) => row.table === table))
}

/** The values the last query against a table was scoped to: the write itself. */
function lastWhereParams(table: string): unknown[] {
  return paramsOf([...whereLog].reverse().find((row) => row.table === table))
}

/** Run a request as a field worker, the role none of these endpoints admits. */
async function asFieldWorker<T>(fn: () => Promise<T>): Promise<T> {
  sessionUser.role = 'field_worker'
  try {
    return await fn()
  } finally {
    sessionUser.role = 'owner'
  }
}

const STAGE_ID = '44444444-4444-4444-8444-444444444444'
const TASK_ID = '55555555-5555-4555-8555-555555555555'

const FRENCH_TASK_NAME = 'Désherbage des buttes'
const ENGLISH_TASK_NAME = 'Weeding on the ridges'
const FRENCH_TASK_DESCRIPTION = 'Passer entre les rangs et arracher les mauvaises herbes'
const ENGLISH_TASK_DESCRIPTION = 'Walk between the rows and pull the weeds'

/** The four stages of the cycle these tests run against: 125 days to harvest. */
function lifecycleStages(): Row[] {
  return [
    { id: 'stage-planted', stage: 'planted', sequence: 0, durationDays: 14, source: 'generated' },
    {
      id: 'stage-germination',
      stage: 'germination',
      sequence: 1,
      durationDays: 21,
      source: 'generated',
    },
    { id: STAGE_ID, stage: 'vegetative', sequence: 2, durationDays: 90, source: 'generated' },
    {
      id: 'stage-harvest',
      stage: 'harvest_ready',
      sequence: 5,
      durationDays: 30,
      source: 'generated',
    },
  ].map((stage) => ({ farmId: 'farm-1', cropCycleId: CYCLE_ID, ...stage }))
}

/** A stored lifecycle task: its prose columns already hold canonical English. */
function taskRow(overrides: Row = {}): Row {
  return {
    id: TASK_ID,
    farmId: 'farm-1',
    cropCycleId: CYCLE_ID,
    stage: 'vegetative',
    offsetDays: 30,
    templateName: ENGLISH_TASK_NAME,
    description: ENGLISH_TASK_DESCRIPTION,
    defaultDurationHours: 4,
    source: 'generated',
    sourceLocale: 'en',
    translationStatus: 'done',
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  selectQueue.clear()
  selectLog.length = 0
  inserted.length = 0
  updated.length = 0
  deleted.length = 0
  whereLog.length = 0
  sessionUser.role = 'owner'
  generateCropCycleAgronomy.mockResolvedValue({ generated: true, stageCount: 4, taskCount: 3 })
  isLlmConfigured.mockReturnValue(true)
  completeChat.mockImplementation(async (system: string, text: string) => {
    const table = /into English/i.test(system) ? FRENCH_TO_ENGLISH : ENGLISH_TO_FRENCH
    return { text: table[text] ?? `[${text}]`, model: 'test' }
  })
})

describe('crop routes', () => {
  it('stores the canonical playbook key when the crop is typed in French', async () => {
    const res = await createCropCycle('Banane plantain')
    expect(res.status).toBe(201)

    const cropType = insertedCycle().cropType as string
    expect(cropType).toBe('plantain')
    // The web UI and the butler channels must agree on the stored key.
    expect(CANONICAL_CROP_TYPES).toContain(cropType)
  })

  it('records the canonical key on the farm event as well', async () => {
    await createCropCycle('noix de coco')
    expect(recordFarmEvent).toHaveBeenCalledWith(
      expect.objectContaining({ afterValue: { stage: 'planted', cropType: 'coconut' } }),
    )
  })

  it('stores a crop with no playbook exactly as it was typed', async () => {
    const res = await createCropCycle('Igname blanche')
    expect(res.status).toBe(201)
    expect(insertedCycle().cropType).toBe('Igname blanche')
  })
})

describe('POST /crops - canonical English on write', () => {
  it('stores French notes in English with the author locale', async () => {
    const res = await createCropCycle('plantain', { notes: FRENCH_NOTES })

    expect(res.status).toBe(201)
    expect(insertedCycle()).toMatchObject({
      notes: ENGLISH_NOTES,
      sourceLocale: 'fr',
      translationStatus: 'done',
    })
  })

  it('detects the language of the text when the author is on the default preference', async () => {
    // The 'en' default means "nobody chose a language", not "this is English":
    // labelling this row 'en'/'done' would hide French notes from the retry job.
    const res = await createCropCycle('plantain', { notes: FRENCH_NOTES }, 'en')

    expect(res.status).toBe(201)
    expect(insertedCycle()).toMatchObject({ notes: ENGLISH_NOTES, sourceLocale: 'fr' })
  })

  it('never sends the crop type through the translator', async () => {
    await createCropCycle('Banane plantain', { notes: FRENCH_NOTES, expectedYieldKg: 1200 })

    expect(insertedCycle()).toMatchObject({
      // The deterministic lexicon, not the translator: an exact lookup key.
      cropType: 'plantain',
      stage: 'planted',
      expectedYieldKg: 1200,
    })
    expect(translatedTexts()).toEqual([FRENCH_NOTES])
  })

  it('returns the author their own words while storing the English', async () => {
    const res = await createCropCycle('plantain', { notes: FRENCH_NOTES })
    const body = (await res.json()) as { cropCycle: Row }

    expect(body.cropCycle.notes).toBe(FRENCH_NOTES)
    expect(insertedCycle().notes).toBe(ENGLISH_NOTES)
  })

  it('stores the original as pending and still succeeds when the LLM is unavailable', async () => {
    isLlmConfigured.mockReturnValue(false)

    const res = await createCropCycle('plantain', { notes: FRENCH_NOTES })

    expect(res.status).toBe(201)
    expect(insertedCycle()).toMatchObject({
      notes: FRENCH_NOTES,
      sourceLocale: 'fr',
      translationStatus: 'pending',
    })
  })

  it('still succeeds and stays pending when the translator throws', async () => {
    completeChat.mockRejectedValue(new Error('upstream 503'))

    const res = await createCropCycle('plantain', { notes: FRENCH_NOTES })

    expect(res.status).toBe(201)
    expect(insertedCycle()).toMatchObject({
      notes: FRENCH_NOTES,
      translationStatus: 'pending',
    })
  })

  it('makes no translation call at all for an English create', async () => {
    const res = await createCropCycle('plantain', { notes: ENGLISH_NOTES }, 'en')

    expect(res.status).toBe(201)
    expect(completeChat).not.toHaveBeenCalled()
    expect(insertedCycle()).toMatchObject({
      notes: ENGLISH_NOTES,
      sourceLocale: 'en',
      translationStatus: 'done',
    })
  })

  it('does not enter the translation service for a create with no notes', async () => {
    const res = await createCropCycle('plantain')

    expect(res.status).toBe(201)
    expect(canonicalCalls).not.toHaveBeenCalled()
    // No prose, so the row keeps the schema defaults rather than being labelled.
    expect(insertedCycle()).not.toHaveProperty('sourceLocale')
    expect(insertedCycle()).not.toHaveProperty('translationStatus')
  })
})

describe('PATCH /crops/:id - canonical English on write', () => {
  it('stores edited French notes in English and labels the row', async () => {
    const res = await patchCycle({ notes: FRENCH_NOTES })

    expect(res.status).toBe(200)
    expect(cyclePatch()).toMatchObject({
      notes: ENGLISH_NOTES,
      sourceLocale: 'fr',
      translationStatus: 'done',
    })
  })

  it('escalates a settled row to pending when the notes could not be translated', async () => {
    completeChat.mockRejectedValue(new Error('upstream 503'))

    const res = await patchCycle({ notes: FRENCH_NOTES })

    expect(res.status).toBe(200)
    expect(cyclePatch()).toMatchObject({
      notes: FRENCH_NOTES,
      sourceLocale: 'fr',
      translationStatus: 'pending',
    })
  })

  it('leaves the bookkeeping of a row that already owes a translation alone', async () => {
    const res = await patchCycle(
      { notes: FRENCH_NOTES },
      cycleRow({ sourceLocale: 'yo', translationStatus: 'pending' }),
    )

    expect(res.status).toBe(200)
    expect(cyclePatch().notes).toBe(ENGLISH_NOTES)
    // The retry job owns the pair until it clears the debt it recorded.
    expect(cyclePatch()).not.toHaveProperty('translationStatus')
    expect(cyclePatch()).not.toHaveProperty('sourceLocale')
  })

  it('does not relabel the row or call the LLM for a stage-only patch', async () => {
    const res = await patchCycle({ stage: 'flowering' })

    expect(res.status).toBe(200)
    expect(canonicalCalls).not.toHaveBeenCalled()
    expect(completeChat).not.toHaveBeenCalled()
    expect(cyclePatch()).not.toHaveProperty('sourceLocale')
    expect(cyclePatch()).not.toHaveProperty('translationStatus')
  })

  it('echoes the notes the author just submitted rather than translating twice', async () => {
    const res = await patchCycle({ notes: FRENCH_NOTES })
    const body = (await res.json()) as { cropCycle: Row }

    expect(body.cropCycle.notes).toBe(FRENCH_NOTES)
    expect(viewerBatchCalls).not.toHaveBeenCalled()
  })
})

describe('GET /crops - viewer locale on read', () => {
  it('renders cycle notes for a French viewer in one batched call', async () => {
    queueSelect('crop_cycles', [
      cycleRow(),
      cycleRow({ id: 'cycle-2', notes: 'Caterpillar attack on the eastern plot' }),
    ])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await (await cropApp()).request('/crops')
    const body = (await res.json()) as { cropCycles: Row[] }

    expect(res.status).toBe(200)
    expect(viewerBatchCalls).toHaveBeenCalledTimes(1)
    expect(selectLog.filter((table) => table === 'content_translations')).toHaveLength(1)
    expect(body.cropCycles[0].notes).toBe(FRENCH_NOTES)
    expect(body.cropCycles[1].notes).toBe('Attaque de chenilles sur la parcelle est')
  })

  it('never sends the crop type, stage or plot name to the translator', async () => {
    queueSelect('crop_cycles', [cycleRow()])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await (await cropApp()).request('/crops')
    const cycle = ((await res.json()) as { cropCycles: Row[] }).cropCycles[0]

    expect(cycle).toMatchObject({
      cropType: 'plantain',
      stage: 'vegetative',
      plotName: 'Block A',
      expectedYieldKg: 1200,
    })
    expect(viewerBatchCalls).toHaveBeenCalledWith(
      expect.objectContaining({ texts: [ENGLISH_NOTES] }),
    )
  })

  it('does no translation work at all for an English viewer', async () => {
    queueSelect('crop_cycles', [cycleRow(), cycleRow({ id: 'cycle-2' })])
    queueSelect('users', [{ preferredLocale: 'en' }])

    const res = await (await cropApp()).request('/crops')
    const body = (await res.json()) as { cropCycles: Row[] }

    expect(viewerBatchCalls).not.toHaveBeenCalled()
    expect(completeChat).not.toHaveBeenCalled()
    expect(selectLog).not.toContain('content_translations')
    expect(body.cropCycles[0].notes).toBe(ENGLISH_NOTES)
  })

  it('carries why a cycle has no lifecycle, so the page can say so', async () => {
    queueSelect('crop_cycles', [cycleRow({ agronomySkipReason: 'llm_unavailable' })])
    queueSelect('users', [{ preferredLocale: 'en' }])

    const res = await (await cropApp()).request('/crops')
    const cycle = ((await res.json()) as { cropCycles: Row[] }).cropCycles[0]

    expect(cycle.agronomySkipReason).toBe('llm_unavailable')
  })

  it('reads 40 cycles with one batched call and one call per distinct string', async () => {
    queueSelect(
      'crop_cycles',
      Array.from({ length: 40 }, (_, index) => cycleRow({ id: `cycle-${index}` })),
    )
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await (await cropApp()).request('/crops')
    const body = (await res.json()) as { cropCycles: Row[] }

    expect(body.cropCycles).toHaveLength(40)
    expect(viewerBatchCalls).toHaveBeenCalledTimes(1)
    expect(completeChat).toHaveBeenCalledTimes(1)
    expect(body.cropCycles[39].notes).toBe(FRENCH_NOTES)
  })
})

describe('GET /crops/:id - viewer locale on read', () => {
  it('renders the notes for a French viewer and keeps the crop type', async () => {
    queueSelect('crop_cycles', [cycleRow()])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await (await cropApp()).request(`/crops/${CYCLE_ID}`)
    const body = (await res.json()) as { cropCycle: Row }

    expect(res.status).toBe(200)
    expect(viewerBatchCalls).toHaveBeenCalledTimes(1)
    expect(body.cropCycle.notes).toBe(FRENCH_NOTES)
    expect(body.cropCycle.cropType).toBe('plantain')
  })

  it('does no translation work at all for an English viewer', async () => {
    queueSelect('crop_cycles', [cycleRow()])
    queueSelect('users', [{ preferredLocale: 'en' }])

    await (await cropApp()).request(`/crops/${CYCLE_ID}`)

    expect(viewerBatchCalls).not.toHaveBeenCalled()
    expect(selectLog).not.toContain('content_translations')
  })
})

describe('POST /crops - establishing the lifecycle', () => {
  it('asks for a lifecycle for the crop the farmer typed, not the lexicon key', async () => {
    await createCropCycle('Banane plantain')

    // The key the row stores is what the playbooks match on; the plants in the
    // ground are what the lifecycle has to be right for.
    expect(insertedCycle().cropType).toBe('plantain')
    expect(generateCropCycleAgronomy).toHaveBeenCalledWith(
      expect.objectContaining({ farmId: 'farm-1', cropType: 'Banane plantain' }),
    )
  })

  it('asks for a lifecycle for a crop no playbook has ever heard of', async () => {
    await createCropCycle('Igname blanche')

    expect(generateCropCycleAgronomy).toHaveBeenCalledWith(
      expect.objectContaining({ cropType: 'Igname blanche' }),
    )
  })

  it('registers the planting when the generator throws', async () => {
    generateCropCycleAgronomy.mockRejectedValue(new Error('upstream 503'))

    const res = await createCropCycle('plantain')

    // The crop is in the ground whether or not a model was reachable.
    expect(res.status).toBe(201)
    expect(insertedCycle()).toMatchObject({ cropType: 'plantain' })
  })

  it('registers the planting when generation declines to write anything', async () => {
    generateCropCycleAgronomy.mockResolvedValue({ generated: false, reason: 'llm_unavailable' })

    expect((await createCropCycle('Igname blanche')).status).toBe(201)
  })
})

describe('GET /crops/:id/lifecycle', () => {
  async function lifecycle(
    stages: Row[] = lifecycleStages(),
    tasks: Row[] = [taskRow()],
    preferredLocale = 'en',
  ) {
    queueSelect('crop_cycles', [cycleRow()])
    queueSelect('crop_cycle_stages', stages)
    queueSelect('crop_cycle_tasks', tasks)
    queueSelect('users', [{ preferredLocale }])
    return (await cropApp()).request(`/crops/${CYCLE_ID}/lifecycle`)
  }

  it('serves the cycle its own stages, dated from the day it was planted', async () => {
    const res = await lifecycle()
    const body = (await res.json()) as { generated: boolean; totalDays: number; stages: Row[] }

    expect(res.status).toBe(200)
    expect(body.generated).toBe(true)
    expect(body.totalDays).toBe(155)
    expect(body.stages).toEqual([
      expect.objectContaining({
        stage: 'planted',
        durationDays: 14,
        source: 'generated',
        startsOn: '2026-02-01T08:00:00.000Z',
        endsOn: '2026-02-15T08:00:00.000Z',
      }),
      expect.objectContaining({ stage: 'germination', startsOn: '2026-02-15T08:00:00.000Z' }),
      expect.objectContaining({ stage: 'vegetative', startsOn: '2026-03-08T08:00:00.000Z' }),
      expect.objectContaining({ stage: 'harvest_ready', startsOn: '2026-06-06T08:00:00.000Z' }),
    ])
  })

  it('derives the expected harvest from the cycle own durations', async () => {
    const res = await lifecycle()
    const body = (await res.json()) as { expectedHarvestAt: string | null }

    expect(body.expectedHarvestAt).toBe('2026-06-06T08:00:00.000Z')
  })

  it('dates a task from the day its own stage is entered', async () => {
    const res = await lifecycle()
    const body = (await res.json()) as { tasks: Row[] }

    // 30 days into vegetative, which starts on 8 March, not 30 days into the cycle.
    expect(body.tasks[0]).toMatchObject({
      stage: 'vegetative',
      offsetDays: 30,
      dueDate: '2026-04-07T08:00:00.000Z',
    })
  })

  it('withholds the harvest date from a cycle nobody has given a lifecycle', async () => {
    const res = await lifecycle([], [])
    const body = (await res.json()) as Row

    expect(res.status).toBe(200)
    // Null rather than the old plantain constant: a harvest date is planned
    // around, and an invented one is planned around just as hard as a real one.
    expect(body).toMatchObject({
      generated: false,
      expectedHarvestAt: null,
      totalDays: null,
      stages: [],
      tasks: [],
    })
  })

  it('says why the lifecycle is empty, in the code the client renders', async () => {
    queueSelect('crop_cycles', [cycleRow({ agronomySkipReason: 'llm_unavailable' })])
    queueSelect('crop_cycle_stages', [])
    queueSelect('crop_cycle_tasks', [])
    queueSelect('users', [{ preferredLocale: 'en' }])

    const res = await (await cropApp()).request(`/crops/${CYCLE_ID}/lifecycle`)

    // The stored code, not a sentence: the wording is the client's, in the
    // language of whoever is looking.
    expect(await res.json()).toMatchObject({
      generated: false,
      agronomySkipReason: 'llm_unavailable',
    })
  })

  it('has nothing to explain about a cycle that has a lifecycle', async () => {
    const res = await lifecycle()

    expect(await res.json()).toMatchObject({ generated: true, agronomySkipReason: null })
  })

  it('renders task prose for a French viewer in one batched call', async () => {
    const res = await lifecycle(lifecycleStages(), [taskRow()], 'fr')
    const body = (await res.json()) as { tasks: Row[] }

    expect(viewerBatchCalls).toHaveBeenCalledTimes(1)
    expect(selectLog.filter((table) => table === 'content_translations')).toHaveLength(1)
    expect(body.tasks[0]).toMatchObject({
      templateName: FRENCH_TASK_NAME,
      description: FRENCH_TASK_DESCRIPTION,
    })
  })

  it('does no translation work at all for an English viewer', async () => {
    const res = await lifecycle()
    const body = (await res.json()) as { tasks: Row[] }

    expect(viewerBatchCalls).not.toHaveBeenCalled()
    expect(completeChat).not.toHaveBeenCalled()
    expect(body.tasks[0].templateName).toBe(ENGLISH_TASK_NAME)
  })

  it('is a 404 for a cycle on another farm', async () => {
    queueSelect('crop_cycles', [])

    const res = await (await cropApp()).request(`/crops/${CYCLE_ID}/lifecycle`)

    expect(res.status).toBe(404)
  })
})

describe('PATCH /crops/:id/lifecycle/stages/:stageId', () => {
  async function setDuration(durationDays: unknown, stages = lifecycleStages(), tasks: Row[] = []) {
    queueSelect('crop_cycle_stages', stages)
    queueSelect('crop_cycle_tasks', tasks)
    return (await cropApp()).request(`/crops/${CYCLE_ID}/lifecycle/stages/${STAGE_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ durationDays }),
    })
  }

  function stagePatch(): Row {
    const row = updated.find((entry) => entry.table === 'crop_cycle_stages')
    expect(row).toBeDefined()
    return row!.values
  }

  it('takes the farm own reading of how long the stage runs', async () => {
    const res = await setDuration(120)

    expect(res.status).toBe(200)
    expect(stagePatch()).toMatchObject({
      durationDays: 120,
      // Nothing regenerates over a duration the people who grow the crop set.
      source: 'manual',
    })
  })

  const rejectedByBounds: [string, unknown][] = [
    ['a stage longer than any crop stage runs', 2001],
    ['a negative duration', -1],
    ['a fractional duration', 90.5],
    ['a duration that is not a number', '90'],
  ]

  for (const [label, durationDays] of rejectedByBounds) {
    it(`refuses ${label}`, async () => {
      const res = await setDuration(durationDays)

      expect(res.status).toBe(400)
      expect(updated).toHaveLength(0)
    })
  }

  it('refuses an edit that pushes the whole cycle past the total', async () => {
    const res = await setDuration(2000, [
      { id: STAGE_ID, stage: 'vegetative', sequence: 2, durationDays: 90, source: 'generated' },
      { id: 'stage-flowering', stage: 'flowering', sequence: 3, durationDays: 2000, source: 'manual' },
      { id: 'stage-fruiting', stage: 'fruiting', sequence: 4, durationDays: 2000, source: 'manual' },
    ])

    expect(res.status).toBe(400)
    expect(updated).toHaveLength(0)
  })

  it('refuses to cut a stage shorter than the work already scheduled inside it', async () => {
    const res = await setDuration(20, lifecycleStages(), [taskRow({ offsetDays: 60 })])

    expect(res.status).toBe(400)
    expect(updated).toHaveLength(0)
  })

  it('stops explaining an empty lifecycle once the farm has edited one', async () => {
    await setDuration(120)

    expect(cyclePatch()).toEqual({ agronomySkipReason: null })
  })

  it('scopes the stages it reads and writes to the caller farm', async () => {
    await setDuration(120)

    expect(firstWhereParams('crop_cycle_stages')).toContain('farm-1')
    expect(lastWhereParams('crop_cycle_stages')).toContain('farm-1')
  })

  it('is a 404 for a stage on another farm', async () => {
    const res = await setDuration(120, [])

    expect(res.status).toBe(404)
    expect(updated).toHaveLength(0)
  })

  it('refuses a field worker', async () => {
    const res = await asFieldWorker(() => setDuration(120))

    expect(res.status).toBe(403)
    expect(updated).toHaveLength(0)
  })
})

describe('POST /crops/:id/lifecycle/tasks', () => {
  async function addTask(body: Row, stages = lifecycleStages(), tasks: Row[] = []) {
    queueSelect('crop_cycles', [cycleRow()])
    queueSelect('crop_cycle_stages', stages)
    queueSelect('crop_cycle_tasks', tasks)
    queueSelect('users', [{ preferredLocale: 'fr' }])
    return (await cropApp()).request(`/crops/${CYCLE_ID}/lifecycle/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  function insertedTask(): Row {
    const row = inserted.find((entry) => entry.table === 'crop_cycle_tasks')
    expect(row).toBeDefined()
    return row!.values
  }

  const FRENCH_TASK: Row = {
    stage: 'vegetative',
    offsetDays: 45,
    templateName: FRENCH_TASK_NAME,
    description: FRENCH_TASK_DESCRIPTION,
    defaultDurationHours: 4,
  }

  it('stores the work a farmer added in English, as the farm own', async () => {
    const res = await addTask(FRENCH_TASK)

    expect(res.status).toBe(201)
    expect(insertedTask()).toMatchObject({
      cropCycleId: CYCLE_ID,
      stage: 'vegetative',
      offsetDays: 45,
      templateName: ENGLISH_TASK_NAME,
      description: ENGLISH_TASK_DESCRIPTION,
      source: 'manual',
      sourceLocale: 'fr',
      translationStatus: 'done',
    })
  })

  it('returns the author their own words while storing the English', async () => {
    const res = await addTask(FRENCH_TASK)
    const body = (await res.json()) as { task: Row }

    expect(body.task.templateName).toBe(FRENCH_TASK_NAME)
    expect(body.task.description).toBe(FRENCH_TASK_DESCRIPTION)
  })

  it('stores the original as pending and still succeeds when the translator fails', async () => {
    completeChat.mockRejectedValue(new Error('upstream 503'))

    const res = await addTask(FRENCH_TASK)

    expect(res.status).toBe(201)
    expect(insertedTask()).toMatchObject({
      templateName: FRENCH_TASK_NAME,
      translationStatus: 'pending',
    })
  })

  it('refuses work hung on a stage this cycle never passes through', async () => {
    const res = await addTask({ ...FRENCH_TASK, stage: 'flowering' })

    expect(res.status).toBe(400)
    expect(inserted).toHaveLength(0)
  })

  it('refuses work due after its own stage has ended', async () => {
    const res = await addTask({ ...FRENCH_TASK, offsetDays: 120 })

    expect(res.status).toBe(400)
    expect(inserted).toHaveLength(0)
  })

  const rejectedByBounds: [string, Row][] = [
    ['an offset past the end of any cycle', { offsetDays: 2001 }],
    ['a negative offset', { offsetDays: -1 }],
    ['a fractional offset', { offsetDays: 4.5 }],
    ['no name at all', { templateName: '   ' }],
    ['a name longer than the column allows', { templateName: 'x'.repeat(201) }],
    ['a description longer than the column allows', { description: 'x'.repeat(1001) }],
    ['a task longer than a working day', { defaultDurationHours: 25 }],
    ['a task that takes no time', { defaultDurationHours: 0 }],
  ]

  for (const [label, override] of rejectedByBounds) {
    it(`refuses ${label}`, async () => {
      const res = await addTask({ ...FRENCH_TASK, ...override })

      expect(res.status).toBe(400)
      expect(inserted).toHaveLength(0)
    })
  }

  it('refuses to grow the lifecycle past the number of tasks it may hold', async () => {
    const res = await addTask(
      FRENCH_TASK,
      lifecycleStages(),
      Array.from({ length: 40 }, (_, i) => taskRow({ id: `task-${i}` })),
    )

    expect(res.status).toBe(400)
    expect(inserted).toHaveLength(0)
  })

  it('scopes the cycle it writes against to the caller farm', async () => {
    await addTask(FRENCH_TASK)

    expect(firstWhereParams('crop_cycles')).toContain('farm-1')
  })

  it('stops explaining an empty lifecycle once the farm has added work', async () => {
    await addTask(FRENCH_TASK)

    expect(cyclePatch()).toEqual({ agronomySkipReason: null })
  })

  it('is a 404 for a cycle on another farm', async () => {
    queueSelect('crop_cycles', [])

    const res = await (await cropApp()).request(`/crops/${CYCLE_ID}/lifecycle/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(FRENCH_TASK),
    })

    expect(res.status).toBe(404)
    expect(inserted).toHaveLength(0)
  })

  it('refuses a field worker', async () => {
    const res = await asFieldWorker(() => addTask(FRENCH_TASK))

    expect(res.status).toBe(403)
    expect(inserted).toHaveLength(0)
  })
})

describe('PATCH /crops/:id/lifecycle/tasks/:taskId', () => {
  /** The one stage the edit looks up, since the handler queries it by name. */
  const vegetativeStage = lifecycleStages().filter((stage) => stage.stage === 'vegetative')

  async function editTask(body: Row, existing: Row | null = taskRow(), stages = vegetativeStage) {
    queueSelect('crop_cycle_tasks', existing ? [existing] : [])
    queueSelect('crop_cycle_stages', stages)
    queueSelect('users', [{ preferredLocale: 'fr' }])
    return (await cropApp()).request(`/crops/${CYCLE_ID}/lifecycle/tasks/${TASK_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  function taskPatch(): Row {
    const row = updated.find((entry) => entry.table === 'crop_cycle_tasks')
    expect(row).toBeDefined()
    return row!.values
  }

  it('takes ownership of a generated row the farm edited', async () => {
    const res = await editTask({ offsetDays: 60 })

    expect(res.status).toBe(200)
    expect(taskPatch()).toMatchObject({ offsetDays: 60, source: 'manual' })
  })

  it('stores edited prose in English and labels the row', async () => {
    const res = await editTask({ templateName: FRENCH_TASK_NAME })

    expect(res.status).toBe(200)
    expect(taskPatch()).toMatchObject({
      templateName: ENGLISH_TASK_NAME,
      sourceLocale: 'fr',
      translationStatus: 'done',
    })
  })

  it('echoes the words the author just submitted rather than translating twice', async () => {
    const res = await editTask({ templateName: FRENCH_TASK_NAME })
    const body = (await res.json()) as { task: Row }

    expect(body.task.templateName).toBe(FRENCH_TASK_NAME)
    expect(viewerBatchCalls).not.toHaveBeenCalled()
  })

  it('refuses to move work past the end of the stage it lands in', async () => {
    const res = await editTask({ offsetDays: 200 })

    expect(res.status).toBe(400)
    expect(updated).toHaveLength(0)
  })

  it('refuses to move work onto a stage this cycle never passes through', async () => {
    const res = await editTask({ stage: 'flowering' }, taskRow(), [])

    expect(res.status).toBe(400)
    expect(updated).toHaveLength(0)
  })

  it('refuses an empty edit rather than relabelling the row for nothing', async () => {
    const res = await editTask({})

    expect(res.status).toBe(400)
    expect(updated).toHaveLength(0)
  })

  it('stops explaining an empty lifecycle once the farm has corrected work in one', async () => {
    await editTask({ offsetDays: 60 })

    expect(cyclePatch()).toEqual({ agronomySkipReason: null })
  })

  it('scopes the task it reads to the caller farm and the cycle in the path', async () => {
    await editTask({ offsetDays: 60 })

    const params = firstWhereParams('crop_cycle_tasks')
    expect(params).toContain('farm-1')
    expect(params).toContain(CYCLE_ID)
  })

  it('is a 404 for a task on another farm', async () => {
    const res = await editTask({ offsetDays: 60 }, null)

    expect(res.status).toBe(404)
    expect(updated).toHaveLength(0)
  })

  it('refuses a field worker', async () => {
    const res = await asFieldWorker(() => editTask({ offsetDays: 60 }))

    expect(res.status).toBe(403)
    expect(updated).toHaveLength(0)
  })
})

describe('DELETE /crops/:id/lifecycle/tasks/:taskId', () => {
  async function removeTask(existing: Row | null = taskRow()) {
    queueSelect('crop_cycle_tasks', existing ? [existing] : [])
    return (await cropApp()).request(`/crops/${CYCLE_ID}/lifecycle/tasks/${TASK_ID}`, {
      method: 'DELETE',
    })
  }

  it('removes work the farm no longer wants', async () => {
    const res = await removeTask()

    expect(res.status).toBe(200)
    expect(deleted).toEqual(['crop_cycle_tasks'])
  })

  it('is a 404 for a task on another farm', async () => {
    const res = await removeTask(null)

    expect(res.status).toBe(404)
    expect(deleted).toHaveLength(0)
  })

  it('refuses a field worker', async () => {
    const res = await asFieldWorker(() => removeTask())

    expect(res.status).toBe(403)
    expect(deleted).toHaveLength(0)
  })
})

describe('POST /crops/:id/agronomy/regenerate', () => {
  async function regenerate(existing: Row | null = cycleRow()) {
    queueSelect('crop_cycles', existing ? [existing] : [])
    return (await cropApp()).request(`/crops/${CYCLE_ID}/agronomy/regenerate`, { method: 'POST' })
  }

  it('reports what the generator did', async () => {
    const res = await regenerate()

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ generated: true, stageCount: 4, taskCount: 3 })
    expect(generateCropCycleAgronomy).toHaveBeenCalledWith(
      expect.objectContaining({ farmId: 'farm-1', cropType: 'plantain' }),
    )
  })

  it('reports why nothing was written rather than failing', async () => {
    generateCropCycleAgronomy.mockResolvedValue({ generated: false, reason: 'budget_exhausted' })

    const res = await regenerate()

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ generated: false, reason: 'budget_exhausted' })
  })

  it('is a 404 for a cycle on another farm', async () => {
    expect((await regenerate(null)).status).toBe(404)
    expect(generateCropCycleAgronomy).not.toHaveBeenCalled()
  })

  it('refuses a field worker', async () => {
    const res = await asFieldWorker(() => regenerate())

    expect(res.status).toBe(403)
    expect(generateCropCycleAgronomy).not.toHaveBeenCalled()
  })
})
