import { Hono } from 'hono'
import { getTableName, type SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isNoilerBatch } from '../lib/species-normalize.js'

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

  const insert = (table: unknown) => ({
    values: (values: Row) => {
      inserted.push({ table: nameOf(table), values })
      return {
        returning: async () => [{ id: 'batch-new', ...values }],
        onConflictDoNothing: async () => undefined,
      }
    },
  })

  const update = (table: unknown) => ({
    set: (values: Row) => {
      updated.push({ table: nameOf(table), values })
      return {
        where: () => ({ returning: async () => [{ id: 'batch-1', ...values }] }),
      }
    },
  })

  const del = (table: unknown) => ({
    where: async (condition: SQL) => {
      deleted.push(nameOf(table))
      whereLog.push({ table: nameOf(table), condition })
    },
  })

  const db = {
    select: selectChain,
    insert,
    update,
    delete: del,
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ insert, update }),
  }

  return { db }
})

/**
 * The generator is a unit of its own; here it is stubbed so the route tests see
 * the call the create path makes without an LLM round trip standing in for one.
 */
const generateBatchAgronomy = vi.fn(
  async (..._args: unknown[]): Promise<Row> => ({ generated: true, entryCount: 3 }),
)

vi.mock('../lib/poultry-agronomy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/poultry-agronomy.js')>()
  return {
    ...actual,
    generateBatchAgronomy: (...args: unknown[]) => generateBatchAgronomy(...(args as [])),
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

vi.mock('../lib/audit.js', () => ({ logAudit: vi.fn() }))

const FRENCH_TO_ENGLISH: Record<string, string> = {
  'Deux poussins boitent depuis ce matin, à surveiller de près':
    'Two chicks have been limping since this morning, keep an eye on them',
  'Mangeoire numéro 3 cassée, réparée avec du fil':
    'Feeder number 3 broken, repaired with wire',
  'Vaccin Gumboro donné à tout le lot': 'Gumboro vaccine given to the whole batch',
  'Vaccin Gumboro vivant': 'Gumboro live vaccine',
}

const ENGLISH_TO_FRENCH: Record<string, string> = Object.fromEntries(
  Object.entries(FRENCH_TO_ENGLISH).map(([french, english]) => [english, french]),
)

const FRENCH_NOTES = 'Deux poussins boitent depuis ce matin, à surveiller de près'
const ENGLISH_NOTES = 'Two chicks have been limping since this morning, keep an eye on them'

const BATCH_ID = '22222222-2222-4222-8222-222222222222'

async function livestockApp() {
  const { livestockRoutes } = await import('./livestock.js')
  const app = new Hono()
  app.route('/livestock', livestockRoutes)
  return app
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 86400000)
}

/** The growth columns as Postgres hands them back: numerics arrive as strings. */
const CURVE = {
  startWeightKg: '0.040',
  targetWeightKg: '2.500',
  dailyGainKg: '0.0500',
  cycleDays: 49,
  agronomySource: 'generated',
}

/**
 * A batch row the way a legacy row looks: species text only, no batch type and
 * no growth curve, which is the state every row was in before a farm had one.
 */
function batchRow(species: string, batchType: string | null = null, overrides: Row = {}): Row {
  return {
    id: BATCH_ID,
    farmId: 'farm-1',
    name: 'Shed A',
    species,
    batchType,
    headCount: 480,
    startCount: 500,
    feedUsedKg: 900,
    acquiredAt: daysAgo(10),
    targetCloseoutAt: null,
    agronomySkipReason: null,
    active: true,
    sourceLocale: null,
    translationStatus: 'done',
    ...overrides,
  }
}

const ENTRY_ID = '33333333-3333-4333-8333-333333333333'

function entryRow(overrides: Row = {}): Row {
  return {
    id: ENTRY_ID,
    farmId: 'farm-1',
    batchId: BATCH_ID,
    dayOffset: 7,
    name: 'Gumboro (IBD)',
    vaccine: 'Gumboro live',
    source: 'generated',
    sourceLocale: 'en',
    translationStatus: 'done',
    ...overrides,
  }
}

async function createBatch(species: string) {
  const app = await livestockApp()
  return app.request('/livestock/batches', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Shed A',
      species,
      headCount: 500,
      acquiredAt: '2026-02-01T08:00:00.000Z',
    }),
  })
}

