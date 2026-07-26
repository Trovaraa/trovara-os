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
const updatedRows = new Map<string, Row>()

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

  const client = {
    select: selectChain,
    insert: (table: unknown) => ({
      values: (values: Row) => {
        const name = nameOf(table)
        inserted.push({ table: name, values })
        return {
          returning: async () => [{ id: `${name}-new`, ...values }],
          onConflictDoNothing: async () => undefined,
          then: (resolve: (value: unknown) => unknown) => Promise.resolve(undefined).then(resolve),
        }
      },
    }),
    update: (table: unknown) => ({
      set: (patch: Row) => {
        const name = nameOf(table)
        updates.push({ table: name, patch })
        return {
          where: () => ({
            returning: async () => [{ ...(updatedRows.get(name) ?? {}), ...patch }],
            then: (resolve: (value: unknown) => unknown) =>
              Promise.resolve(undefined).then(resolve),
          }),
        }
      },
    }),
    delete: () => ({ where: async () => undefined }),
  }

  return {
    db: {
      ...client,
      transaction: async (fn: (tx: typeof client) => unknown) => fn(client),
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
vi.mock('../lib/farm-events.js', () => ({ recordFarmEvent: vi.fn() }))
vi.mock('../lib/evidence-store.js', () => ({
  validateEvidenceRef: vi.fn(() => true),
  processEvidenceValue: vi.fn(async (_farmId: string, value: string | null) => value),
}))

const FRENCH_TO_ENGLISH: Record<string, string> = {
  'Moteur bruyant, vidange faite hier': 'Engine noisy, oil changed yesterday',
  'Rangé derrière le hangar à grains': 'Stored behind the grain shed',
  'Trois casques manquants après la récolte': 'Three helmets missing after the harvest',
  'Courroie remplacée par le mécanicien du village':
    'Belt replaced by the village mechanic',
}

const ENGLISH_TO_FRENCH: Record<string, string> = {
  'Engine noisy, oil changed yesterday': 'Moteur bruyant, vidange faite hier',
  'Stored behind the grain shed': 'Rangé derrière le hangar à grains',
  'Three helmets missing after the harvest': 'Trois casques manquants après la récolte',
  'Belt replaced by the village mechanic': 'Courroie remplacée par le mécanicien du village',
}

/** A create body whose identifiers must survive a translated write untouched. */
const FRENCH_ASSET = {
  name: 'Honda WB30 Pump',
  category: 'irrigation' as const,
  unit: 'unit',
  quantityOwned: 2,
  assetTag: 'TRV-AST-2026-014',
  manufacturer: 'Honda',
  model: 'WB30XT',
  serialNumber: 'SN-88213-A',
  currency: 'NGN',
  acquisitionCostMinor: 450_000,
  operationalStatus: 'operational',
  locationText: 'Rangé derrière le hangar à grains',
  notes: 'Moteur bruyant, vidange faite hier',
}

function assetRow(overrides: Row = {}): Row {
  return {
    id: 'asset-1',
    name: 'Honda WB30 Pump',
    category: 'irrigation',
    unit: 'unit',
    quantityOwned: 2,
    trackingMode: 'pool',
    assetTag: 'TRV-AST-2026-014',
    manufacturer: 'Honda',
    model: 'WB30XT',
    serialNumber: 'SN-88213-A',
    acquisitionCostMinor: 450_000,
    currency: 'NGN',
    zoneId: null,
    plotId: null,
    locationText: 'Stored behind the grain shed',
    operationalStatus: 'operational',
    assignedToId: 'user-worker',
    assignedToName: 'Bola',
    notes: 'Engine noisy, oil changed yesterday',
    sourceLocale: null,
    translationStatus: 'done',
    active: true,
    createdAt: new Date('2026-07-01T08:00:00Z'),
    ...overrides,
  }
}

function logRow(overrides: Row = {}): Row {
  return {
    id: 'log-1',
    assetId: 'asset-1',
    logDate: new Date('2026-07-20T08:00:00Z'),
    countAvailable: 2,
    countDamaged: 0,
    condition: 'good',
    note: 'Three helmets missing after the harvest',
    recordedById: 'user-worker',
    recordedByName: 'Bola',
    verificationStatus: 'verified',
    verifiedAt: new Date('2026-07-20T09:00:00Z'),
    createdAt: new Date('2026-07-20T08:05:00Z'),
    sourceLocale: null,
    translationStatus: 'done',
    ...overrides,
  }
}

function eventRow(overrides: Row = {}): Row {
  return {
    id: 'event-1',
    assetId: 'asset-1',
    farmId: 'farm-1',
    eventType: 'repair',
    eventDate: new Date('2026-07-18T08:00:00Z'),
    costMinor: 25_000,
    notes: 'Belt replaced by the village mechanic',
    sourceLocale: null,
    translationStatus: 'done',
    evidenceUrl: null,
    recordedById: 'user-sup',
    ...overrides,
  }
}

async function app() {
  const { assetRoutes } = await import('./assets.js')
  const instance = new Hono()
  instance.route('/assets', assetRoutes)
  return instance
}

async function send(path: string, method: 'POST' | 'PATCH', body: unknown) {
  return (await app()).request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function insertedInto(table: string): Row {
  const row = inserted.find((entry) => entry.table === table)
  expect(row).toBeDefined()
  return row!.values
}

function patchOf(table: string): Row {
  const row = updates.find((entry) => entry.table === table)
  expect(row).toBeDefined()
  return row!.patch
}

/** Every string the translator was actually handed, in call order. */
function translatedTexts(): string[] {
  return completeChat.mock.calls.map((call) => call[1] as string)
}

beforeEach(() => {
  vi.clearAllMocks()
  selectQueue.clear()
  selectLog.length = 0
  inserted.length = 0
  updates.length = 0
  updatedRows.clear()
  updatedRows.set('assets', assetRow())
  updatedRows.set('asset_logs', logRow())
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

describe('POST /assets - canonical English on write', () => {
  it('stores notes and location in English with the author locale', async () => {
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await send('/assets', 'POST', FRENCH_ASSET)

    expect(res.status).toBe(201)
    expect(insertedInto('assets')).toMatchObject({
      notes: 'Engine noisy, oil changed yesterday',
      locationText: 'Stored behind the grain shed',
      sourceLocale: 'fr',
      translationStatus: 'done',
    })
  })

  it('leaves the name, tag, serial, model, money and status enums verbatim', async () => {
    queueSelect('users', [{ preferredLocale: 'fr' }])

    await send('/assets', 'POST', FRENCH_ASSET)

    expect(insertedInto('assets')).toMatchObject({
      name: 'Honda WB30 Pump',
      assetTag: 'TRV-AST-2026-014',
      manufacturer: 'Honda',
      model: 'WB30XT',
      serialNumber: 'SN-88213-A',
      currency: 'NGN',
      acquisitionCostMinor: 450_000,
      category: 'irrigation',
      unit: 'unit',
      operationalStatus: 'operational',
    })
    // Notes and location are the only prose; nothing else reaches the translator.
    expect(translatedTexts().sort()).toEqual([
      'Moteur bruyant, vidange faite hier',
      'Rangé derrière le hangar à grains',
    ])
  })

  it('returns the author their own words while storing the English', async () => {
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await send('/assets', 'POST', FRENCH_ASSET)
    const body = (await res.json()) as { asset: Row }

    expect(body.asset.notes).toBe('Moteur bruyant, vidange faite hier')
    expect(body.asset.locationText).toBe('Rangé derrière le hangar à grains')
    expect(insertedInto('assets').notes).toBe('Engine noisy, oil changed yesterday')
  })

  it('stores the original as pending and still succeeds when the LLM is unavailable', async () => {
    isLlmConfigured.mockReturnValue(false)
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await send('/assets', 'POST', FRENCH_ASSET)

    expect(res.status).toBe(201)
    expect(insertedInto('assets')).toMatchObject({
      notes: 'Moteur bruyant, vidange faite hier',
      locationText: 'Rangé derrière le hangar à grains',
      sourceLocale: 'fr',
      translationStatus: 'pending',
    })
  })

  it('still succeeds and stays pending when the translator throws', async () => {
    completeChat.mockRejectedValue(new Error('upstream 503'))
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await send('/assets', 'POST', FRENCH_ASSET)

    expect(res.status).toBe(201)
    expect(insertedInto('assets')).toMatchObject({
      notes: 'Moteur bruyant, vidange faite hier',
      translationStatus: 'pending',
    })
  })

  it('marks the row pending when only the location fails', async () => {
    queueSelect('users', [{ preferredLocale: 'fr' }])
    completeChat.mockImplementation(async (_system: string, text: string) => {
      if (text === FRENCH_ASSET.locationText) throw new Error('upstream 503')
      return { text: FRENCH_TO_ENGLISH[text], model: 'test' }
    })

    const res = await send('/assets', 'POST', FRENCH_ASSET)

    expect(res.status).toBe(201)
    // One column pair covers the row, so a single failure leaves it all pending.
    expect(insertedInto('assets')).toMatchObject({
      notes: 'Engine noisy, oil changed yesterday',
      locationText: 'Rangé derrière le hangar à grains',
      translationStatus: 'pending',
    })
  })

  it('makes no translation call at all for an English create', async () => {
    queueSelect('users', [{ preferredLocale: 'en' }])

    const res = await send('/assets', 'POST', {
      ...FRENCH_ASSET,
      notes: 'Engine noisy, oil changed yesterday',
      locationText: 'Stored behind the grain shed',
    })

    expect(res.status).toBe(201)
    expect(completeChat).not.toHaveBeenCalled()
    expect(insertedInto('assets')).toMatchObject({
      sourceLocale: 'en',
      translationStatus: 'done',
    })
  })

  it('does not enter the translation service for a create with no prose', async () => {
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await send('/assets', 'POST', { name: 'Honda WB30 Pump' })

    expect(res.status).toBe(201)
    expect(canonicalCalls).not.toHaveBeenCalled()
    expect(insertedInto('assets')).toMatchObject({ notes: null, locationText: null })
  })
})

describe('PATCH /assets/:id - canonical English on write', () => {
  it('stores edited notes in English and labels the row with the author locale', async () => {
    queueSelect('assets', [assetRow()])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await send('/assets/asset-1', 'PATCH', {
      notes: 'Moteur bruyant, vidange faite hier',
    })

    expect(res.status).toBe(200)
    expect(patchOf('assets')).toMatchObject({
      notes: 'Engine noisy, oil changed yesterday',
      sourceLocale: 'fr',
      translationStatus: 'done',
    })
  })

  it('renames an asset without relabelling the row or translating the name', async () => {
    queueSelect('assets', [assetRow()])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await send('/assets/asset-1', 'PATCH', { name: 'Honda WB30 Pump 2' })

    expect(res.status).toBe(200)
    const values = patchOf('assets')
    expect(values.name).toBe('Honda WB30 Pump 2')
    expect(values).not.toHaveProperty('sourceLocale')
    expect(values).not.toHaveProperty('translationStatus')
    expect(canonicalCalls).not.toHaveBeenCalled()
  })

  it('never downgrades a row the retry job still owes work on', async () => {
    queueSelect('assets', [assetRow({ sourceLocale: 'yo', translationStatus: 'pending' })])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    await send('/assets/asset-1', 'PATCH', { notes: 'Moteur bruyant, vidange faite hier' })

    const values = patchOf('assets')
    expect(values.notes).toBe('Engine noisy, oil changed yesterday')
    expect(values).not.toHaveProperty('translationStatus')
    expect(values).not.toHaveProperty('sourceLocale')
  })

  it('echoes edited text and localizes only what this author did not write', async () => {
    queueSelect('assets', [assetRow()])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await send('/assets/asset-1', 'PATCH', {
      notes: 'Moteur bruyant, vidange faite hier',
    })
    const body = (await res.json()) as { asset: Row }

    expect(body.asset.notes).toBe('Moteur bruyant, vidange faite hier')
    expect(body.asset.locationText).toBe('Rangé derrière le hangar à grains')
    expect(viewerBatchCalls).toHaveBeenCalledTimes(1)
    expect(viewerBatchCalls).toHaveBeenCalledWith(
      expect.objectContaining({ texts: ['Stored behind the grain shed'] }),
    )
  })
})

describe('asset logs and events - canonical English on write', () => {
  it('stores a French daily log note in English and leaves the condition key alone', async () => {
    queueSelect('assets', [{ id: 'asset-1', name: 'Honda WB30 Pump', quantityOwned: 5 }])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await send('/assets/asset-1/logs', 'POST', {
      countAvailable: 2,
      countDamaged: 3,
      condition: 'damaged',
      note: 'Trois casques manquants après la récolte',
    })

    expect(res.status).toBe(201)
    expect(insertedInto('asset_logs')).toMatchObject({
      note: 'Three helmets missing after the harvest',
      condition: 'damaged',
      countAvailable: 2,
      countDamaged: 3,
      sourceLocale: 'fr',
      translationStatus: 'done',
    })
    expect(translatedTexts()).toEqual(['Trois casques manquants après la récolte'])
  })

  it('stores the worker their own log note as pending when the LLM is unavailable', async () => {
    isLlmConfigured.mockReturnValue(false)
    queueSelect('assets', [{ id: 'asset-1', name: 'Honda WB30 Pump', quantityOwned: 5 }])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await send('/assets/asset-1/logs', 'POST', {
      countAvailable: 5,
      note: 'Trois casques manquants après la récolte',
    })
    const body = (await res.json()) as { log: Row }

    expect(res.status).toBe(201)
    expect(insertedInto('asset_logs')).toMatchObject({
      note: 'Trois casques manquants après la récolte',
      translationStatus: 'pending',
    })
    expect(body.log.note).toBe('Trois casques manquants après la récolte')
  })

  it('makes no translation call for an English log note', async () => {
    queueSelect('assets', [{ id: 'asset-1', name: 'Honda WB30 Pump', quantityOwned: 5 }])
    queueSelect('users', [{ preferredLocale: 'en' }])

    const res = await send('/assets/asset-1/logs', 'POST', {
      countAvailable: 5,
      note: 'Three helmets missing after the harvest',
    })

    expect(res.status).toBe(201)
    expect(completeChat).not.toHaveBeenCalled()
  })

  it("stores a verifier's French note in English and echoes it back", async () => {
    queueSelect('asset_logs', [logRow({ translationStatus: 'done', sourceLocale: null })])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await send('/assets/logs/log-1/verify', 'POST', {
      status: 'rejected',
      note: 'Trois casques manquants après la récolte',
    })
    const body = (await res.json()) as { log: Row }

    expect(res.status).toBe(200)
    expect(patchOf('asset_logs')).toMatchObject({
      note: 'Three helmets missing after the harvest',
      verificationStatus: 'rejected',
      sourceLocale: 'fr',
      translationStatus: 'done',
    })
    expect(body.log.note).toBe('Trois casques manquants après la récolte')
  })

  it('verifies without a note without relabelling the row', async () => {
    queueSelect('asset_logs', [logRow()])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await send('/assets/logs/log-1/verify', 'POST', { status: 'verified' })
    const body = (await res.json()) as { log: Row }

    expect(res.status).toBe(200)
    const values = patchOf('asset_logs')
    expect(values).not.toHaveProperty('sourceLocale')
    expect(values).not.toHaveProperty('translationStatus')
    expect(canonicalCalls).not.toHaveBeenCalled()
    // The worker's note is not this verifier's text, so it is rendered for them.
    expect(body.log.note).toBe('Trois casques manquants après la récolte')
  })

  it('stores a French asset event note in English and keeps the event enum', async () => {
    queueSelect('assets', [assetRow()])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await send('/assets/asset-1/events', 'POST', {
      eventType: 'repair',
      costMinor: 25_000,
      notes: 'Courroie remplacée par le mécanicien du village',
    })
    const body = (await res.json()) as { event: Row }

    expect(res.status).toBe(201)
    expect(insertedInto('asset_events')).toMatchObject({
      eventType: 'repair',
      costMinor: 25_000,
      notes: 'Belt replaced by the village mechanic',
      sourceLocale: 'fr',
      translationStatus: 'done',
    })
    expect(body.event.notes).toBe('Courroie remplacée par le mécanicien du village')
  })

  it('still records an asset event when the translator throws', async () => {
    completeChat.mockRejectedValue(new Error('upstream 503'))
    queueSelect('assets', [assetRow()])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await send('/assets/asset-1/events', 'POST', {
      eventType: 'service',
      notes: 'Courroie remplacée par le mécanicien du village',
    })

    expect(res.status).toBe(201)
    expect(insertedInto('asset_events')).toMatchObject({
      notes: 'Courroie remplacée par le mécanicien du village',
      translationStatus: 'pending',
    })
  })
})

describe('GET /assets - viewer locale on read', () => {
  it('translates asset prose and the latest log note in one batched call', async () => {
    queueSelect('assets', [assetRow(), assetRow({ id: 'asset-2', notes: null })])
    queueSelect('asset_logs', [logRow(), logRow({ id: 'log-2', assetId: 'asset-2' })])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await (await app()).request('/assets')
    const body = (await res.json()) as { assets: (Row & { latestLog: Row | null })[] }

    expect(res.status).toBe(200)
    expect(viewerBatchCalls).toHaveBeenCalledTimes(1)
    expect(selectLog.filter((table) => table === 'content_translations')).toHaveLength(1)
    expect(body.assets[0].notes).toBe('Moteur bruyant, vidange faite hier')
    expect(body.assets[0].locationText).toBe('Rangé derrière le hangar à grains')
    expect(body.assets[0].latestLog?.note).toBe('Trois casques manquants après la récolte')
    expect(body.assets[1].notes).toBeNull()
  })

  it('never sends identifiers, proper nouns or the condition key to the translator', async () => {
    queueSelect('assets', [assetRow()])
    queueSelect('asset_logs', [logRow()])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await (await app()).request('/assets')
    const asset = ((await res.json()) as { assets: (Row & { latestLog: Row })[] }).assets[0]

    expect(asset).toMatchObject({
      name: 'Honda WB30 Pump',
      assetTag: 'TRV-AST-2026-014',
      manufacturer: 'Honda',
      model: 'WB30XT',
      serialNumber: 'SN-88213-A',
      category: 'irrigation',
      currency: 'NGN',
      assignedToName: 'Bola',
    })
    expect(asset.latestLog.condition).toBe('good')
    expect(asset.latestLog.recordedByName).toBe('Bola')
    expect(viewerBatchCalls).toHaveBeenCalledWith(
      expect.objectContaining({
        texts: [
          'Engine noisy, oil changed yesterday',
          'Stored behind the grain shed',
          'Three helmets missing after the harvest',
        ],
      }),
    )
  })

  it('does no translation work at all for an English viewer', async () => {
    queueSelect('assets', [assetRow(), assetRow({ id: 'asset-2' })])
    queueSelect('asset_logs', [logRow()])
    queueSelect('users', [{ preferredLocale: 'en' }])

    const res = await (await app()).request('/assets')
    const body = (await res.json()) as { assets: Row[] }

    expect(viewerBatchCalls).not.toHaveBeenCalled()
    expect(completeChat).not.toHaveBeenCalled()
    expect(selectLog).not.toContain('content_translations')
    expect(body.assets[0].notes).toBe('Engine noisy, oil changed yesterday')
  })

  it('reads 40 assets with one batched call and one call per distinct string', async () => {
    queueSelect(
      'assets',
      Array.from({ length: 40 }, (_, index) =>
        assetRow({ id: `asset-${index}`, locationText: null }),
      ),
    )
    queueSelect('asset_logs', [])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await (await app()).request('/assets')
    const body = (await res.json()) as { assets: Row[] }

    expect(body.assets).toHaveLength(40)
    expect(viewerBatchCalls).toHaveBeenCalledTimes(1)
    expect(completeChat).toHaveBeenCalledTimes(1)
    expect(body.assets[39].notes).toBe('Moteur bruyant, vidange faite hier')
  })

  it('localizes the log list in one batched call and leaves counts alone', async () => {
    queueSelect('assets', [{ id: 'asset-1' }])
    queueSelect('asset_logs', [logRow(), logRow({ id: 'log-2' })])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await (await app()).request('/assets/asset-1/logs')
    const body = (await res.json()) as { logs: Row[] }

    expect(viewerBatchCalls).toHaveBeenCalledTimes(1)
    expect(body.logs[0].note).toBe('Trois casques manquants après la récolte')
    expect(body.logs[0].condition).toBe('good')
    expect(body.logs[0].countAvailable).toBe(2)
  })

  it('localizes the event list in one batched call and leaves the enum and cost alone', async () => {
    queueSelect('assets', [{ id: 'asset-1' }])
    queueSelect('asset_events', [eventRow(), eventRow({ id: 'event-2' })])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await (await app()).request('/assets/asset-1/events')
    const body = (await res.json()) as { events: Row[] }

    expect(viewerBatchCalls).toHaveBeenCalledTimes(1)
    expect(body.events[0].notes).toBe('Courroie remplacée par le mécanicien du village')
    expect(body.events[0].eventType).toBe('repair')
    expect(body.events[0].costMinor).toBe(25_000)
  })

  it('does no work on the event list for an English viewer', async () => {
    queueSelect('assets', [{ id: 'asset-1' }])
    queueSelect('asset_events', [eventRow()])
    queueSelect('users', [{ preferredLocale: 'en' }])

    await (await app()).request('/assets/asset-1/events')

    expect(viewerBatchCalls).not.toHaveBeenCalled()
    expect(selectLog).not.toContain('content_translations')
  })
})
