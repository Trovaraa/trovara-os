import { Hono } from 'hono'
import { getTableName } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, unknown>

const nameOf = (table: unknown) => getTableName(table as never)

let sessionUser: Row = {
  id: 'user-sup',
  farmId: 'farm-1',
  role: 'supervisor',
  name: 'Sup',
  email: 'sup@trovara.farm',
}

/** Rows the fake db returns, queued per table so query order does not matter. */
const selectQueue = new Map<string, Row[][]>()
const selectLog: string[] = []
const inserted: { table: string; values: Row }[] = []
const updates: { table: string; patch: Row }[] = []
/** Columns the updated row still carries beyond the patch itself. */
let updatedRow: Row = {}

function queueSelect(table: string, rows: Row[]) {
  const queued = selectQueue.get(table) ?? []
  queued.push(rows)
  selectQueue.set(table, queued)
}

vi.mock('../db/index.js', () => {
  const selectChain = () => {
    let rows: Row[] = []
    const self: Record<string, unknown> = {}
    const same = () => self
    Object.assign(self, {
      from: (table: unknown) => {
        const name = nameOf(table)
        selectLog.push(name)
        rows = selectQueue.get(name)?.shift() ?? []
        return self
      },
      leftJoin: same,
      innerJoin: same,
      where: same,
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
            returning: async () => [{ id: 'block-new', ...values }],
            onConflictDoNothing: async () => undefined,
          }
        },
      }),
      update: (table: unknown) => ({
        set: (patch: Row) => {
          updates.push({ table: nameOf(table), patch })
          return {
            where: () => ({
              returning: async () => [{ id: 'plot-1', ...updatedRow, ...patch }],
            }),
          }
        },
      }),
    },
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
 * the tests see its real short-circuits. The spies count how often the routes
 * enter the service at all.
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

const ENGLISH_TO_FRENCH: Record<string, string> = {
  'Waterlogged corner near the fence': 'Coin gorgé d’eau près de la clôture',
  'Replant the gaps after the rains': 'Replanter les trous après les pluies',
  'The nursery block beside the borehole': 'Le bloc pépinière à côté du forage',
}

const FRENCH_TO_ENGLISH: Record<string, string> = Object.fromEntries(
  Object.entries(ENGLISH_TO_FRENCH).map(([english, french]) => [french, english]),
)

const FRENCH_NOTES = 'Coin gorgé d’eau près de la clôture'
const ENGLISH_NOTES = 'Waterlogged corner near the fence'
const FRENCH_DESCRIPTION = 'Le bloc pépinière à côté du forage'
const ENGLISH_DESCRIPTION = 'The nursery block beside the borehole'

const ZONE_ID = '11111111-1111-4111-8111-111111111111'

function blockRow(overrides: Row = {}): Row {
  return {
    id: 'plot-1',
    name: 'Block A',
    code: 'BLK-A',
    notes: 'Waterlogged corner near the fence',
    zoneId: 'zone-1',
    zoneName: 'North Zone',
    cropType: 'coconut',
    cropVariety: 'Malayan Dwarf',
    areaAcres: '2.5',
    plantCount: 120,
    latitude: '6.5244',
    longitude: '3.3792',
    active: true,
    archivedAt: null,
    createdAt: new Date('2026-07-01T08:00:00Z'),
    updatedAt: new Date('2026-07-01T08:00:00Z'),
    sourceLocale: null,
    translationStatus: 'done',
    ...overrides,
  }
}

async function app() {
  const { zoneRoutes } = await import('./zones.js')
  const instance = new Hono()
  instance.route('/zones', zoneRoutes)
  return instance
}

function insertedBlock(): Row {
  const row = inserted.find((entry) => entry.table === 'plots')
  expect(row).toBeDefined()
  return row!.values
}

function blockPatch(): Row {
  const row = updates.find((entry) => entry.table === 'plots')
  expect(row).toBeDefined()
  return row!.patch
}

function insertedZone(): Row {
  const row = inserted.find((entry) => entry.table === 'zones')
  expect(row).toBeDefined()
  return row!.values
}

