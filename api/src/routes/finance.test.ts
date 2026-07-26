import { Hono } from 'hono'
import { getTableName } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, unknown>

const nameOf = (table: unknown) => getTableName(table as never)

let sessionUser: Row = {
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
            returning: async () => [{ id: `${nameOf(table)}-new`, ...values }],
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
 * the tests see its real short-circuits. The spies count how often a route
 * enters the service at all; `canonicalThrows` simulates the service itself
 * failing, which is the only path the route's own try/catch covers.
 */
const canonicalCalls = vi.fn()
const viewerBatchCalls = vi.fn()
let canonicalThrows = false

vi.mock('../lib/content-locale.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/content-locale.js')>()
  return {
    ...actual,
    toCanonicalEnglish: (args: Parameters<typeof actual.toCanonicalEnglish>[0]) => {
      canonicalCalls(args)
      if (canonicalThrows) throw new Error('translation service down')
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
  'Carburant pour le générateur pendant la panne': 'Fuel for the generator during the outage',
  "Réparation de la pompe d'irrigation": 'Irrigation pump repair',
}

const ENGLISH_TO_FRENCH: Record<string, string> = {
  'Fuel for the generator during the outage': 'Carburant pour le générateur pendant la panne',
  'Irrigation pump repair': "Réparation de la pompe d'irrigation",
}

/** A create whose vendor, receipt reference and money must survive untouched. */
const FRENCH_EXPENSE = {
  category: 'utilities' as const,
  description: 'Carburant pour le générateur pendant la panne',
  amount: 125000,
  currency: 'NGN',
  vendor: 'Ikeja Fuel Depot',
  receiptRef: 'TRV-RCP-2026-00042',
  expenseDate: '2026-07-20T08:00:00Z',
}

function expenseRow(overrides: Row = {}): Row {
  return {
    id: 'expense-1',
    farmId: 'farm-1',
    category: 'utilities',
    description: 'Fuel for the generator during the outage',
    amount: 125000,
    currency: 'NGN',
    vendor: 'Ikeja Fuel Depot',
    receiptRef: 'TRV-RCP-2026-00042',
    sourceLocale: null,
    translationStatus: 'done',
    translationAttempts: 0,
    approvalStatus: 'approved',
    recordedById: 'user-owner',
    expenseDate: new Date('2026-07-20T08:00:00Z'),
    createdAt: new Date('2026-07-20T08:05:00Z'),
    ...overrides,
  }
}

async function app() {
  const { financeRoutes } = await import('./finance.js')
  const instance = new Hono()
  instance.route('/finance', financeRoutes)
  return instance
}

async function post(path: string, body: unknown) {
  return (await app()).request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function patch(path: string, body: unknown) {
  return (await app()).request(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function insertedExpense(): Row {
  const row = inserted.find((entry) => entry.table === 'expenses')
  expect(row).toBeDefined()
  return row!.values
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
  updatedRow = expenseRow()
  canonicalThrows = false
  isLlmConfigured.mockReturnValue(true)
  completeChat.mockImplementation(async (system: string, text: string) => {
    const table = /into English/i.test(system) ? FRENCH_TO_ENGLISH : ENGLISH_TO_FRENCH
    return { text: table[text] ?? `[${text}]`, model: 'test' }
  })
  sessionUser = {
    id: 'user-owner',
    farmId: 'farm-1',
    role: 'owner',
    name: 'Owner',
    email: 'owner@trovara.farm',
  }
})

describe('POST /finance - canonical English on write', () => {
  it('stores a French description in English with the author locale', async () => {
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await post('/finance', FRENCH_EXPENSE)

    expect(res.status).toBe(201)
    expect(insertedExpense()).toMatchObject({
      description: 'Fuel for the generator during the outage',
      sourceLocale: 'fr',
      translationStatus: 'done',
    })
  })

  it('leaves the vendor, the receipt reference, the category and the money verbatim', async () => {
    queueSelect('users', [{ preferredLocale: 'fr' }])

    await post('/finance', FRENCH_EXPENSE)

    expect(insertedExpense()).toMatchObject({
      category: 'utilities',
      amount: 125000,
      currency: 'NGN',
      vendor: 'Ikeja Fuel Depot',
      receiptRef: 'TRV-RCP-2026-00042',
    })
    // The description is the only prose; nothing else reaches the translator.
    expect(translatedTexts()).toEqual(['Carburant pour le générateur pendant la panne'])
  })

  it('returns the author their own words while storing the English', async () => {
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await post('/finance', FRENCH_EXPENSE)
    const body = (await res.json()) as { expense: Row }

    expect(body.expense.description).toBe('Carburant pour le générateur pendant la panne')
    expect(insertedExpense().description).toBe('Fuel for the generator during the outage')
  })

  it('stores the original as pending and still succeeds when the LLM is unavailable', async () => {
    isLlmConfigured.mockReturnValue(false)
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await post('/finance', FRENCH_EXPENSE)

    expect(res.status).toBe(201)
    expect(insertedExpense()).toMatchObject({
      description: 'Carburant pour le générateur pendant la panne',
      sourceLocale: 'fr',
      translationStatus: 'pending',
    })
  })

  it('still succeeds and stays pending when the translator throws', async () => {
    completeChat.mockRejectedValue(new Error('upstream 503'))
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await post('/finance', FRENCH_EXPENSE)

    expect(res.status).toBe(201)
    expect(insertedExpense()).toMatchObject({
      description: 'Carburant pour le générateur pendant la panne',
      translationStatus: 'pending',
    })
  })

  it('never labels a failed write English, so the retry job can still find it', async () => {
    canonicalThrows = true
    queueSelect('users', [{ preferredLocale: 'en' }])

    const res = await post('/finance', FRENCH_EXPENSE)

    expect(res.status).toBe(201)
    // 'en' would short-circuit the retry job's own `toCanonicalEnglish` call and
    // freeze this row as English while it holds French.
    expect(insertedExpense()).toMatchObject({
      description: 'Carburant pour le générateur pendant la panne',
      sourceLocale: null,
      translationStatus: 'pending',
    })
  })

  it('makes no translation call at all for an English create', async () => {
    queueSelect('users', [{ preferredLocale: 'en' }])

    const res = await post('/finance', {
      ...FRENCH_EXPENSE,
      description: 'Fuel for the generator during the outage',
    })

    expect(res.status).toBe(201)
    expect(completeChat).not.toHaveBeenCalled()
    expect(insertedExpense()).toMatchObject({
      description: 'Fuel for the generator during the outage',
      sourceLocale: 'en',
      translationStatus: 'done',
    })
  })
})

describe('PATCH /finance/:id - canonical English on write', () => {
  it('normalizes a French description and echoes the author', async () => {
    queueSelect('expenses', [expenseRow()])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await patch('/finance/expense-1', {
      description: "Réparation de la pompe d'irrigation",
    })
    const body = (await res.json()) as { expense: Row }

    expect(res.status).toBe(200)
    expect(updates[0]).toMatchObject({
      table: 'expenses',
      patch: { description: 'Irrigation pump repair', sourceLocale: 'fr' },
    })
    expect(body.expense.description).toBe("Réparation de la pompe d'irrigation")
  })

  it('does not downgrade a row the retry job still owes work on', async () => {
    queueSelect('expenses', [expenseRow({ translationStatus: 'pending', sourceLocale: 'yo' })])
    queueSelect('users', [{ preferredLocale: 'en' }])

    await patch('/finance/expense-1', { description: 'Irrigation pump repair' })

    // The row keeps the debt and the label it already had. 'Irrigation pump
    // repair' is three words French spells almost identically, so the new text
    // cannot place itself either and must not overwrite the older, better hint.
    expect(updates[0].patch).toMatchObject({
      sourceLocale: 'yo',
      translationStatus: 'pending',
    })
  })

  it('leaves the amount and the receipt reference alone on a money-only edit', async () => {
    queueSelect('expenses', [expenseRow()])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    await patch('/finance/expense-1', { amount: 130000, receiptRef: 'TRV-RCP-2026-00043' })

    expect(canonicalCalls).not.toHaveBeenCalled()
    expect(updates[0]).toMatchObject({
      table: 'expenses',
      patch: { amount: 130000, receiptRef: 'TRV-RCP-2026-00043' },
    })
  })

  it('renders a description the author did not touch in the viewer language', async () => {
    queueSelect('expenses', [expenseRow()])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await patch('/finance/expense-1', { amount: 130000 })
    const body = (await res.json()) as { expense: Row }

    expect(viewerBatchCalls).toHaveBeenCalledTimes(1)
    expect(body.expense.description).toBe('Carburant pour le générateur pendant la panne')
  })
})

describe('GET /finance - viewer locale on read', () => {
  it('translates every description in one batched call', async () => {
    queueSelect('expenses', [
      expenseRow(),
      expenseRow({ id: 'expense-2', description: 'Irrigation pump repair' }),
    ])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await (await app()).request('/finance')
    const body = (await res.json()) as { expenses: Row[] }

    expect(res.status).toBe(200)
    expect(viewerBatchCalls).toHaveBeenCalledTimes(1)
    expect(selectLog.filter((table) => table === 'content_translations')).toHaveLength(1)
    expect(body.expenses[0].description).toBe('Carburant pour le générateur pendant la panne')
    expect(body.expenses[1].description).toBe("Réparation de la pompe d'irrigation")
  })

  it('never sends the vendor, the receipt reference or the category to the translator', async () => {
    queueSelect('expenses', [expenseRow()])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await (await app()).request('/finance')
    const expense = ((await res.json()) as { expenses: Row[] }).expenses[0]

    expect(expense).toMatchObject({
      vendor: 'Ikeja Fuel Depot',
      receiptRef: 'TRV-RCP-2026-00042',
      category: 'utilities',
      amount: 125000,
      currency: 'NGN',
    })
    expect(translatedTexts()).toEqual(['Fuel for the generator during the outage'])
  })

  it('does no translation work at all for an English viewer', async () => {
    queueSelect('expenses', [expenseRow(), expenseRow({ id: 'expense-2' })])
    queueSelect('users', [{ preferredLocale: 'en' }])

    const res = await (await app()).request('/finance')
    const body = (await res.json()) as { expenses: Row[] }

    expect(viewerBatchCalls).not.toHaveBeenCalled()
    expect(completeChat).not.toHaveBeenCalled()
    expect(selectLog).not.toContain('content_translations')
    expect(body.expenses[0].description).toBe('Fuel for the generator during the outage')
  })

  it('reads 40 expenses with one batched call and one call per distinct string', async () => {
    queueSelect(
      'expenses',
      Array.from({ length: 40 }, (_, index) => expenseRow({ id: `expense-${index}` })),
    )
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await (await app()).request('/finance')
    const body = (await res.json()) as { expenses: Row[] }

    expect(body.expenses).toHaveLength(40)
    expect(viewerBatchCalls).toHaveBeenCalledTimes(1)
    expect(completeChat).toHaveBeenCalledTimes(1)
    expect(body.expenses[39].description).toBe('Carburant pour le générateur pendant la panne')
  })
})

describe('GET /finance/summary - money only', () => {
  it('translates nothing for a French viewer', async () => {
    queueSelect('orders', [{ status: 'delivered', totalAmount: 45000 }])
    queueSelect('expenses', [expenseRow()])
    queueSelect('payment_attempts', [{ totalKobo: 4500000 }])
    queueSelect('orders', [{ totalAmount: 12000 }])
    queueSelect('payment_refunds', [])
    queueSelect('invoices', [{ total: 3 }])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await (await app()).request('/finance/summary')
    const body = (await res.json()) as { summary: Row }

    expect(res.status).toBe(200)
    expect(viewerBatchCalls).not.toHaveBeenCalled()
    expect(completeChat).not.toHaveBeenCalled()
    expect(body.summary).toMatchObject({
      currency: 'NGN',
      revenue: 45000,
      totalExpenses: 125000,
      expensesByCategory: { utilities: 125000 },
    })
  })
})
