import { Hono } from 'hono'
import { getTableName, type SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
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

  const client = {
    select: selectChain,
    execute: async () => undefined,
    insert: (table: unknown) => ({
      values: (values: Row | Row[]) => {
        const name = nameOf(table)
        const rows = Array.isArray(values) ? values : [values]
        for (const row of rows) inserted.push({ table: name, values: row })
        return {
          returning: async () => rows.map((row) => ({ id: `${name}-new`, ...row })),
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
          where: (condition: SQL) => {
            whereLog.push({ table: name, condition })
            return {
              returning: async () => [{ ...(updatedRows.get(name) ?? {}), ...patch }],
              then: (resolve: (value: unknown) => unknown) =>
                Promise.resolve(undefined).then(resolve),
            }
          },
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

const FRENCH_TO_ENGLISH: Record<string, string> = {
  'Sacs mouillés par la pluie, mis de côté': 'Bags soaked by rain, set aside',
  'Compté dans le magasin derrière la clôture': 'Counted in the store behind the fence',
  'Deux sacs percés par les rats': 'Two bags gnawed by rats',
  'Le comptage ne correspond pas au bon de livraison':
    'The count does not match the delivery note',
  'Magasin derrière la clôture': 'Store behind the fence',
}

const ENGLISH_TO_FRENCH: Record<string, string> = {
  'Bags soaked by rain, set aside': 'Sacs mouillés par la pluie, mis de côté',
  'Counted in the store behind the fence': 'Compté dans le magasin derrière la clôture',
  'Two bags gnawed by rats': 'Deux sacs percés par les rats',
  'The count does not match the delivery note':
    'Le comptage ne correspond pas au bon de livraison',
  'Store behind the fence': 'Magasin derrière la clôture',
}

const ITEM_ID = '22222222-2222-4222-8222-222222222222'

function itemRow(overrides: Row = {}): Row {
  return {
    id: ITEM_ID,
    farmId: 'farm-1',
    name: 'Layer Mash 25kg',
    category: 'feed',
    unit: 'bags',
    quantity: 40,
    reorderLevel: 10,
    supplier: 'Ogun Feeds Ltd',
    storageLocation: 'Store behind the fence',
    batchNumber: 'BATCH-2026-07',
    sourceLocale: null,
    translationStatus: 'done',
    ...overrides,
  }
}

function sessionRow(overrides: Row = {}): Row {
  return {
    id: 'count-1',
    farmId: 'farm-1',
    taskId: null,
    locationText: 'Counted in the store behind the fence',
    status: 'submitted',
    recordedById: 'user-worker',
    verifiedById: null,
    verifiedAt: null,
    rejectionReason: null,
    sourceLocale: null,
    translationStatus: 'done',
    createdAt: new Date('2026-07-20T08:00:00Z'),
    ...overrides,
  }
}

async function app() {
  const { inventoryRoutes } = await import('./inventory.js')
  const instance = new Hono()
  instance.route('/inventory', inventoryRoutes)
  return instance
}

async function send(path: string, method: 'POST' | 'PATCH', body: unknown) {
  return (await app()).request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function post(path: string, body: unknown) {
  return send(path, 'POST', body)
}

function insertedAll(table: string): Row[] {
  return inserted.filter((entry) => entry.table === table).map((entry) => entry.values)
}

function insertedInto(table: string): Row {
  const rows = insertedAll(table)
  expect(rows.length).toBeGreaterThan(0)
  return rows[0]
}

function patchOf(table: string): Row {
  const row = updates.find((entry) => entry.table === table)
  expect(row).toBeDefined()
  return row!.patch
}

const dialect = new PgDialect()

/** The values a query against a table was scoped to, in call order. */
function whereParams(table: string): unknown[][] {
  return whereLog
    .filter((entry) => entry.table === table)
    .map((entry) => dialect.sqlToQuery(entry.condition).params)
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
  whereLog.length = 0
  updatedRows.clear()
  updatedRows.set('inventory_items', itemRow())
  updatedRows.set('inventory_count_sessions', sessionRow())
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

describe('POST /inventory/movements - canonical English on write', () => {
  it('stores a French stock-move reason in English with the author locale', async () => {
    queueSelect('inventory_items', [itemRow()])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await post('/inventory/movements', {
      itemId: ITEM_ID,
      delta: -3,
      reason: 'Sacs mouillés par la pluie, mis de côté',
    })

    expect(res.status).toBe(200)
    expect(insertedInto('inventory_movements')).toMatchObject({
      reason: 'Bags soaked by rain, set aside',
      delta: -3,
      sourceLocale: 'fr',
      translationStatus: 'done',
    })
  })

  it('leaves the item name, batch and quantities verbatim', async () => {
    queueSelect('inventory_items', [itemRow()])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    await post('/inventory/movements', {
      itemId: ITEM_ID,
      delta: -3,
      reason: 'Sacs mouillés par la pluie, mis de côté',
    })

    // The reason is the only prose on this write; the item's storage location
    // comes back rendered for the viewer.
    expect(translatedTexts()).toEqual([
      'Sacs mouillés par la pluie, mis de côté',
      'Store behind the fence',
    ])
    expect(patchOf('inventory_items')).toMatchObject({ quantity: 37 })
  })

  it('leaves the item locale columns alone on a move that writes no location', async () => {
    queueSelect('inventory_items', [itemRow()])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    await post('/inventory/movements', {
      itemId: ITEM_ID,
      delta: -3,
      reason: 'Sacs mouillés par la pluie, mis de côté',
    })

    const values = patchOf('inventory_items')
    expect(values).toMatchObject({ quantity: 37 })
    expect(values).not.toHaveProperty('storageLocation')
    expect(values).not.toHaveProperty('sourceLocale')
    expect(values).not.toHaveProperty('translationStatus')
  })

  it('never labels a machine marker written through the same column', async () => {
    queueSelect('inventory_items', [itemRow()])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await post('/inventory/movements', {
      itemId: ITEM_ID,
      delta: 5,
      reason: 'task_consumption',
    })

    expect(res.status).toBe(200)
    const movement = insertedInto('inventory_movements')
    expect(movement.reason).toBe('task_consumption')
    expect(movement).not.toHaveProperty('sourceLocale')
    expect(movement).not.toHaveProperty('translationStatus')
    expect(canonicalCalls).not.toHaveBeenCalled()
  })

  it('stores the original as pending and still succeeds when the LLM is unavailable', async () => {
    isLlmConfigured.mockReturnValue(false)
    queueSelect('inventory_items', [itemRow()])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await post('/inventory/movements', {
      itemId: ITEM_ID,
      delta: -3,
      reason: 'Sacs mouillés par la pluie, mis de côté',
    })

    expect(res.status).toBe(200)
    expect(insertedInto('inventory_movements')).toMatchObject({
      reason: 'Sacs mouillés par la pluie, mis de côté',
      sourceLocale: 'fr',
      translationStatus: 'pending',
    })
  })

  it('still succeeds and stays pending when the translator throws', async () => {
    completeChat.mockRejectedValue(new Error('upstream 503'))
    queueSelect('inventory_items', [itemRow()])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await post('/inventory/movements', {
      itemId: ITEM_ID,
      delta: -3,
      reason: 'Sacs mouillés par la pluie, mis de côté',
    })

    expect(res.status).toBe(200)
    expect(insertedInto('inventory_movements')).toMatchObject({
      reason: 'Sacs mouillés par la pluie, mis de côté',
      translationStatus: 'pending',
    })
  })

  it('makes no translation call at all for an English reason', async () => {
    queueSelect('inventory_items', [itemRow()])
    queueSelect('users', [{ preferredLocale: 'en' }])

    const res = await post('/inventory/movements', {
      itemId: ITEM_ID,
      delta: -3,
      reason: 'Bags soaked by rain, set aside',
    })

    expect(res.status).toBe(200)
    expect(completeChat).not.toHaveBeenCalled()
    expect(insertedInto('inventory_movements')).toMatchObject({
      sourceLocale: 'en',
      translationStatus: 'done',
    })
  })
})

describe('POST /inventory/items - canonical English on write', () => {
  /** A create body whose register keys must survive a translated write untouched. */
  const FRENCH_ITEM = {
    name: 'Layer Mash 25kg',
    category: 'feed',
    unit: 'bags' as const,
    supplier: 'Ogun Feeds Ltd',
    storageLocation: 'Magasin derrière la clôture',
    batchNumber: 'BATCH-2026-07',
  }

  it('stores a French storage location in English with the author locale', async () => {
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await post('/inventory/items', FRENCH_ITEM)

    expect(res.status).toBe(201)
    expect(insertedInto('inventory_items')).toMatchObject({
      storageLocation: 'Store behind the fence',
      sourceLocale: 'fr',
      translationStatus: 'done',
    })
  })

  it('leaves the register keys, supplier and batch verbatim', async () => {
    queueSelect('users', [{ preferredLocale: 'fr' }])

    await post('/inventory/items', FRENCH_ITEM)

    expect(insertedInto('inventory_items')).toMatchObject({
      name: 'Layer Mash 25kg',
      category: 'feed',
      supplier: 'Ogun Feeds Ltd',
      batchNumber: 'BATCH-2026-07',
    })
    // The storage location is the only prose on this write.
    expect(translatedTexts()).toEqual(['Magasin derrière la clôture'])
  })

  it('returns the author their own words while storing the English', async () => {
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await post('/inventory/items', FRENCH_ITEM)
    const body = (await res.json()) as { item: Row }

    expect(body.item.storageLocation).toBe('Magasin derrière la clôture')
    expect(insertedInto('inventory_items').storageLocation).toBe('Store behind the fence')
  })

  it('stores the original as pending and still succeeds when canonicalization throws', async () => {
    isLlmConfigured.mockImplementation(() => {
      throw new Error('llm client not initialised')
    })
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await post('/inventory/items', FRENCH_ITEM)

    expect(res.status).toBe(201)
    expect(insertedInto('inventory_items')).toMatchObject({
      storageLocation: 'Magasin derrière la clôture',
      sourceLocale: 'fr',
      translationStatus: 'pending',
    })
  })

  it('makes no translation call at all for an English create', async () => {
    queueSelect('users', [{ preferredLocale: 'en' }])

    const res = await post('/inventory/items', {
      ...FRENCH_ITEM,
      storageLocation: 'Store behind the fence',
    })

    expect(res.status).toBe(201)
    expect(completeChat).not.toHaveBeenCalled()
    expect(insertedInto('inventory_items')).toMatchObject({
      sourceLocale: 'en',
      translationStatus: 'done',
    })
  })

  it('does not enter the translation service for an item with no location', async () => {
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await post('/inventory/items', { ...FRENCH_ITEM, storageLocation: null })

    expect(res.status).toBe(201)
    expect(canonicalCalls).not.toHaveBeenCalled()
    const values = insertedInto('inventory_items')
    expect(values.storageLocation).toBeNull()
    expect(values).not.toHaveProperty('sourceLocale')
    expect(values).not.toHaveProperty('translationStatus')
  })
})

describe('Sales inventory write lock', () => {
  beforeEach(() => { sessionUser.role = 'sales' })

  it('blocks stock movements', async () => {
    const res = await post('/inventory/movements', {
      itemId: ITEM_ID,
      delta: -1,
      reason: 'customer order',
    })
    expect(res.status).toBe(403)
    expect(inserted).toHaveLength(0)
  })

  it('blocks opening counts', async () => {
    const res = await post('/inventory/opening-count', {
      items: [{ itemId: ITEM_ID, countedQuantity: 40 }],
    })
    expect(res.status).toBe(403)
    expect(inserted).toHaveLength(0)
  })

  it('blocks count-session submissions', async () => {
    const res = await post('/inventory/count-sessions', {
      lines: [{ itemName: 'Layer Mash 25kg', unit: 'bags', countedQuantity: 40 }],
    })
    expect(res.status).toBe(403)
    expect(inserted).toHaveLength(0)
  })
})

describe('PATCH /inventory/items/:id - correcting a mistyped item', () => {
  async function patchItem(body: Row) {
    return send(`/inventory/items/${ITEM_ID}`, 'PATCH', body)
  }

  it('stores a corrected French storage location in English with the author locale', async () => {
    queueSelect('inventory_items', [itemRow()])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await patchItem({ storageLocation: 'Magasin derrière la clôture' })

    expect(res.status).toBe(200)
    expect(patchOf('inventory_items')).toMatchObject({
      storageLocation: 'Store behind the fence',
      sourceLocale: 'fr',
      translationStatus: 'done',
    })
  })

  it('corrects the register keys without relabelling the row or translating them', async () => {
    queueSelect('inventory_items', [itemRow()])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await patchItem({ name: 'Layer Mash 50kg', supplier: 'Ogun Feeds Nigeria' })

    expect(res.status).toBe(200)
    const values = patchOf('inventory_items')
    expect(values).toMatchObject({
      name: 'Layer Mash 50kg',
      supplier: 'Ogun Feeds Nigeria',
    })
    expect(values).not.toHaveProperty('storageLocation')
    expect(values).not.toHaveProperty('sourceLocale')
    expect(values).not.toHaveProperty('translationStatus')
    expect(canonicalCalls).not.toHaveBeenCalled()
  })

  it('never downgrades a row the retry job still owes work on', async () => {
    queueSelect('inventory_items', [itemRow({ sourceLocale: 'yo', translationStatus: 'pending' })])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    await patchItem({ storageLocation: 'Magasin derrière la clôture' })

    const values = patchOf('inventory_items')
    expect(values.storageLocation).toBe('Store behind the fence')
    expect(values).not.toHaveProperty('sourceLocale')
    expect(values).not.toHaveProperty('translationStatus')
  })

  it('stores the original as pending and still succeeds when canonicalization throws', async () => {
    isLlmConfigured.mockImplementation(() => {
      throw new Error('llm client not initialised')
    })
    queueSelect('inventory_items', [itemRow()])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await patchItem({ storageLocation: 'Magasin derrière la clôture' })

    expect(res.status).toBe(200)
    expect(patchOf('inventory_items')).toMatchObject({
      storageLocation: 'Magasin derrière la clôture',
      sourceLocale: 'fr',
      translationStatus: 'pending',
    })
  })

  it('returns the author their own words while storing the English', async () => {
    queueSelect('inventory_items', [itemRow()])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await patchItem({ storageLocation: 'Magasin derrière la clôture' })
    const body = (await res.json()) as { item: Row }

    expect(body.item.storageLocation).toBe('Magasin derrière la clôture')
    expect(patchOf('inventory_items').storageLocation).toBe('Store behind the fence')
  })

  it('renders a location this author did not touch in the viewer language', async () => {
    queueSelect('inventory_items', [itemRow()])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await patchItem({ reorderLevel: 25 })
    const body = (await res.json()) as { item: Row }

    expect(res.status).toBe(200)
    expect(body.item.storageLocation).toBe('Magasin derrière la clôture')
  })

  it('never moves stock, so a quantity in the body is dropped', async () => {
    queueSelect('inventory_items', [itemRow()])
    queueSelect('users', [{ preferredLocale: 'en' }])

    const res = await patchItem({ quantity: 500, reorderLevel: 25 })
    const body = (await res.json()) as { item: Row }

    expect(res.status).toBe(200)
    expect(patchOf('inventory_items')).not.toHaveProperty('quantity')
    expect(body.item.quantity).toBe(40)
    expect(insertedAll('inventory_movements')).toHaveLength(0)
  })

  it('corrects the unit while nothing has ever moved against it', async () => {
    queueSelect('inventory_items', [itemRow()])
    queueSelect('inventory_movements', [])
    queueSelect('users', [{ preferredLocale: 'en' }])

    const res = await patchItem({ unit: 'kg' })

    expect(res.status).toBe(200)
    expect(patchOf('inventory_items')).toMatchObject({ unit: 'kg' })
  })

  // The ledger records unitless deltas, so a unit the history was written under
  // is not a mistype the farm can still correct.
  it('refuses a unit change once the ledger holds a move for the item', async () => {
    queueSelect('inventory_items', [itemRow()])
    queueSelect('inventory_movements', [{ id: 'movement-1' }])

    const res = await patchItem({ unit: 'kg' })
    const body = (await res.json()) as { error: string }

    expect(res.status).toBe(400)
    expect(body.error).toBe(
      'Unit cannot change once stock has moved; create a new item with the correct unit',
    )
    expect(updates).toHaveLength(0)
  })

  it('leaves a patch that carries no unit alone without reading the ledger', async () => {
    queueSelect('inventory_items', [itemRow()])
    queueSelect('inventory_movements', [{ id: 'movement-1' }])
    queueSelect('users', [{ preferredLocale: 'en' }])

    const res = await patchItem({ reorderLevel: 25 })

    expect(res.status).toBe(200)
    expect(patchOf('inventory_items')).toMatchObject({ reorderLevel: 25 })
    expect(selectLog).not.toContain('inventory_movements')
  })

  it('accepts the unit the item already has without reading the ledger', async () => {
    queueSelect('inventory_items', [itemRow()])
    queueSelect('inventory_movements', [{ id: 'movement-1' }])
    queueSelect('users', [{ preferredLocale: 'en' }])

    const res = await patchItem({ unit: 'bags', reorderLevel: 25 })

    expect(res.status).toBe(200)
    expect(patchOf('inventory_items')).toMatchObject({ unit: 'bags' })
    expect(selectLog).not.toContain('inventory_movements')
  })

  it('scopes the movement history it checks to the caller farm', async () => {
    queueSelect('inventory_items', [itemRow()])
    queueSelect('inventory_movements', [])
    queueSelect('users', [{ preferredLocale: 'en' }])

    await patchItem({ unit: 'kg' })

    expect(whereParams('inventory_movements')).toEqual([[ITEM_ID, 'farm-1']])
  })

  it('scopes the item it reads and the item it writes to the caller farm', async () => {
    queueSelect('inventory_items', [itemRow()])
    queueSelect('users', [{ preferredLocale: 'en' }])

    await patchItem({ reorderLevel: 25 })

    expect(whereParams('inventory_items')).toEqual([
      [ITEM_ID, 'farm-1'],
      [ITEM_ID, 'farm-1'],
    ])
  })

  it('is a 404 for an item on another farm', async () => {
    queueSelect('inventory_items', [])

    const res = await patchItem({ storageLocation: 'Magasin derrière la clôture' })

    expect(res.status).toBe(404)
    expect(updates).toHaveLength(0)
  })

  it('refuses a field worker', async () => {
    sessionUser.role = 'field_worker'

    const res = await patchItem({ name: 'Layer Mash 50kg' })

    expect(res.status).toBe(403)
    expect(updates).toHaveLength(0)
  })

  it('refuses sales so order access never grants stock write authority', async () => {
    sessionUser.role = 'sales'

    const res = await patchItem({ name: 'Layer Mash 50kg' })

    expect(res.status).toBe(403)
    expect(updates).toHaveLength(0)
  })
})

describe('POST /inventory/count-sessions - canonical English on write', () => {
  const FRENCH_COUNT = {
    locationText: 'Compté dans le magasin derrière la clôture',
    lines: [
      {
        itemId: ITEM_ID,
        itemName: 'Layer Mash 25kg',
        category: 'feed',
        unit: 'bags' as const,
        countedQuantity: 38,
        notes: 'Deux sacs percés par les rats',
      },
      {
        itemName: 'Noiler Starter 10kg',
        category: 'feed',
        unit: 'bags' as const,
        countedQuantity: 12,
      },
    ],
  }

  function queueCountReads(locale: 'en' | 'fr') {
    queueSelect('inventory_items', [itemRow({ sku: 'INV-LAYER-MASH', varianceTolerance: 2 })])
    queueSelect('users', [{ preferredLocale: locale }])
  }

  it('stores the location and each line note in English with the author locale', async () => {
    queueCountReads('fr')

    const res = await post('/inventory/count-sessions', FRENCH_COUNT)

    expect(res.status).toBe(201)
    expect(insertedInto('inventory_count_sessions')).toMatchObject({
      locationText: 'Counted in the store behind the fence',
      sourceLocale: 'fr',
      translationStatus: 'done',
    })
    expect(insertedAll('inventory_count_lines')[0]).toMatchObject({
      notes: 'Two bags gnawed by rats',
      sourceLocale: 'fr',
      translationStatus: 'done',
    })
  })

  it('leaves counted item names, categories, units and quantities verbatim', async () => {
    queueCountReads('fr')

    await post('/inventory/count-sessions', FRENCH_COUNT)

    expect(insertedAll('inventory_count_lines')).toMatchObject([
      { itemName: 'Layer Mash 25kg', category: 'feed', unit: 'bags', countedQuantity: 38 },
      { itemName: 'Noiler Starter 10kg', category: 'feed', unit: 'bags', countedQuantity: 12 },
    ])
    expect(translatedTexts().sort()).toEqual([
      'Compté dans le magasin derrière la clôture',
      'Deux sacs percés par les rats',
    ])
  })

  it('leaves a line with no note on the schema defaults', async () => {
    queueCountReads('fr')

    await post('/inventory/count-sessions', FRENCH_COUNT)

    const bare = insertedAll('inventory_count_lines')[1]
    expect(bare.notes).toBeNull()
    expect(bare).not.toHaveProperty('sourceLocale')
    expect(bare).not.toHaveProperty('translationStatus')
  })

  it('leaves one failed line pending without touching the others', async () => {
    queueCountReads('fr')
    completeChat.mockImplementation(async (_system: string, text: string) => {
      if (text === 'Deux sacs percés par les rats') throw new Error('upstream 503')
      return { text: FRENCH_TO_ENGLISH[text], model: 'test' }
    })

    const res = await post('/inventory/count-sessions', FRENCH_COUNT)

    expect(res.status).toBe(201)
    // Each line is its own row, so the session's own pair stays 'done'.
    expect(insertedInto('inventory_count_sessions')).toMatchObject({
      locationText: 'Counted in the store behind the fence',
      translationStatus: 'done',
    })
    expect(insertedAll('inventory_count_lines')[0]).toMatchObject({
      notes: 'Deux sacs percés par les rats',
      translationStatus: 'pending',
    })
  })

  it('returns the author their own words while storing the English', async () => {
    queueCountReads('fr')

    const res = await post('/inventory/count-sessions', FRENCH_COUNT)
    const body = (await res.json()) as { session: Row }

    expect(body.session.locationText).toBe('Compté dans le magasin derrière la clôture')
    expect(insertedInto('inventory_count_sessions').locationText).toBe(
      'Counted in the store behind the fence',
    )
  })

  it('makes no translation call at all for an English count sheet', async () => {
    queueCountReads('en')

    const res = await post('/inventory/count-sessions', {
      ...FRENCH_COUNT,
      locationText: 'Counted in the store behind the fence',
      lines: [{ ...FRENCH_COUNT.lines[0], notes: 'Two bags gnawed by rats' }],
    })

    expect(res.status).toBe(201)
    expect(completeChat).not.toHaveBeenCalled()
  })
})

describe('POST /inventory/count-sessions/:id/verify - canonical English on write', () => {
  it('stores a French rejection reason in English and escalates the row', async () => {
    queueSelect('inventory_count_sessions', [sessionRow()])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await post('/inventory/count-sessions/count-1/verify', {
      status: 'rejected',
      rejectionReason: 'Le comptage ne correspond pas au bon de livraison',
    })

    expect(res.status).toBe(200)
    expect(patchOf('inventory_count_sessions')).toMatchObject({
      status: 'rejected',
      rejectionReason: 'The count does not match the delivery note',
      sourceLocale: 'fr',
      translationStatus: 'done',
    })
  })

  it('echoes the verifier their reason and localizes the storekeeper location', async () => {
    queueSelect('inventory_count_sessions', [sessionRow()])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await post('/inventory/count-sessions/count-1/verify', {
      status: 'rejected',
      rejectionReason: 'Le comptage ne correspond pas au bon de livraison',
    })
    const body = (await res.json()) as { session: Row }

    expect(body.session.rejectionReason).toBe(
      'Le comptage ne correspond pas au bon de livraison',
    )
    expect(body.session.locationText).toBe('Compté dans le magasin derrière la clôture')
    expect(viewerBatchCalls).toHaveBeenCalledWith(
      expect.objectContaining({ texts: ['Counted in the store behind the fence'] }),
    )
  })

  it('rejects with the original reason as pending when the translator throws', async () => {
    completeChat.mockRejectedValue(new Error('upstream 503'))
    queueSelect('inventory_count_sessions', [sessionRow()])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await post('/inventory/count-sessions/count-1/verify', {
      status: 'rejected',
      rejectionReason: 'Le comptage ne correspond pas au bon de livraison',
    })

    expect(res.status).toBe(200)
    expect(patchOf('inventory_count_sessions')).toMatchObject({
      rejectionReason: 'Le comptage ne correspond pas au bon de livraison',
      translationStatus: 'pending',
    })
  })

  it('never downgrades a row the retry job still owes work on', async () => {
    queueSelect('inventory_count_sessions', [
      sessionRow({ sourceLocale: 'yo', translationStatus: 'pending' }),
    ])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    await post('/inventory/count-sessions/count-1/verify', {
      status: 'rejected',
      rejectionReason: 'Le comptage ne correspond pas au bon de livraison',
    })

    const values = patchOf('inventory_count_sessions')
    expect(values.rejectionReason).toBe('The count does not match the delivery note')
    expect(values).not.toHaveProperty('translationStatus')
    expect(values).not.toHaveProperty('sourceLocale')
  })

  it('writes no text when approving and renders the row for the viewer', async () => {
    queueSelect('inventory_count_sessions', [sessionRow()])
    queueSelect('users', [{ preferredLocale: 'fr' }])
    queueSelect('inventory_count_lines', [])

    const res = await post('/inventory/count-sessions/count-1/verify', { status: 'verified' })
    const body = (await res.json()) as { session: Row }

    expect(res.status).toBe(200)
    expect(canonicalCalls).not.toHaveBeenCalled()
    expect(body.session.locationText).toBe('Compté dans le magasin derrière la clôture')
  })

  it('creates a missing item under the name it was counted as', async () => {
    queueSelect('inventory_count_sessions', [sessionRow()])
    queueSelect('users', [{ preferredLocale: 'fr' }])
    queueSelect('inventory_count_lines', [
      {
        id: 'line-1',
        sessionId: 'count-1',
        itemId: null,
        itemName: 'Noiler Starter 10kg',
        category: 'feed',
        unit: 'bags',
        countedQuantity: 12,
        notes: null,
      },
    ])
    queueSelect('inventory_items', [itemRow({ id: 'inventory_items-new', quantity: 0 })])

    const res = await post('/inventory/count-sessions/count-1/verify', { status: 'verified' })

    expect(res.status).toBe(200)
    expect(insertedInto('inventory_items')).toMatchObject({
      name: 'Noiler Starter 10kg',
      category: 'feed',
    })
    // The stock correction is a machine marker, not prose.
    const movement = insertedInto('inventory_movements')
    expect(movement.reason).toBe('verified_count_session')
    expect(movement).not.toHaveProperty('sourceLocale')
  })
})

describe('inventory reads - viewer locale', () => {
  it('translates count session prose for a French viewer in one batched call', async () => {
    queueSelect('inventory_count_sessions', [
      sessionRow(),
      sessionRow({
        id: 'count-2',
        status: 'rejected',
        rejectionReason: 'The count does not match the delivery note',
      }),
    ])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await (await app()).request('/inventory/count-sessions')
    const body = (await res.json()) as { sessions: Row[] }

    expect(res.status).toBe(200)
    expect(viewerBatchCalls).toHaveBeenCalledTimes(1)
    expect(selectLog.filter((table) => table === 'content_translations')).toHaveLength(1)
    expect(body.sessions[0].locationText).toBe('Compté dans le magasin derrière la clôture')
    expect(body.sessions[1].rejectionReason).toBe(
      'Le comptage ne correspond pas au bon de livraison',
    )
    expect(body.sessions[0].status).toBe('submitted')
  })

  it('does no translation work at all for an English viewer', async () => {
    queueSelect('inventory_count_sessions', [sessionRow(), sessionRow({ id: 'count-2' })])
    queueSelect('users', [{ preferredLocale: 'en' }])

    const res = await (await app()).request('/inventory/count-sessions')
    const body = (await res.json()) as { sessions: Row[] }

    expect(viewerBatchCalls).not.toHaveBeenCalled()
    expect(completeChat).not.toHaveBeenCalled()
    expect(selectLog).not.toContain('content_translations')
    expect(body.sessions[0].locationText).toBe('Counted in the store behind the fence')
  })

  it('translates item storage locations for a French viewer in one batched call', async () => {
    queueSelect('inventory_items', [
      itemRow(),
      itemRow({ id: 'item-2', storageLocation: null }),
    ])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await (await app()).request('/inventory')
    const body = (await res.json()) as { items: Row[] }

    expect(res.status).toBe(200)
    expect(viewerBatchCalls).toHaveBeenCalledTimes(1)
    expect(body.items[0].storageLocation).toBe('Magasin derrière la clôture')
    expect(body.items[1].storageLocation).toBeNull()
  })

  it('never sends the item register keys, supplier or batch to the translator', async () => {
    queueSelect('inventory_items', [itemRow()])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await (await app()).request('/inventory')
    const body = (await res.json()) as { items: Row[] }

    expect(body.items[0]).toMatchObject({
      name: 'Layer Mash 25kg',
      category: 'feed',
      supplier: 'Ogun Feeds Ltd',
      batchNumber: 'BATCH-2026-07',
    })
    expect(translatedTexts()).toEqual(['Store behind the fence'])
  })

  it('never localizes the item register for an English viewer', async () => {
    queueSelect('inventory_items', [itemRow()])
    queueSelect('users', [{ preferredLocale: 'en' }])

    const res = await (await app()).request('/inventory')
    const body = (await res.json()) as { items: Row[] }

    expect(res.status).toBe(200)
    expect(viewerBatchCalls).not.toHaveBeenCalled()
    expect(body.items[0]).toMatchObject({
      name: 'Layer Mash 25kg',
      supplier: 'Ogun Feeds Ltd',
      storageLocation: 'Store behind the fence',
      batchNumber: 'BATCH-2026-07',
    })
  })

  it('renders the low-stock list in the viewer language', async () => {
    queueSelect('inventory_items', [itemRow({ quantity: 4 })])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await (await app()).request('/inventory/low-stock')
    const body = (await res.json()) as { items: Row[] }

    expect(res.status).toBe(200)
    expect(body.items[0].storageLocation).toBe('Magasin derrière la clôture')
  })

  it('renders the item a stock move returns in the viewer language', async () => {
    queueSelect('inventory_items', [itemRow()])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await post('/inventory/movements', {
      itemId: ITEM_ID,
      delta: -3,
      reason: 'Sacs mouillés par la pluie, mis de côté',
    })
    const body = (await res.json()) as { item: Row }

    expect(res.status).toBe(200)
    expect(body.item.storageLocation).toBe('Magasin derrière la clôture')
  })

  it('renders the opening count response in the viewer language', async () => {
    queueSelect('inventory_items', [itemRow()])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await post('/inventory/opening-count', {
      items: [{ itemId: ITEM_ID, countedQuantity: 30 }],
    })
    const body = (await res.json()) as { items: Row[] }

    expect(res.status).toBe(200)
    expect(body.items[0].storageLocation).toBe('Magasin derrière la clôture')
  })
})