function zonePatch(): Row {
  const row = updates.find((entry) => entry.table === 'zones')
  expect(row).toBeDefined()
  return row!.patch
}

/** Every string the translator was actually handed, in call order. */
function translatedTexts(): string[] {
  return completeChat.mock.calls.map((call) => call[1] as string)
}

/** A stored zone row: the description column already holds canonical English. */
function zoneRow(overrides: Row = {}): Row {
  return {
    id: 'zone-1',
    name: 'North Zone',
    description: ENGLISH_DESCRIPTION,
    sourceLocale: null,
    translationStatus: 'done',
    ...overrides,
  }
}

async function createBlock(body: Row, preferredLocale = 'fr') {
  queueSelect('zones', [{ id: 'zone-1' }])
  queueSelect('users', [{ preferredLocale }])
  return (await app()).request('/zones/plots', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ zoneId: ZONE_ID, name: 'Block A', ...body }),
  })
}

async function patchBlock(body: Row, existing: Row = blockRow(), preferredLocale = 'fr') {
  queueSelect('plots', [existing])
  queueSelect('users', [{ preferredLocale }])
  return (await app()).request('/zones/plots/plot-1', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function createZone(body: Row, preferredLocale = 'fr') {
  queueSelect('users', [{ preferredLocale }])
  return (await app()).request('/zones', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'North Zone', ...body }),
  })
}

async function patchZone(body: Row, existing: Row = zoneRow(), preferredLocale = 'fr') {
  queueSelect('zones', [existing])
  queueSelect('users', [{ preferredLocale }])
  return (await app()).request('/zones/zone-1', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  selectQueue.clear()
  selectLog.length = 0
  inserted.length = 0
  updates.length = 0
  updatedRow = {}
  isLlmConfigured.mockReturnValue(true)
  completeChat.mockImplementation(async (system: string, text: string) => {
    const table = /into English/i.test(system) ? FRENCH_TO_ENGLISH : ENGLISH_TO_FRENCH
    return { text: table[text] ?? `[${text}]`, model: 'test' }
  })
  sessionUser = {
    id: 'user-sup',
    farmId: 'farm-1',
    role: 'supervisor',
    name: 'Sup',
    email: 'sup@trovara.farm',
  }
})

describe('POST /zones/plots - canonical crop type on write', () => {
  it('stores a French crop name under its English lookup key', async () => {
    queueSelect('zones', [{ id: 'zone-1' }])

    const res = await (await app()).request('/zones/plots', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        zoneId: '11111111-1111-4111-8111-111111111111',
        name: 'Block A',
        cropType: 'noix de coco',
      }),
    })

    expect(res.status).toBe(201)
    expect(insertedBlock().cropType).toBe('coconut')
  })

  it('keeps the default when no crop is given and stores unknown crops as typed', async () => {
    queueSelect('zones', [{ id: 'zone-1' }])
    queueSelect('zones', [{ id: 'zone-1' }])
    const instance = await app()

    await instance.request('/zones/plots', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ zoneId: '11111111-1111-4111-8111-111111111111', name: 'Block B' }),
    })
    await instance.request('/zones/plots', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        zoneId: '11111111-1111-4111-8111-111111111111',
        name: 'Block C',
        cropType: 'maïs',
      }),
    })

    const blocks = inserted.filter((entry) => entry.table === 'plots')
    expect(blocks[0].values.cropType).toBe('mixed')
    expect(blocks[1].values.cropType).toBe('maïs')
  })
})

describe('PATCH /zones/plots/:plotId - canonical crop type on write', () => {
  it('normalizes a Yoruba crop name on update', async () => {
    queueSelect('plots', [blockRow()])

    const res = await (await app()).request('/zones/plots/plot-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cropType: 'ọgẹdẹ àgbagbà' }),
    })

    expect(res.status).toBe(200)
    expect(blockPatch().cropType).toBe('plantain')
  })
})

