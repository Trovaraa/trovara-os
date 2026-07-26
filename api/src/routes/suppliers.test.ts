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
            returning: async () => [{ id: 'supplier-new', ...values }],
            onConflictDoNothing: async () => undefined,
          }
        },
      }),
      update: (table: unknown) => ({
        set: (patch: Row) => {
          updates.push({ table: nameOf(table), patch })
          return { where: () => ({ returning: async () => [{ ...updatedRow, ...patch }] }) }
        },
      }),
      delete: () => ({ where: async () => undefined }),
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
  'Livre le mardi, paiement à 30 jours': 'Delivers on Tuesdays, payment at 30 days',
}

const ENGLISH_TO_FRENCH: Record<string, string> = {
  'Delivers on Tuesdays, payment at 30 days': 'Livre le mardi, paiement à 30 jours',
}

/** A create body whose contact details must survive a translated write intact. */
const FRENCH_SUPPLIER = {
  name: 'Ogun Feeds Ltd',
  phone: '+2348012345678',
  email: 'ventes@ogunfeeds.ng',
  notes: 'Livre le mardi, paiement à 30 jours',
}

function supplierRow(overrides: Row = {}): Row {
  return {
    id: 'supplier-1',
    farmId: 'farm-1',
    name: 'Ogun Feeds Ltd',
    phone: '+2348012345678',
    email: 'ventes@ogunfeeds.ng',
    notes: 'Delivers on Tuesdays, payment at 30 days',
    sourceLocale: null,
    translationStatus: 'done',
    active: true,
    ...overrides,
  }
}

async function app() {
  const { supplierRoutes } = await import('./suppliers.js')
  const instance = new Hono()
  instance.route('/suppliers', supplierRoutes)
  return instance
}