async function patchSpecies(species: string) {
  queueSelect('livestock_batches', [batchRow('noiler', 'noiler')])
  const app = await livestockApp()
  return app.request(`/livestock/batches/${BATCH_ID}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ species }),
  })
}

async function vaccinationSchedule(batch: Row, entries: Row[] = [], locale = 'en') {
  queueSelect('livestock_batches', [batch])
  queueSelect('livestock_schedule_entries', entries)
  queueSelect('livestock_logs', [])
  queueSelect('users', [{ preferredLocale: locale }])
  const app = await livestockApp()
  return app.request(`/livestock/batches/${BATCH_ID}/vaccination-schedule`)
}

async function economics(batch: Row) {
  queueSelect('livestock_batches', [batch])
  const app = await livestockApp()
  return app.request(`/livestock/batches/${BATCH_ID}/economics`)
}

function insertedBatch(): Row {
  const row = inserted.find((entry) => entry.table === 'livestock_batches')
  expect(row).toBeDefined()
  return row!.values
}

function insertedLog(): Row {
  const row = inserted.find((entry) => entry.table === 'livestock_logs')
  expect(row).toBeDefined()
  return row!.values
}

function batchPatch(): Row {
  const row = updated.find((entry) => entry.table === 'livestock_batches')
  expect(row).toBeDefined()
  return row!.values
}

/** Every string the translator was actually handed, in call order. */
function translatedTexts(): string[] {
  return completeChat.mock.calls.map((call) => call[1] as string)
}

const dialect = new PgDialect()

/** The values the last query against a table was scoped to. */
function whereParams(table: string): unknown[] {
  const entry = [...whereLog].reverse().find((row) => row.table === table)
  expect(entry).toBeDefined()
  return dialect.sqlToQuery(entry!.condition).params
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

/** A create carrying prose, by an author with the given language preference. */
async function createBatchWith(body: Row, preferredLocale = 'fr') {
  queueSelect('users', [{ preferredLocale }])
  return (await livestockApp()).request('/livestock/batches', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Shed A',
      species: 'noiler',
      headCount: 500,
      acquiredAt: '2026-02-01T08:00:00.000Z',
      ...body,
    }),
  })
}

async function patchBatch(body: Row, existing: Row = batchRow('noiler', 'noiler'), locale = 'fr') {
  queueSelect('livestock_batches', [existing])
  queueSelect('users', [{ preferredLocale: locale }])
  return (await livestockApp()).request(`/livestock/batches/${BATCH_ID}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function createLog(body: Row, preferredLocale = 'fr', batch: Row = batchRow('noiler')) {
  queueSelect('livestock_batches', [batch])
  queueSelect('users', [{ preferredLocale }])
  return (await livestockApp()).request(`/livestock/batches/${BATCH_ID}/logs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** A stored batch row: the notes column already holds canonical English. */
function storedBatch(overrides: Row = {}): Row {
  return {
    id: BATCH_ID,
    name: 'Shed A',
    species: 'noiler',
    headCount: 480,
    plotId: 'plot-1',
    plotName: 'Block A',
    acquiredAt: daysAgo(10),
    notes: ENGLISH_NOTES,
    active: true,
    createdAt: daysAgo(10),
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
  generateBatchAgronomy.mockResolvedValue({ generated: true, entryCount: 3 })
  isLlmConfigured.mockReturnValue(true)
  completeChat.mockImplementation(async (system: string, text: string) => {
    const table = /into English/i.test(system) ? FRENCH_TO_ENGLISH : ENGLISH_TO_FRENCH
    return { text: table[text] ?? `[${text}]`, model: 'test' }
  })
})

describe('livestock batch writes', () => {
  it('stores the canonical species and the batch type it implies', async () => {
    const res = await createBatch('Noiler chicken')
    expect(res.status).toBe(201)
    expect(insertedBatch()).toMatchObject({ species: 'noiler', batchType: 'noiler' })
  })

  it('resolves a species typed in French, Yoruba or Pidgin', async () => {
    for (const [typed, expected] of [
      ['poulet noiler', 'noiler'],
      ['adìẹ noiler', 'noiler'],
      ['noila', 'noiler'],
      ['poule pondeuse', 'layer'],
      ['poulette', 'pullet'],
    ] as const) {
      inserted.length = 0
      const res = await createBatch(typed)
      expect(res.status).toBe(201)
      expect(insertedBatch()).toMatchObject({ species: expected, batchType: expected })
    }
  })

  it('keeps a species the enum cannot express exactly as it was typed', async () => {
    const res = await createBatch('Kuroiler cockerel')
    expect(res.status).toBe(201)
    expect(insertedBatch()).toMatchObject({ species: 'Kuroiler cockerel', batchType: null })
  })

  it('classifies descriptive text without flattening what the farmer wrote', async () => {
    const res = await createBatch('Noiler (day old)')
    expect(res.status).toBe(201)
    expect(insertedBatch()).toMatchObject({ species: 'Noiler (day old)', batchType: 'noiler' })
  })

  it('re-derives the batch type when the species is edited away from poultry', async () => {
    const res = await patchSpecies('Goats')
    expect(res.status).toBe(200)
    expect(updated[0].values).toMatchObject({ species: 'Goats', batchType: null })
  })

  it('re-derives the batch type when the species is edited to another poultry type', async () => {
    const res = await patchSpecies('poule pondeuse')
    expect(res.status).toBe(200)
    expect(updated[0].values).toMatchObject({ species: 'layer', batchType: 'layer' })
  })

  it('re-asks for a calendar when the species is corrected', async () => {
    // The batch may be carrying a refusal that stopped being true the moment
    // the species changed.
    const res = await patchSpecies('poule pondeuse')
    expect(res.status).toBe(200)
    expect(generateBatchAgronomy).toHaveBeenCalledTimes(1)
  })

  it('leaves the calendar alone when the species is unchanged', async () => {
    const res = await patchSpecies('noiler')
    expect(res.status).toBe(200)
    expect(generateBatchAgronomy).not.toHaveBeenCalled()
  })

  it('leaves the calendar alone for a patch that does not touch the species', async () => {
    const res = await patchBatch({ headCount: 180 })
    expect(res.status).toBe(200)
    expect(generateBatchAgronomy).not.toHaveBeenCalled()
  })
})

describe('GET /livestock/batches/:id/vaccination-schedule', () => {
  it('serves the batch its own entries, due-dated from when the animals arrived', async () => {
    const res = await vaccinationSchedule(batchRow('noiler', 'noiler'), [
      entryRow({ id: 'entry-1', dayOffset: 3, name: 'Newcastle / IB', vaccine: 'Lasota + IB' }),
      entryRow({ id: 'entry-2', dayOffset: 30, name: 'Weigh a sample', vaccine: null }),
    ])

    expect(res.status).toBe(200)
    const body = (await res.json()) as { generated: boolean; schedule: Row[] }
    expect(body.generated).toBe(true)
    expect(body.schedule).toEqual([
      expect.objectContaining({ day: 3, name: 'Newcastle / IB', status: 'overdue' }),
      expect.objectContaining({ day: 30, vaccine: null, status: 'upcoming' }),
    ])
  })

  it('marks an entry completed when a vaccination was logged within a day of it', async () => {
    queueSelect('livestock_batches', [batchRow('noiler', 'noiler')])
    queueSelect('livestock_schedule_entries', [entryRow({ dayOffset: 7 })])
    queueSelect('livestock_logs', [{ logType: 'vaccination', createdAt: daysAgo(3) }])
    queueSelect('users', [{ preferredLocale: 'en' }])

    const res = await (await livestockApp()).request(
      `/livestock/batches/${BATCH_ID}/vaccination-schedule`,
    )
    const body = (await res.json()) as { schedule: Row[]; completedCount: number }

    expect(body.schedule[0].status).toBe('completed')
    expect(body.completedCount).toBe(1)
  })

  it('marks an entry due on the day it falls', async () => {
    const res = await vaccinationSchedule(batchRow('noiler', 'noiler'), [
      entryRow({ dayOffset: 10 }),
    ])
    const body = (await res.json()) as { schedule: Row[] }

    expect(body.schedule[0].status).toBe('due')
  })

  // The schedule is the batch's own data, so nothing about the species gates it:
  // the goat farm that wrote its own deworming calendar gets to read it back.
  for (const species of ['Goats', 'chèvre', 'Catfish', 'poule pondeuse', 'Kuroiler cockerel']) {
    it(`serves the schedule of a "${species}" batch`, async () => {
      const res = await vaccinationSchedule(batchRow(species), [entryRow()])

      expect(res.status).toBe(200)
      expect(((await res.json()) as { schedule: Row[] }).schedule).toHaveLength(1)
      expect(isNoilerBatch({ species, batchType: null })).toBe(false)
    })
  }

  it('reports an empty calendar as a state rather than an error', async () => {
    const res = await vaccinationSchedule(batchRow('noiler', 'noiler'), [])

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ generated: false, schedule: [], completedCount: 0 })
  })

  it('says why the calendar is empty, in the code the client renders', async () => {
    const res = await vaccinationSchedule(
      batchRow('noiler', 'noiler', { agronomySkipReason: 'budget_exhausted' }),
      [],
    )

    // The stored code, not a sentence: the wording is the client's, in the
    // language of whoever is looking.
    expect(await res.json()).toMatchObject({
      generated: false,
      agronomySkipReason: 'budget_exhausted',
    })
  })

  it('has nothing to explain about a batch that has a calendar', async () => {
    const res = await vaccinationSchedule(batchRow('noiler', 'noiler'), [entryRow()])

    expect(await res.json()).toMatchObject({ generated: true, agronomySkipReason: null })
  })

  it('renders the entry prose for a French viewer in one batched call', async () => {
    const res = await vaccinationSchedule(
      batchRow('noiler', 'noiler'),
      [
        entryRow({ id: 'entry-1', name: 'Gumboro vaccine given to the whole batch', vaccine: null }),
        entryRow({ id: 'entry-2', dayOffset: 14, name: 'Feeder number 3 broken, repaired with wire', vaccine: null }),
      ],
      'fr',
    )
    const body = (await res.json()) as { schedule: Row[] }

    expect(viewerBatchCalls).toHaveBeenCalledTimes(1)
    expect(body.schedule[0].name).toBe('Vaccin Gumboro donné à tout le lot')
    expect(body.schedule[1].name).toBe('Mangeoire numéro 3 cassée, réparée avec du fil')
  })

  it('does no translation work at all for an English viewer', async () => {
    await vaccinationSchedule(batchRow('noiler', 'noiler'), [entryRow(), entryRow({ dayOffset: 14 })])

    expect(viewerBatchCalls).not.toHaveBeenCalled()
    expect(completeChat).not.toHaveBeenCalled()
    expect(selectLog).not.toContain('content_translations')
  })
})

describe('batch economics', () => {
  it('estimates the weight from the batch own curve', async () => {
    const res = await economics(batchRow('noiler', 'noiler', CURVE))
    const body = (await res.json()) as { estimatedWeightPerBirdKg: number; weightGainKg: number }

    // 0.04 kg on arrival plus 0.05 kg/day for 10 days, for these birds.
    expect(body.estimatedWeightPerBirdKg).toBe(0.54)
    expect(body.weightGainKg).toBe(239.2)
  })

  it('withholds the estimate for a batch nobody has established a curve for', async () => {
    for (const species of ['noiler', 'Goats', 'poule pondeuse']) {
      const res = await economics(batchRow(species))
      const body = (await res.json()) as {
        estimatedWeightPerBirdKg: number | null
        weightGainKg: number | null
        fcr: number | null
      }

      // No default stands in: a borrowed weight would be read as a measurement
      // of these animals, and the feed conversion ratio built on it as a fact.
      expect(body.estimatedWeightPerBirdKg).toBeNull()
      expect(body.weightGainKg).toBeNull()
      expect(body.fcr).toBeNull()
    }
  })
})

describe('POST /livestock/batches - canonical English on write', () => {
  it('stores French notes in English with the author locale', async () => {
    const res = await createBatchWith({ notes: FRENCH_NOTES })

    expect(res.status).toBe(201)
    expect(insertedBatch()).toMatchObject({
      notes: ENGLISH_NOTES,
      sourceLocale: 'fr',
      translationStatus: 'done',
    })
  })

  it('detects the language of the text when the author is on the default preference', async () => {
    // The 'en' default means "nobody chose a language", not "this is English":
    // labelling this row 'en'/'done' would hide French notes from the retry job.
    const res = await createBatchWith({ notes: FRENCH_NOTES }, 'en')

    expect(res.status).toBe(201)
    expect(insertedBatch()).toMatchObject({
      notes: ENGLISH_NOTES,
      sourceLocale: 'fr',
      translationStatus: 'done',
    })
  })

  it('leaves the batch name, species, head count and dates verbatim', async () => {
    await createBatchWith({ notes: FRENCH_NOTES, species: 'poulet noiler' })

    expect(insertedBatch()).toMatchObject({
      name: 'Shed A',
      // The deterministic lexicon, not the translator: an exact lookup key.
      species: 'noiler',
      batchType: 'noiler',
      headCount: 500,
    })
    // The notes are the only prose; nothing else reaches the translator.
    expect(translatedTexts()).toEqual([FRENCH_NOTES])
  })

  it('returns the author their own words while storing the English', async () => {
    const res = await createBatchWith({ notes: FRENCH_NOTES })
    const body = (await res.json()) as { batch: Row }

    expect(body.batch.notes).toBe(FRENCH_NOTES)
    expect(insertedBatch().notes).toBe(ENGLISH_NOTES)
  })

  it('stores the original as pending and still succeeds when the LLM is unavailable', async () => {
    isLlmConfigured.mockReturnValue(false)

    const res = await createBatchWith({ notes: FRENCH_NOTES })

    expect(res.status).toBe(201)
    expect(insertedBatch()).toMatchObject({
      notes: FRENCH_NOTES,
      sourceLocale: 'fr',
      translationStatus: 'pending',
    })
  })

  it('still succeeds and stays pending when the translator throws', async () => {
    completeChat.mockRejectedValue(new Error('upstream 503'))

    const res = await createBatchWith({ notes: FRENCH_NOTES })

    expect(res.status).toBe(201)
    expect(insertedBatch()).toMatchObject({
      notes: FRENCH_NOTES,
      sourceLocale: 'fr',
      translationStatus: 'pending',
    })
  })

  it('makes no translation call at all for an English create', async () => {
    const res = await createBatchWith({ notes: ENGLISH_NOTES }, 'en')

    expect(res.status).toBe(201)
    expect(completeChat).not.toHaveBeenCalled()
    expect(insertedBatch()).toMatchObject({
      notes: ENGLISH_NOTES,
      sourceLocale: 'en',
      translationStatus: 'done',
    })
  })

  it('does not enter the translation service for a create with no notes', async () => {
    const res = await createBatchWith({})

    expect(res.status).toBe(201)
    expect(canonicalCalls).not.toHaveBeenCalled()
    // No prose, so the row keeps the schema defaults rather than being labelled.
    expect(insertedBatch()).not.toHaveProperty('sourceLocale')
    expect(insertedBatch()).not.toHaveProperty('translationStatus')
  })
})

describe('PATCH /livestock/batches/:id - canonical English on write', () => {
  it('stores edited French notes in English and labels the row', async () => {
    const res = await patchBatch({ notes: FRENCH_NOTES })

    expect(res.status).toBe(200)
    expect(batchPatch()).toMatchObject({
      notes: ENGLISH_NOTES,
      sourceLocale: 'fr',
      translationStatus: 'done',
    })
  })

  it('escalates a settled row to pending when the notes could not be translated', async () => {
    isLlmConfigured.mockReturnValue(false)

    const res = await patchBatch({ notes: FRENCH_NOTES })

    expect(res.status).toBe(200)
    expect(batchPatch()).toMatchObject({
      notes: FRENCH_NOTES,
      sourceLocale: 'fr',
      translationStatus: 'pending',
    })
  })

  it('leaves the bookkeeping of a row that already owes a translation alone', async () => {
    const owed = batchRow('noiler', 'noiler')
    owed.sourceLocale = 'yo'
    owed.translationStatus = 'pending'

    const res = await patchBatch({ notes: FRENCH_NOTES }, owed)

    expect(res.status).toBe(200)
    expect(batchPatch().notes).toBe(ENGLISH_NOTES)
    // The retry job owns the pair until it clears the debt it recorded.
    expect(batchPatch()).not.toHaveProperty('translationStatus')
    expect(batchPatch()).not.toHaveProperty('sourceLocale')
  })

  it('does not relabel the row or call the LLM for a patch that carries no prose', async () => {
    const res = await patchBatch({ headCount: 470 })

    expect(res.status).toBe(200)
    expect(canonicalCalls).not.toHaveBeenCalled()
    expect(completeChat).not.toHaveBeenCalled()
    expect(batchPatch()).toEqual({ headCount: 470 })
  })

  it('echoes the notes the author just submitted rather than translating twice', async () => {
    const res = await patchBatch({ notes: FRENCH_NOTES })
    const body = (await res.json()) as { batch: Row }

    expect(body.batch.notes).toBe(FRENCH_NOTES)
    expect(viewerBatchCalls).not.toHaveBeenCalled()
  })
})

describe('POST /livestock/batches/:id/logs - canonical English on write', () => {
  it('stores French log notes in English with the author locale', async () => {
    const res = await createLog({
      logType: 'vaccination',
      notes: 'Vaccin Gumboro donné à tout le lot',
    })

    expect(res.status).toBe(201)
    expect(insertedLog()).toMatchObject({
      notes: 'Gumboro vaccine given to the whole batch',
      logType: 'vaccination',
      sourceLocale: 'fr',
      translationStatus: 'done',
    })
  })

  it('keeps the log type enum and head count verbatim and still adjusts the batch', async () => {
    const res = await createLog({
      logType: 'mortality',
      headCount: 4,
      notes: 'Mangeoire numéro 3 cassée, réparée avec du fil',
    })

    expect(res.status).toBe(201)
    expect(insertedLog()).toMatchObject({
      logType: 'mortality',
      headCount: 4,
      notes: 'Feeder number 3 broken, repaired with wire',
    })
    // The mortality count still lands on the batch inside the same transaction.
    expect(batchPatch()).toEqual({ headCount: 476 })
    expect(translatedTexts()).toEqual(['Mangeoire numéro 3 cassée, réparée avec du fil'])
  })

  it('stores the original as pending and still succeeds when the LLM is unavailable', async () => {
    isLlmConfigured.mockReturnValue(false)

    const res = await createLog({ logType: 'incident', notes: FRENCH_NOTES })

    expect(res.status).toBe(201)
    expect(insertedLog()).toMatchObject({
      notes: FRENCH_NOTES,
      sourceLocale: 'fr',
      translationStatus: 'pending',
    })
  })

  it('still succeeds and stays pending when the translator throws', async () => {
    completeChat.mockRejectedValue(new Error('upstream 503'))

    const res = await createLog({ logType: 'incident', notes: FRENCH_NOTES })

    expect(res.status).toBe(201)
    expect(insertedLog()).toMatchObject({ notes: FRENCH_NOTES, translationStatus: 'pending' })
  })

  it('makes no translation call at all for an English log', async () => {
    const res = await createLog({ logType: 'health_check', notes: ENGLISH_NOTES }, 'en')

    expect(res.status).toBe(201)
    expect(completeChat).not.toHaveBeenCalled()
    expect(insertedLog()).toMatchObject({ notes: ENGLISH_NOTES, translationStatus: 'done' })
  })

  it('returns the author their own words while storing the English', async () => {
    const res = await createLog({ logType: 'incident', notes: FRENCH_NOTES })
    const body = (await res.json()) as { log: Row }

    expect(body.log.notes).toBe(FRENCH_NOTES)
    expect(insertedLog().notes).toBe(ENGLISH_NOTES)
  })
})

describe('GET /livestock/batches - viewer locale on read', () => {
  it('renders batch notes for a French viewer in one batched call', async () => {
    queueSelect('livestock_batches', [
      storedBatch(),
      storedBatch({ id: 'batch-2', notes: 'Feeder number 3 broken, repaired with wire' }),
    ])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await (await livestockApp()).request('/livestock/batches')
    const body = (await res.json()) as { batches: Row[] }

    expect(res.status).toBe(200)
    expect(viewerBatchCalls).toHaveBeenCalledTimes(1)
    expect(selectLog.filter((table) => table === 'content_translations')).toHaveLength(1)
    expect(body.batches[0].notes).toBe(FRENCH_NOTES)
    expect(body.batches[1].notes).toBe('Mangeoire numéro 3 cassée, réparée avec du fil')
  })

  it('never sends the batch name, species or plot name to the translator', async () => {
    queueSelect('livestock_batches', [storedBatch()])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await (await livestockApp()).request('/livestock/batches')
    const batch = ((await res.json()) as { batches: Row[] }).batches[0]

    expect(batch).toMatchObject({
      name: 'Shed A',
      species: 'noiler',
      plotName: 'Block A',
      headCount: 480,
      active: true,
    })
    expect(viewerBatchCalls).toHaveBeenCalledWith(
      expect.objectContaining({ texts: [ENGLISH_NOTES] }),
    )
  })

  it('does no translation work at all for an English viewer', async () => {
    queueSelect('livestock_batches', [storedBatch(), storedBatch({ id: 'batch-2' })])
    queueSelect('users', [{ preferredLocale: 'en' }])

    const res = await (await livestockApp()).request('/livestock/batches')
    const body = (await res.json()) as { batches: Row[] }

    expect(viewerBatchCalls).not.toHaveBeenCalled()
    expect(completeChat).not.toHaveBeenCalled()
    expect(selectLog).not.toContain('content_translations')
    expect(body.batches[0].notes).toBe(ENGLISH_NOTES)
  })

  it('reads 40 batches with one batched call and one call per distinct string', async () => {
    queueSelect(
      'livestock_batches',
      Array.from({ length: 40 }, (_, index) => storedBatch({ id: `batch-${index}` })),
    )
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await (await livestockApp()).request('/livestock/batches')
    const body = (await res.json()) as { batches: Row[] }

    expect(body.batches).toHaveLength(40)
    expect(viewerBatchCalls).toHaveBeenCalledTimes(1)
    expect(completeChat).toHaveBeenCalledTimes(1)
    expect(body.batches[39].notes).toBe(FRENCH_NOTES)
  })
})

describe('GET /livestock/batches/:id/logs - viewer locale on read', () => {
  it('renders log notes for a French viewer in one batched call', async () => {
    queueSelect('livestock_batches', [batchRow('noiler')])
    queueSelect('livestock_logs', [
      { id: 'log-1', logType: 'incident', notes: ENGLISH_NOTES, headCount: null },
      {
        id: 'log-2',
        logType: 'vaccination',
        notes: 'Gumboro vaccine given to the whole batch',
        headCount: null,
      },
    ])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await (await livestockApp()).request(`/livestock/batches/${BATCH_ID}/logs`)
    const body = (await res.json()) as { logs: Row[] }

    expect(res.status).toBe(200)
    expect(viewerBatchCalls).toHaveBeenCalledTimes(1)
    expect(body.logs[0].notes).toBe(FRENCH_NOTES)
    expect(body.logs[1].notes).toBe('Vaccin Gumboro donné à tout le lot')
    // The log type is an enum the client renders, never prose.
    expect(body.logs[1].logType).toBe('vaccination')
  })

  it('does no translation work at all for an English viewer', async () => {
    queueSelect('livestock_batches', [batchRow('noiler')])
    queueSelect('livestock_logs', [{ id: 'log-1', logType: 'incident', notes: ENGLISH_NOTES }])
    queueSelect('users', [{ preferredLocale: 'en' }])

    await (await livestockApp()).request(`/livestock/batches/${BATCH_ID}/logs`)

    expect(viewerBatchCalls).not.toHaveBeenCalled()
    expect(selectLog).not.toContain('content_translations')
  })
})

describe('GET /livestock/batches/:id - viewer locale on read', () => {
  it('renders the notes for a French viewer and keeps the name and species', async () => {
    queueSelect('livestock_batches', [storedBatch()])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await (await livestockApp()).request(`/livestock/batches/${BATCH_ID}`)
    const body = (await res.json()) as { batch: Row }

    expect(res.status).toBe(200)
    expect(viewerBatchCalls).toHaveBeenCalledTimes(1)
    expect(body.batch.notes).toBe(FRENCH_NOTES)
    expect(body.batch).toMatchObject({ name: 'Shed A', species: 'noiler' })
  })
})

describe('POST /livestock/batches - establishing the agronomy', () => {
  it('asks for a calendar for the species the farmer entered', async () => {
    const res = await createBatch('Noiler chicken')

    expect(res.status).toBe(201)
    expect(generateBatchAgronomy).toHaveBeenCalledWith(
      expect.objectContaining({ farmId: 'farm-1', species: 'noiler', headCount: 500 }),
    )
  })

  it('registers the batch even when generation throws', async () => {
    generateBatchAgronomy.mockRejectedValue(new Error('upstream 503'))

    const res = await createBatch('Noiler chicken')

    // The flock exists whether or not a model was reachable at the shed door.
    expect(res.status).toBe(201)
    expect(insertedBatch()).toMatchObject({ species: 'noiler' })
  })

  it('registers the batch when generation declines to write anything', async () => {
    generateBatchAgronomy.mockResolvedValue({ generated: false, reason: 'llm_unavailable' })

    expect((await createBatch('Kuroiler cockerel')).status).toBe(201)
  })
})

describe('POST /livestock/batches/:id/vaccination-schedule', () => {
  async function addEntry(body: Row, locale = 'fr') {
    queueSelect('livestock_batches', [batchRow('noiler', 'noiler')])
    queueSelect('users', [{ preferredLocale: locale }])
    return (await livestockApp()).request(`/livestock/batches/${BATCH_ID}/vaccination-schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  function insertedEntry(): Row {
    const row = inserted.find((entry) => entry.table === 'livestock_schedule_entries')
    expect(row).toBeDefined()
    return row!.values
  }

  it('stores what a farmer wrote in English and marks it the farm own', async () => {
    const res = await addEntry({
      dayOffset: 7,
      name: 'Vaccin Gumboro donné à tout le lot',
      vaccine: 'Vaccin Gumboro vivant',
    })

    expect(res.status).toBe(201)
    // Both prose columns are normalized, and one locale pair describes the row.
    expect(insertedEntry()).toMatchObject({
      dayOffset: 7,
      name: 'Gumboro vaccine given to the whole batch',
      vaccine: 'Gumboro live vaccine',
      source: 'manual',
      sourceLocale: 'fr',
      translationStatus: 'done',
    })
  })

  it('stores the original as pending when the translator is unavailable', async () => {
    isLlmConfigured.mockReturnValue(false)

    const res = await addEntry({ dayOffset: 7, name: 'Vaccin Gumboro donné à tout le lot' })

    expect(res.status).toBe(201)
    expect(insertedEntry()).toMatchObject({
      name: 'Vaccin Gumboro donné à tout le lot',
      translationStatus: 'pending',
    })
  })

  it('returns the author their own words while storing the English', async () => {
    const res = await addEntry({ dayOffset: 7, name: 'Vaccin Gumboro donné à tout le lot' })
    const body = (await res.json()) as { entry: Row }

    expect(body.entry.name).toBe('Vaccin Gumboro donné à tout le lot')
  })

  // The same bounds the generator is held to: a date a model may not invent is
  // not one a person may type in either.
  const rejected: [string, Row][] = [
    ['a day offset past the end of any cycle', { dayOffset: 401, name: 'Newcastle booster' }],
    ['a negative day offset', { dayOffset: -1, name: 'Newcastle booster' }],
    ['a fractional day offset', { dayOffset: 7.5, name: 'Newcastle booster' }],
    ['an empty name', { dayOffset: 7, name: '   ' }],
    ['a name longer than the column allows', { dayOffset: 7, name: 'x'.repeat(201) }],
    ['a vaccine longer than the column allows', {
      dayOffset: 7,
      name: 'Gumboro (IBD)',
      vaccine: 'x'.repeat(201),
    }],
    ['no day offset at all', { name: 'Gumboro (IBD)' }],
  ]

  for (const [label, body] of rejected) {
    it(`rejects ${label}`, async () => {
      expect((await addEntry(body)).status).toBe(400)
      expect(inserted).toHaveLength(0)
    })
  }

  it('scopes the batch it writes against to the caller farm', async () => {
    await addEntry({ dayOffset: 7, name: 'Gumboro (IBD)' })

    expect(whereParams('livestock_batches')).toContain('farm-1')
  })

  it('stops explaining an empty calendar once the farm has written one', async () => {
    await addEntry({ dayOffset: 7, name: 'Gumboro (IBD)' })

    expect(batchPatch()).toEqual({ agronomySkipReason: null })
  })

  it('is a 404 for a batch on another farm', async () => {
    queueSelect('livestock_batches', [])
    queueSelect('users', [{ preferredLocale: 'en' }])

    const res = await (await livestockApp()).request(
      `/livestock/batches/${BATCH_ID}/vaccination-schedule`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dayOffset: 7, name: 'Gumboro (IBD)' }),
      },
    )

    expect(res.status).toBe(404)
    expect(inserted).toHaveLength(0)
  })

  it('refuses a field worker', async () => {
    const res = await asFieldWorker(() => addEntry({ dayOffset: 7, name: 'Gumboro (IBD)' }))

    expect(res.status).toBe(403)
    expect(inserted).toHaveLength(0)
  })
})