describe('GET /zones/plots - viewer locale on read', () => {
  it('renders block notes for a French viewer in one batched call', async () => {
    queueSelect('plots', [
      blockRow(),
      blockRow({ id: 'plot-2', name: 'Block B', notes: 'Replant the gaps after the rains' }),
    ])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await (await app()).request('/zones/plots')
    const body = (await res.json()) as { plots: Row[]; blocks: Row[] }

    expect(res.status).toBe(200)
    expect(viewerBatchCalls).toHaveBeenCalledTimes(1)
    expect(selectLog.filter((table) => table === 'content_translations')).toHaveLength(1)
    expect(body.plots[0].notes).toBe('Coin gorgé d’eau près de la clôture')
    expect(body.plots[1].notes).toBe('Replanter les trous après les pluies')
    expect(body.blocks[0].notes).toBe(body.plots[0].notes)
  })

  it('leaves names, codes, crop types, areas and coordinates untouched', async () => {
    queueSelect('plots', [blockRow()])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await (await app()).request('/zones/plots')
    const body = (await res.json()) as { plots: Row[] }

    expect(body.plots[0]).toMatchObject({
      name: 'Block A',
      code: 'BLK-A',
      zoneName: 'North Zone',
      cropType: 'coconut',
      cropVariety: 'Malayan Dwarf',
      areaAcres: '2.5',
      plantCount: 120,
      latitude: '6.5244',
    })
    expect(viewerBatchCalls).toHaveBeenCalledWith(
      expect.objectContaining({ texts: ['Waterlogged corner near the fence'] }),
    )
  })

  it('does no translation work at all for an English viewer', async () => {
    queueSelect('plots', [blockRow(), blockRow({ id: 'plot-2' })])
    queueSelect('users', [{ preferredLocale: 'en' }])

    const res = await (await app()).request('/zones/plots')
    const body = (await res.json()) as { plots: Row[] }

    expect(viewerBatchCalls).not.toHaveBeenCalled()
    expect(completeChat).not.toHaveBeenCalled()
    expect(selectLog).not.toContain('content_translations')
    expect(body.plots[0].notes).toBe('Waterlogged corner near the fence')
  })
})

describe('GET /zones - viewer locale on read', () => {
  it('renders zone descriptions for a French viewer and keeps zone names', async () => {
    queueSelect('zones', [
      {
        id: 'zone-1',
        name: 'North Zone',
        description: 'The nursery block beside the borehole',
        sourceLocale: null,
        translationStatus: 'done',
      },
    ])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await (await app()).request('/zones')
    const body = (await res.json()) as { zones: Row[] }

    expect(res.status).toBe(200)
    expect(viewerBatchCalls).toHaveBeenCalledTimes(1)
    expect(body.zones[0].description).toBe('Le bloc pépinière à côté du forage')
    expect(body.zones[0].name).toBe('North Zone')
  })

  it('does no translation work at all for an English viewer', async () => {
    queueSelect('zones', [
      { id: 'zone-1', name: 'North Zone', description: 'The nursery block beside the borehole' },
    ])
    queueSelect('users', [{ preferredLocale: 'en' }])

    await (await app()).request('/zones')

    expect(viewerBatchCalls).not.toHaveBeenCalled()
    expect(selectLog).not.toContain('content_translations')
  })
})

describe('GET /zones/plots/:plotId/timeline - viewer locale on read', () => {
  it('renders task titles for a French viewer but not machine event types', async () => {
    queueSelect('plots', [blockRow()])
    queueSelect('tasks', [
      {
        id: 'task-1',
        kind: 'completed',
        title: 'Replant the gaps after the rains',
        status: 'completed',
        eventType: 'completed',
        createdAt: new Date('2026-07-02T08:00:00Z'),
      },
    ])
    queueSelect('crop_cycles', [])
    queueSelect('farm_events', [
      {
        id: 'event-1',
        kind: 'planted',
        title: 'planted',
        status: 'approved',
        eventType: 'planted',
        createdAt: new Date('2026-07-01T08:00:00Z'),
      },
    ])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await (await app()).request('/zones/plots/plot-1/timeline')
    const body = (await res.json()) as { timeline: Row[] }

    expect(res.status).toBe(200)
    expect(viewerBatchCalls).toHaveBeenCalledTimes(1)
    expect(viewerBatchCalls).toHaveBeenCalledWith(
      expect.objectContaining({ texts: ['Replant the gaps after the rains'] }),
    )
    expect(body.timeline[0].title).toBe('Replanter les trous après les pluies')
    expect(body.timeline[1].title).toBe('planted')
    expect(body.timeline[1].eventType).toBe('planted')
  })
})