async function post(body: unknown) {
  return (await app()).request('/suppliers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function patch(id: string, body: unknown) {
  return (await app()).request(`/suppliers/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function insertedSupplier(): Row {
  const row = inserted.find((entry) => entry.table === 'suppliers')
  expect(row).toBeDefined()
  return row!.values
}

function supplierPatch(): Row {
  const row = updates.find((entry) => entry.table === 'suppliers')
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
  updatedRow = supplierRow()
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

describe('POST /suppliers - canonical English on write', () => {
  it('stores the notes in English with the author locale for a French create', async () => {
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await post(FRENCH_SUPPLIER)

    expect(res.status).toBe(201)
    expect(insertedSupplier()).toMatchObject({
      notes: 'Delivers on Tuesdays, payment at 30 days',
      sourceLocale: 'fr',
      translationStatus: 'done',
    })
  })

  it('leaves the supplier name, phone and email verbatim', async () => {
    queueSelect('users', [{ preferredLocale: 'fr' }])

    await post(FRENCH_SUPPLIER)

    expect(insertedSupplier()).toMatchObject({
      name: 'Ogun Feeds Ltd',
      phone: '+2348012345678',
      email: 'ventes@ogunfeeds.ng',
    })
    // The notes are the only prose; nothing else reaches the translator.
    expect(translatedTexts()).toEqual(['Livre le mardi, paiement à 30 jours'])
  })

  it('returns the author their own words while storing the English', async () => {
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await post(FRENCH_SUPPLIER)
    const body = (await res.json()) as { supplier: Row }

    expect(body.supplier.notes).toBe('Livre le mardi, paiement à 30 jours')
    expect(insertedSupplier().notes).toBe('Delivers on Tuesdays, payment at 30 days')
  })

  it('stores the original as pending and still succeeds when the LLM is unavailable', async () => {
    isLlmConfigured.mockReturnValue(false)
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await post(FRENCH_SUPPLIER)

    expect(res.status).toBe(201)
    expect(insertedSupplier()).toMatchObject({
      notes: 'Livre le mardi, paiement à 30 jours',
      sourceLocale: 'fr',
      translationStatus: 'pending',
    })
  })

  it('still succeeds and stays pending when the translator throws', async () => {
    completeChat.mockRejectedValue(new Error('upstream 503'))
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await post(FRENCH_SUPPLIER)

    expect(res.status).toBe(201)
    expect(insertedSupplier()).toMatchObject({
      notes: 'Livre le mardi, paiement à 30 jours',
      translationStatus: 'pending',
    })
  })

  it('makes no translation call at all for an English create', async () => {
    queueSelect('users', [{ preferredLocale: 'en' }])

    const res = await post({
      ...FRENCH_SUPPLIER,
      notes: 'Delivers on Tuesdays, payment at 30 days',
    })

    expect(res.status).toBe(201)
    expect(completeChat).not.toHaveBeenCalled()
    expect(insertedSupplier()).toMatchObject({
      notes: 'Delivers on Tuesdays, payment at 30 days',
      sourceLocale: 'en',
      translationStatus: 'done',
    })
  })

  it('does not enter the translation service for a create with no notes', async () => {
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await post({ name: 'Ogun Feeds Ltd' })

    expect(res.status).toBe(201)
    expect(canonicalCalls).not.toHaveBeenCalled()
    expect(insertedSupplier()).toMatchObject({ notes: null })
  })
})

describe('PATCH /suppliers/:id - canonical English on write', () => {
  it('stores edited notes in English and labels the row with the author locale', async () => {
    queueSelect('suppliers', [supplierRow()])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await patch('supplier-1', { notes: 'Livre le mardi, paiement à 30 jours' })

    expect(res.status).toBe(200)
    expect(supplierPatch()).toMatchObject({
      notes: 'Delivers on Tuesdays, payment at 30 days',
      sourceLocale: 'fr',
      translationStatus: 'done',
    })
  })

  it('renames a supplier without relabelling the row or translating the name', async () => {
    queueSelect('suppliers', [supplierRow()])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await patch('supplier-1', { name: 'Ogun Feeds Nigeria Ltd' })
    const body = (await res.json()) as { supplier: Row }

    expect(res.status).toBe(200)
    const values = supplierPatch()
    expect(values.name).toBe('Ogun Feeds Nigeria Ltd')
    expect(values).not.toHaveProperty('sourceLocale')
    expect(values).not.toHaveProperty('translationStatus')
    expect(canonicalCalls).not.toHaveBeenCalled()
    // The notes this author did not touch are still rendered for their language.
    expect(body.supplier.notes).toBe('Livre le mardi, paiement à 30 jours')
  })

  it('leaves the row pending and returns 200 when the translator throws', async () => {
    completeChat.mockRejectedValue(new Error('upstream 503'))
    queueSelect('suppliers', [supplierRow()])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await patch('supplier-1', { notes: 'Livre le mardi, paiement à 30 jours' })

    expect(res.status).toBe(200)
    expect(supplierPatch()).toMatchObject({
      notes: 'Livre le mardi, paiement à 30 jours',
      translationStatus: 'pending',
    })
  })

  it('never downgrades a row the retry job still owes work on', async () => {
    queueSelect('suppliers', [supplierRow({ sourceLocale: 'yo', translationStatus: 'pending' })])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    await patch('supplier-1', { notes: 'Livre le mardi, paiement à 30 jours' })

    const values = supplierPatch()
    expect(values.notes).toBe('Delivers on Tuesdays, payment at 30 days')
    expect(values).not.toHaveProperty('translationStatus')
    expect(values).not.toHaveProperty('sourceLocale')
  })

  it('echoes the editor their own words instead of translating back', async () => {
    queueSelect('suppliers', [supplierRow()])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await patch('supplier-1', { notes: 'Livre le mardi, paiement à 30 jours' })
    const body = (await res.json()) as { supplier: Row }

    expect(body.supplier.notes).toBe('Livre le mardi, paiement à 30 jours')
    expect(viewerBatchCalls).not.toHaveBeenCalled()
  })

  it('404s an unknown supplier before it translates anything', async () => {
    queueSelect('suppliers', [])

    const res = await patch('supplier-missing', { notes: 'Livre le mardi, paiement à 30 jours' })

    expect(res.status).toBe(404)
    expect(canonicalCalls).not.toHaveBeenCalled()
  })
})

describe('GET /suppliers - viewer locale on read', () => {
  it('translates the notes for a French viewer in one batched call', async () => {
    queueSelect('suppliers', [supplierRow(), supplierRow({ id: 'supplier-2', notes: null })])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await (await app()).request('/suppliers')
    const body = (await res.json()) as { suppliers: Row[] }

    expect(res.status).toBe(200)
    expect(viewerBatchCalls).toHaveBeenCalledTimes(1)
    expect(selectLog.filter((table) => table === 'content_translations')).toHaveLength(1)
    expect(body.suppliers[0].notes).toBe('Livre le mardi, paiement à 30 jours')
    expect(body.suppliers[1].notes).toBeNull()
  })

  it('never sends the supplier name or contact details to the translator', async () => {
    queueSelect('suppliers', [supplierRow()])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await (await app()).request('/suppliers')
    const supplier = ((await res.json()) as { suppliers: Row[] }).suppliers[0]

    expect(supplier).toMatchObject({
      name: 'Ogun Feeds Ltd',
      phone: '+2348012345678',
      email: 'ventes@ogunfeeds.ng',
    })
    expect(viewerBatchCalls).toHaveBeenCalledWith(
      expect.objectContaining({ texts: ['Delivers on Tuesdays, payment at 30 days'] }),
    )
  })

  it('does no translation work at all for an English viewer', async () => {
    queueSelect('suppliers', [supplierRow(), supplierRow({ id: 'supplier-2' })])
    queueSelect('users', [{ preferredLocale: 'en' }])

    const res = await (await app()).request('/suppliers')
    const body = (await res.json()) as { suppliers: Row[] }

    expect(viewerBatchCalls).not.toHaveBeenCalled()
    expect(completeChat).not.toHaveBeenCalled()
    expect(selectLog).not.toContain('content_translations')
    expect(body.suppliers[0].notes).toBe('Delivers on Tuesdays, payment at 30 days')
  })

  it('reads 30 suppliers with one batched call and one call per distinct string', async () => {
    queueSelect(
      'suppliers',
      Array.from({ length: 30 }, (_, index) => supplierRow({ id: `supplier-${index}` })),
    )
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await (await app()).request('/suppliers')
    const body = (await res.json()) as { suppliers: Row[] }

    expect(body.suppliers).toHaveLength(30)
    expect(viewerBatchCalls).toHaveBeenCalledTimes(1)
    expect(completeChat).toHaveBeenCalledTimes(1)
    expect(body.suppliers[29].notes).toBe('Livre le mardi, paiement à 30 jours')
  })
})