describe('PATCH /livestock/batches/:id/vaccination-schedule/:entryId', () => {
  async function editEntry(body: Row, existing: Row | null = entryRow(), locale = 'fr') {
    queueSelect('livestock_schedule_entries', existing ? [existing] : [])
    queueSelect('users', [{ preferredLocale: locale }])
    return (await livestockApp()).request(
      `/livestock/batches/${BATCH_ID}/vaccination-schedule/${ENTRY_ID}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    )
  }

  function entryPatch(): Row {
    const row = updated.find((entry) => entry.table === 'livestock_schedule_entries')
    expect(row).toBeDefined()
    return row!.values
  }

  it('takes ownership of a generated entry the farm corrected', async () => {
    const res = await editEntry({ name: 'Vaccin Gumboro donné à tout le lot' })

    expect(res.status).toBe(200)
    expect(entryPatch()).toMatchObject({
      name: 'Gumboro vaccine given to the whole batch',
      source: 'manual',
      sourceLocale: 'fr',
      translationStatus: 'done',
    })
  })

  it('moves a date without touching the prose bookkeeping', async () => {
    const res = await editEntry({ dayOffset: 12 })

    expect(res.status).toBe(200)
    expect(canonicalCalls).not.toHaveBeenCalled()
    expect(entryPatch()).toMatchObject({ dayOffset: 12, source: 'manual' })
    expect(entryPatch()).not.toHaveProperty('translationStatus')
  })

  it('rejects values outside the bounds the generator is held to', async () => {
    for (const body of [{ dayOffset: 401 }, { dayOffset: -1 }, { name: 'x'.repeat(201) }]) {
      updated.length = 0
      expect((await editEntry(body)).status).toBe(400)
      expect(updated).toHaveLength(0)
    }
  })

  it('refuses an empty edit rather than relabelling the row for nothing', async () => {
    expect((await editEntry({})).status).toBe(400)
    expect(updated).toHaveLength(0)
  })

  it('is a 404 for an entry on another farm', async () => {
    const res = await editEntry({ dayOffset: 12 }, null)

    expect(res.status).toBe(404)
    expect(updated).toHaveLength(0)
  })

  it('stops explaining an empty calendar once the farm has corrected one', async () => {
    await editEntry({ dayOffset: 12 })

    expect(batchPatch()).toEqual({ agronomySkipReason: null })
  })

  it('scopes the entry lookup to the caller farm and batch', async () => {
    await editEntry({ dayOffset: 12 })

    const params = whereParams('livestock_schedule_entries')
    expect(params).toContain('farm-1')
    expect(params).toContain(BATCH_ID)
  })

  it('refuses a field worker', async () => {
    const res = await asFieldWorker(() => editEntry({ dayOffset: 12 }))

    expect(res.status).toBe(403)
    expect(updated).toHaveLength(0)
  })
})

describe('DELETE /livestock/batches/:id/vaccination-schedule/:entryId', () => {
  async function removeEntry(existing: Row | null = entryRow()) {
    queueSelect('livestock_schedule_entries', existing ? [existing] : [])
    return (await livestockApp()).request(
      `/livestock/batches/${BATCH_ID}/vaccination-schedule/${ENTRY_ID}`,
      { method: 'DELETE' },
    )
  }

  it('removes an entry the farm no longer wants', async () => {
    const res = await removeEntry()

    expect(res.status).toBe(200)
    expect(deleted).toEqual(['livestock_schedule_entries'])
  })

  it('is a 404 for an entry on another farm', async () => {
    const res = await removeEntry(null)

    expect(res.status).toBe(404)
    expect(deleted).toHaveLength(0)
  })

  it('refuses a field worker', async () => {
    const res = await asFieldWorker(() => removeEntry())

    expect(res.status).toBe(403)
    expect(deleted).toHaveLength(0)
  })
})

describe('PATCH /livestock/batches/:id/growth-curve', () => {
  const validCurve = {
    startWeightKg: 0.04,
    targetWeightKg: 2.5,
    dailyGainKg: 0.05,
    cycleDays: 49,
  }

  async function setCurve(body: Row, existing: Row | null = batchRow('noiler', 'noiler')) {
    queueSelect('livestock_batches', existing ? [existing] : [])
    return (await livestockApp()).request(`/livestock/batches/${BATCH_ID}/growth-curve`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('stores the farm own figures at the scale the columns hold', async () => {
    const res = await setCurve(validCurve)

    expect(res.status).toBe(200)
    expect(batchPatch()).toEqual({
      startWeightKg: '0.040',
      targetWeightKg: '2.500',
      dailyGainKg: '0.0500',
      cycleDays: 49,
      // Nothing regenerates over the figures the person who knows the birds gave.
      agronomySource: 'manual',
      // And nothing explains an empty curve over one the farm just typed.
      agronomySkipReason: null,
    })
  })

  const rejected: [string, Row][] = [
    ['a start weight below the floor', { ...validCurve, startWeightKg: 0.005 }],
    ['a start weight above the ceiling', { ...validCurve, startWeightKg: 6 }],
    ['a target weight below the floor', { ...validCurve, targetWeightKg: 0.04 }],
    ['a target weight above the ceiling', { ...validCurve, targetWeightKg: 21 }],
    ['a daily gain below the floor', { ...validCurve, dailyGainKg: 0.0001 }],
    ['a daily gain above the ceiling', { ...validCurve, dailyGainKg: 0.6 }],
    ['a cycle shorter than a week', { ...validCurve, cycleDays: 6 }],
    ['a cycle longer than a year and a month', { ...validCurve, cycleDays: 401 }],
    ['a fractional cycle length', { ...validCurve, cycleDays: 49.5 }],
    ['a target no greater than the start weight', { ...validCurve, targetWeightKg: 0.04 }],
    ['figures that do not describe the same animal', { ...validCurve, cycleDays: 400 }],
    ['three of the four figures', { startWeightKg: 0.04, targetWeightKg: 2.5, cycleDays: 49 }],
  ]

  for (const [label, body] of rejected) {
    it(`rejects ${label}`, async () => {
      expect((await setCurve(body)).status).toBe(400)
      expect(updated).toHaveLength(0)
    })
  }

  it('is a 404 for a batch on another farm', async () => {
    const res = await setCurve(validCurve, null)

    expect(res.status).toBe(404)
    expect(updated).toHaveLength(0)
  })

  it('refuses a field worker', async () => {
    const res = await asFieldWorker(() => setCurve(validCurve))

    expect(res.status).toBe(403)
    expect(updated).toHaveLength(0)
  })
})

describe('POST /livestock/batches/:id/agronomy/regenerate', () => {
  async function regenerate(existing: Row | null = batchRow('noiler', 'noiler')) {
    queueSelect('livestock_batches', existing ? [existing] : [])
    return (await livestockApp()).request(`/livestock/batches/${BATCH_ID}/agronomy/regenerate`, {
      method: 'POST',
    })
  }

  it('reports what the generator did', async () => {
    const res = await regenerate()

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ generated: true, entryCount: 3 })
    expect(generateBatchAgronomy).toHaveBeenCalledWith(
      expect.objectContaining({ farmId: 'farm-1', species: 'noiler' }),
    )
  })

  it('reports why nothing was written rather than failing', async () => {
    generateBatchAgronomy.mockResolvedValue({ generated: false, reason: 'budget_exhausted' })

    const res = await regenerate()

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ generated: false, reason: 'budget_exhausted' })
  })

  it('is a 404 for a batch on another farm', async () => {
    expect((await regenerate(null)).status).toBe(404)
    expect(generateBatchAgronomy).not.toHaveBeenCalled()
  })

  it('refuses a field worker', async () => {
    const res = await asFieldWorker(() => regenerate())

    expect(res.status).toBe(403)
    expect(generateBatchAgronomy).not.toHaveBeenCalled()
  })
})