describe('POST /zones/plots - canonical English on write', () => {
  it('stores French block notes in English with the author locale', async () => {
    const res = await createBlock({ notes: FRENCH_NOTES })

    expect(res.status).toBe(201)
    expect(insertedBlock()).toMatchObject({
      notes: ENGLISH_NOTES,
      sourceLocale: 'fr',
      translationStatus: 'done',
    })
  })

  it('detects the language of the text when the author is on the default preference', async () => {
    // The 'en' default means "nobody chose a language", not "this is English":
    // labelling this row 'en'/'done' would hide French notes from the retry job.
    const res = await createBlock({ notes: FRENCH_NOTES }, 'en')

    expect(res.status).toBe(201)
    expect(insertedBlock()).toMatchObject({ notes: ENGLISH_NOTES, sourceLocale: 'fr' })
  })

  it('leaves the block name, code, crop type and coordinates verbatim', async () => {
    await createBlock({
      notes: FRENCH_NOTES,
      code: 'BLK-A',
      cropType: 'noix de coco',
      cropVariety: 'Malayan Dwarf',
      areaAcres: '2.5',
      latitude: '6.5244',
    })

    expect(insertedBlock()).toMatchObject({
      name: 'Block A',
      code: 'BLK-A',
      // The deterministic lexicon, not the translator: an exact lookup key.
      cropType: 'coconut',
      cropVariety: 'Malayan Dwarf',
      areaAcres: '2.5',
      latitude: '6.5244',
    })
    expect(translatedTexts()).toEqual([FRENCH_NOTES])
  })

  it('returns the author their own words while storing the English', async () => {
    const res = await createBlock({ notes: FRENCH_NOTES })
    const body = (await res.json()) as { plot: Row; block: Row }

    expect(body.plot.notes).toBe(FRENCH_NOTES)
    expect(body.block.notes).toBe(FRENCH_NOTES)
    expect(insertedBlock().notes).toBe(ENGLISH_NOTES)
  })

  it('stores the original as pending and still succeeds when the LLM is unavailable', async () => {
    isLlmConfigured.mockReturnValue(false)

    const res = await createBlock({ notes: FRENCH_NOTES })

    expect(res.status).toBe(201)
    expect(insertedBlock()).toMatchObject({
      notes: FRENCH_NOTES,
      sourceLocale: 'fr',
      translationStatus: 'pending',
    })
  })

  it('still succeeds and stays pending when the translator throws', async () => {
    completeChat.mockRejectedValue(new Error('upstream 503'))

    const res = await createBlock({ notes: FRENCH_NOTES })

    expect(res.status).toBe(201)
    expect(insertedBlock()).toMatchObject({ notes: FRENCH_NOTES, translationStatus: 'pending' })
  })

  it('makes no translation call at all for an English create', async () => {
    const res = await createBlock({ notes: ENGLISH_NOTES }, 'en')

    expect(res.status).toBe(201)
    expect(completeChat).not.toHaveBeenCalled()
    expect(insertedBlock()).toMatchObject({
      notes: ENGLISH_NOTES,
      sourceLocale: 'en',
      translationStatus: 'done',
    })
  })

  it('does not enter the translation service for a block with no notes', async () => {
    const res = await createBlock({})

    expect(res.status).toBe(201)
    expect(canonicalCalls).not.toHaveBeenCalled()
    // No prose, so the row keeps the schema defaults rather than being labelled.
    expect(insertedBlock()).not.toHaveProperty('sourceLocale')
    expect(insertedBlock()).not.toHaveProperty('translationStatus')
  })
})

describe('PATCH /zones/plots/:plotId - canonical English on write', () => {
  it('stores edited French notes in English and labels the row', async () => {
    const res = await patchBlock({ notes: FRENCH_NOTES })

    expect(res.status).toBe(200)
    expect(blockPatch()).toMatchObject({
      notes: ENGLISH_NOTES,
      sourceLocale: 'fr',
      translationStatus: 'done',
    })
  })

  it('escalates a settled row to pending when the notes could not be translated', async () => {
    isLlmConfigured.mockReturnValue(false)

    const res = await patchBlock({ notes: FRENCH_NOTES })

    expect(res.status).toBe(200)
    expect(blockPatch()).toMatchObject({
      notes: FRENCH_NOTES,
      sourceLocale: 'fr',
      translationStatus: 'pending',
    })
  })

  it('leaves the bookkeeping of a row that already owes a translation alone', async () => {
    const res = await patchBlock(
      { notes: FRENCH_NOTES },
      blockRow({ sourceLocale: 'yo', translationStatus: 'pending' }),
    )

    expect(res.status).toBe(200)
    expect(blockPatch().notes).toBe(ENGLISH_NOTES)
    // The retry job owns the pair until it clears the debt it recorded.
    expect(blockPatch()).not.toHaveProperty('translationStatus')
    expect(blockPatch()).not.toHaveProperty('sourceLocale')
  })

  it('does not relabel the row or call the LLM for a crop-type-only patch', async () => {
    const res = await patchBlock({ cropType: 'ọgẹdẹ àgbagbà' })

    expect(res.status).toBe(200)
    expect(blockPatch().cropType).toBe('plantain')
    expect(canonicalCalls).not.toHaveBeenCalled()
    expect(completeChat).not.toHaveBeenCalled()
    expect(blockPatch()).not.toHaveProperty('sourceLocale')
  })

  it('echoes the notes the author just submitted rather than translating twice', async () => {
    const res = await patchBlock({ notes: FRENCH_NOTES })
    const body = (await res.json()) as { plot: Row; block: Row }

    expect(body.plot.notes).toBe(FRENCH_NOTES)
    expect(body.block.notes).toBe(FRENCH_NOTES)
    expect(viewerBatchCalls).not.toHaveBeenCalled()
  })

  it('clears the notes without labelling the row when they are emptied', async () => {
    const res = await patchBlock({ notes: '   ' })

    expect(res.status).toBe(200)
    expect(blockPatch().notes).toBeNull()
    expect(canonicalCalls).not.toHaveBeenCalled()
  })
})

describe('POST /zones - canonical English on write', () => {
  it('stores a French zone description in English with the author locale', async () => {
    const res = await createZone({ description: FRENCH_DESCRIPTION })

    expect(res.status).toBe(201)
    expect(insertedZone()).toMatchObject({
      description: ENGLISH_DESCRIPTION,
      sourceLocale: 'fr',
      translationStatus: 'done',
    })
  })

  it('leaves the zone name verbatim as the proper noun it is', async () => {
    await createZone({ description: FRENCH_DESCRIPTION })

    expect(insertedZone().name).toBe('North Zone')
    expect(translatedTexts()).toEqual([FRENCH_DESCRIPTION])
  })

  it('returns the author their own words while storing the English', async () => {
    const res = await createZone({ description: FRENCH_DESCRIPTION })
    const body = (await res.json()) as { zone: Row }

    expect(body.zone.description).toBe(FRENCH_DESCRIPTION)
    expect(insertedZone().description).toBe(ENGLISH_DESCRIPTION)
  })

  it('stores the original as pending and still succeeds when the LLM is unavailable', async () => {
    isLlmConfigured.mockReturnValue(false)

    const res = await createZone({ description: FRENCH_DESCRIPTION })

    expect(res.status).toBe(201)
    expect(insertedZone()).toMatchObject({
      description: FRENCH_DESCRIPTION,
      sourceLocale: 'fr',
      translationStatus: 'pending',
    })
  })

  it('still succeeds and stays pending when the translator throws', async () => {
    completeChat.mockRejectedValue(new Error('upstream 503'))

    const res = await createZone({ description: FRENCH_DESCRIPTION })

    expect(res.status).toBe(201)
    expect(insertedZone()).toMatchObject({
      description: FRENCH_DESCRIPTION,
      translationStatus: 'pending',
    })
  })

  it('makes no translation call at all for an English create', async () => {
    const res = await createZone({ description: ENGLISH_DESCRIPTION }, 'en')

    expect(res.status).toBe(201)
    expect(completeChat).not.toHaveBeenCalled()
    expect(insertedZone()).toMatchObject({
      description: ENGLISH_DESCRIPTION,
      sourceLocale: 'en',
      translationStatus: 'done',
    })
  })

  it('does not enter the translation service for a zone with no description', async () => {
    const res = await createZone({})

    expect(res.status).toBe(201)
    expect(canonicalCalls).not.toHaveBeenCalled()
    // No prose, so the row keeps the schema defaults rather than being labelled.
    expect(insertedZone()).not.toHaveProperty('sourceLocale')
    expect(insertedZone()).not.toHaveProperty('translationStatus')
  })
})

describe('PATCH /zones/:id - canonical English on write', () => {
  it('stores an edited French description in English and labels the row', async () => {
    const res = await patchZone({ description: FRENCH_DESCRIPTION })

    expect(res.status).toBe(200)
    expect(zonePatch()).toMatchObject({
      description: ENGLISH_DESCRIPTION,
      sourceLocale: 'fr',
      translationStatus: 'done',
    })
  })

  it('escalates a settled row to pending when the description could not be translated', async () => {
    completeChat.mockRejectedValue(new Error('upstream 503'))

    const res = await patchZone({ description: FRENCH_DESCRIPTION })

    expect(res.status).toBe(200)
    expect(zonePatch()).toMatchObject({
      description: FRENCH_DESCRIPTION,
      sourceLocale: 'fr',
      translationStatus: 'pending',
    })
  })

  it('leaves the bookkeeping of a row that already owes a translation alone', async () => {
    const res = await patchZone(
      { description: FRENCH_DESCRIPTION },
      zoneRow({ sourceLocale: 'yo', translationStatus: 'pending' }),
    )

    expect(res.status).toBe(200)
    expect(zonePatch().description).toBe(ENGLISH_DESCRIPTION)
    // The retry job owns the pair until it clears the debt it recorded.
    expect(zonePatch()).not.toHaveProperty('translationStatus')
    expect(zonePatch()).not.toHaveProperty('sourceLocale')
  })

  it('does not relabel the row or call the LLM for a rename', async () => {
    const res = await patchZone({ name: 'South Zone' })

    expect(res.status).toBe(200)
    expect(zonePatch()).toEqual({ name: 'South Zone' })
    expect(canonicalCalls).not.toHaveBeenCalled()
    expect(completeChat).not.toHaveBeenCalled()
  })

  it('echoes the description the author just submitted rather than translating twice', async () => {
    const res = await patchZone({ description: FRENCH_DESCRIPTION })
    const body = (await res.json()) as { zone: Row }

    expect(body.zone.description).toBe(FRENCH_DESCRIPTION)
    expect(viewerBatchCalls).not.toHaveBeenCalled()
  })

  it('renders a description it did not write for the French viewer reading it', async () => {
    updatedRow = { description: ENGLISH_DESCRIPTION }

    const res = await patchZone({ name: 'South Zone' })
    const body = (await res.json()) as { zone: Row }

    expect(res.status).toBe(200)
    expect(body.zone.name).toBe('South Zone')
    expect(body.zone.description).toBe(FRENCH_DESCRIPTION)
    expect(viewerBatchCalls).toHaveBeenCalledTimes(1)
  })
})

describe('planting units - nothing on them is prose', () => {
  it('stores the label and unit type exactly as typed and calls no translator', async () => {
    queueSelect('plots', [{ id: 'plot-1', farmId: 'farm-1' }])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await (await app()).request('/zones/planting-units', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        plotId: '11111111-1111-4111-8111-111111111111',
        label: 'Rangée 12',
        unitType: 'row',
      }),
    })

    expect(res.status).toBe(201)
    expect(inserted.find((entry) => entry.table === 'planting_units')!.values).toMatchObject({
      label: 'Rangée 12',
      unitType: 'row',
      status: 'active',
    })
    expect(canonicalCalls).not.toHaveBeenCalled()
    expect(completeChat).not.toHaveBeenCalled()
  })
})
