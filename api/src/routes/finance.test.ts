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
const { convertToNgn, extractInvoiceFields, readFile, unlink } = vi.hoisted(() => ({
  convertToNgn: vi.fn(),
  extractInvoiceFields: vi.fn(),
  readFile: vi.fn(),
  unlink: vi.fn(),
}))

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
      groupBy: same,
      limit: same,
      then: (resolve: (value: Row[]) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(rows).then(resolve, reject),
    })
    return self
  }

  const dbMock = {
      select: selectChain,
      insert: (table: unknown) => ({
        values: (values: Row) => {
          inserted.push({ table: nameOf(table), values })
          const result = {
            returning: async () => [{ id: `${nameOf(table)}-new`, ...values }],
            onConflictDoNothing: () => ({
              returning: async () => [{ id: `${nameOf(table)}-new`, ...values }],
            }),
            onConflictDoUpdate: () => ({
              returning: async () => [{ id: `${nameOf(table)}-new`, ...values }],
            }),
          }
          return result
        },
      }),
      update: (table: unknown) => ({
        set: (patch: Row) => {
          updates.push({ table: nameOf(table), patch })
          return { where: () => ({ returning: async () => [{ ...updatedRow, ...patch }] }) }
        },
      }),
      delete: () => ({ where: async () => undefined }),
      transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(dbMock),
  }
  return {
    db: dbMock,
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
vi.mock('../lib/finance-inbound-ack.js', () => ({
  maybeSendInboundApprovalAck: vi.fn(async () => ({ sent: true, to: 'billing@resend.com' })),
}))
vi.mock('../lib/invoice-extract.js', () => ({ extractInvoiceFields }))
vi.mock('../lib/currency-fx.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/currency-fx.js')>()
  return {
    ...actual,
    convertToNgn,
  }
})
vi.mock('../lib/evidence-store.js', () => ({
  getEvidenceStorageRoot: () => '/tmp/trovara-evidence-test',
}))
vi.mock('node:fs/promises', () => ({
  access: vi.fn(),
  readFile,
  unlink,
}))

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
  costCentreCode: 'CC01' as const,
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
    costCentreCode: 'CC01',
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
  readFile.mockResolvedValue(Buffer.from('%PDF-1.4'))
  extractInvoiceFields.mockResolvedValue({
    amount: 4500,
    currency: 'USD',
    vendor: 'Resend',
    expenseDate: new Date('2026-08-10T12:00:00.000Z'),
    method: 'pdf_text',
  })
  convertToNgn.mockResolvedValue({
    amount: 6975000,
    currency: 'NGN',
    originalAmount: '4500',
    originalCurrency: 'USD',
    fxRate: '1550',
    fxConvertedAt: new Date('2026-08-10T12:01:00.000Z'),
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
  it('validates labels before creating the expense', async () => {
    queueSelect('users', [{ preferredLocale: 'en' }])
    queueSelect('expense_labels', [])

    const res = await post('/finance', {
      ...FRENCH_EXPENSE,
      description: 'Fuel delivery',
      labelIds: ['11111111-1111-4111-8111-111111111111'],
    })

    expect(res.status).toBe(400)
    expect(inserted.some((entry) => entry.table === 'expenses')).toBe(false)
  })

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
  it('requires a cost centre before a pending expense can be approved', async () => {
    queueSelect('expenses', [
      expenseRow({ costCentreCode: null, approvalStatus: 'pending' }),
    ])

    const res = await patch('/finance/expense-1', { approvalStatus: 'approved' })

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      error: 'Assign a cost centre before approving this expense',
    })
    expect(updates).toHaveLength(0)
  })

  it('does not approve an unconverted foreign-currency expense', async () => {
    queueSelect('expenses', [expenseRow({ amount: 20, currency: 'USD', approvalStatus: 'pending' })])

    const res = await patch('/finance/expense-1', { approvalStatus: 'approved' })

    expect(res.status).toBe(409)
    expect(updates).toHaveLength(0)
  })

  it('acks the inbound sender when approving a pending inbound draft', async () => {
    const { maybeSendInboundApprovalAck } = await import('../lib/finance-inbound-ack.js')
    queueSelect('expenses', [
      expenseRow({
        source: 'inbound_email',
        approvalStatus: 'pending',
        inboundSenderEmail: 'billing@resend.com',
      }),
    ])
    updatedRow = expenseRow({
      source: 'inbound_email',
      approvalStatus: 'pending',
      inboundSenderEmail: 'billing@resend.com',
    })

    const res = await patch('/finance/expense-1', { approvalStatus: 'approved' })
    const body = (await res.json()) as { inboundAck?: { sent: boolean; to?: string } }

    expect(res.status).toBe(200)
    expect(maybeSendInboundApprovalAck).toHaveBeenCalled()
    expect(body.inboundAck).toEqual({ sent: true, to: 'billing@resend.com' })
  })

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

describe('POST /finance/:id/convert-currency', () => {
  it('stores NGN plus the original receipt amount and rate', async () => {
    const foreign = expenseRow({ amount: 20, currency: 'USD', approvalStatus: 'pending' })
    queueSelect('expenses', [foreign])
    updatedRow = foreign
    convertToNgn.mockResolvedValueOnce({
      amount: 31000,
      currency: 'NGN',
      originalAmount: '20',
      originalCurrency: 'USD',
      fxRate: '1550',
      fxConvertedAt: new Date('2026-08-10T12:01:00.000Z'),
    })

    const res = await post('/finance/expense-1/convert-currency', {})

    expect(res.status).toBe(200)
    expect(updates[0].patch).toMatchObject({
      amount: 31000,
      currency: 'NGN',
      originalAmount: '20',
      originalCurrency: 'USD',
      fxRate: '1550',
    })
  })

  it('returns 422 when the converted naira amount overflows integer storage', async () => {
    const { FxAmountOverflowError } = await import('../lib/currency-fx.js')
    const foreign = expenseRow({ amount: 2_000_000, currency: 'USD', approvalStatus: 'pending' })
    queueSelect('expenses', [foreign])
    convertToNgn.mockRejectedValueOnce(new FxAmountOverflowError())

    const res = await post('/finance/expense-1/convert-currency', {})

    expect(res.status).toBe(422)
    expect(updates).toHaveLength(0)
  })
})

describe('DELETE /finance/:id', () => {
  it('removes the attachment before deleting the expense row', async () => {
    queueSelect('expenses', [
      expenseRow({
        source: 'inbound_email',
        attachmentStorageKey: 'finance-inbound/farm-1/invoice.pdf',
      }),
    ])
    unlink.mockResolvedValueOnce(undefined)

    const res = await (await app()).request('/finance/expense-1', { method: 'DELETE' })

    expect(res.status).toBe(200)
    expect(unlink).toHaveBeenCalled()
  })

  it('deletes the expense and queues attachment cleanup when unlink fails', async () => {
    queueSelect('expenses', [
      expenseRow({
        source: 'inbound_email',
        attachmentStorageKey: 'finance-inbound/farm-1/invoice.pdf',
      }),
    ])
    unlink.mockRejectedValueOnce(Object.assign(new Error('EACCES'), { code: 'EACCES' }))

    const res = await (await app()).request('/finance/expense-1', { method: 'DELETE' })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ ok: true, cleanupPending: true })
    expect(
      inserted.find((entry) => entry.table === 'storage_cleanup_jobs')?.values,
    ).toMatchObject({
      storageRoot: 'evidence',
      storageKey: 'finance-inbound/farm-1/invoice.pdf',
    })
  })
})

describe('POST /finance/labels', () => {
  it('creates labels with non-Latin names', async () => {
    const res = await post('/finance/labels', { name: '旅費' })
    const body = (await res.json()) as { label: Row }

    expect(res.status).toBe(201)
    expect(inserted.find((entry) => entry.table === 'expense_labels')?.values).toMatchObject({
      name: '旅費',
      slug: '旅費',
    })
    expect(body.label.name).toBe('旅費')
  })
})

describe('POST /finance/:id/retry-extraction', () => {
  const inboundExpense = () =>
    expenseRow({
      source: 'inbound_email',
      approvalStatus: 'pending',
      attachmentStorageKey: 'finance-inbound/farm-1/invoice.pdf',
      attachmentMimeType: 'application/pdf',
      attachmentFilename: 'invoice.pdf',
    })

  it('updates useful extracted fields while preserving pending review', async () => {
    queueSelect('expenses', [inboundExpense()])
    updatedRow = inboundExpense()

    const res = await post('/finance/expense-1/retry-extraction', {})
    const body = (await res.json()) as Row

    expect(res.status).toBe(200)
    expect(body).toMatchObject({
      extractionMethod: 'pdf_text',
      extractionStatus: 'success',
      updatedFields: ['amount', 'currency', 'vendor', 'expenseDate'],
    })
    expect(updates[0].patch).toMatchObject({
      amount: 6975000,
      currency: 'NGN',
      originalAmount: '4500',
      originalCurrency: 'USD',
      fxRate: '1550',
      vendor: 'Resend',
      expenseDate: new Date('2026-08-10T12:00:00.000Z'),
      extractionMethod: 'pdf_text',
      extractionStatus: 'success',
    })
    expect(updates[0].patch).not.toHaveProperty('approvalStatus')
    expect((body.expense as Row).approvalStatus).toBe('pending')
  })

  it('rejects roles other than owner or supervisor', async () => {
    sessionUser = { ...sessionUser, role: 'sales' }

    const res = await post('/finance/expense-1/retry-extraction', {})

    expect(res.status).toBe(403)
    expect(extractInvoiceFields).not.toHaveBeenCalled()
  })

  it('records extraction failure without changing existing expense fields', async () => {
    queueSelect('expenses', [inboundExpense()])
    updatedRow = inboundExpense()
    extractInvoiceFields.mockRejectedValueOnce(new Error('PDF parser unavailable'))

    const res = await post('/finance/expense-1/retry-extraction', {})
    const body = (await res.json()) as Row

    expect(res.status).toBe(200)
    expect(body).toMatchObject({
      extractionMethod: 'none',
      extractionStatus: 'failed',
      updatedFields: [],
    })
    expect(updates[0].patch).toEqual({
      extractionMethod: 'none',
      extractionStatus: 'failed',
    })
  })

  it('is safe to repeat and does not create another expense', async () => {
    queueSelect('expenses', [inboundExpense()])
    queueSelect('expenses', [inboundExpense()])
    updatedRow = inboundExpense()

    const first = await post('/finance/expense-1/retry-extraction', {})
    const second = await post('/finance/expense-1/retry-extraction', {})

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(updates.map((entry) => entry.patch)).toHaveLength(2)
    expect(updates[1].patch).toEqual(updates[0].patch)
    expect(inserted.filter((entry) => entry.table === 'expenses')).toHaveLength(0)
  })
})

describe('GET /finance - viewer locale on read', () => {
  it('returns the stable cost-centre catalogue from the Finance workbook', async () => {
    const res = await (await app()).request('/finance/cost-centres')
    const body = (await res.json()) as { costCentres: Row[] }

    expect(res.status).toBe(200)
    expect(body.costCentres).toHaveLength(9)
    expect(body.costCentres).toEqual(
      expect.arrayContaining([
        { code: 'CC01', name: 'Corporate / Admin', covers: 'General Trovara overhead' },
        { code: 'CC10', name: 'Plantain', covers: 'Plantain production' },
        { code: 'CC20', name: 'Coconut', covers: 'Coconut estate' },
        { code: 'CC40', name: 'Poultry', covers: 'Project Feather' },
      ]),
    )
  })

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
  it('groups approved expenses by cost centre and keeps legacy rows visible', async () => {
    queueSelect('orders', [])
    queueSelect('expenses', [
      expenseRow({ id: 'plantain-1', costCentreCode: 'CC10', amount: 60000 }),
      expenseRow({ id: 'plantain-2', costCentreCode: 'CC10', amount: 15000 }),
      expenseRow({ id: 'poultry-1', costCentreCode: 'CC40', amount: 25000 }),
      expenseRow({ id: 'legacy-1', costCentreCode: null, amount: 5000 }),
    ])
    queueSelect('payment_attempts', [])
    queueSelect('orders', [])
    queueSelect('payment_refunds', [])
    queueSelect('invoices', [])
    queueSelect('expense_label_links', [])

    const res = await (await app()).request('/finance/summary')
    const body = (await res.json()) as { summary: Row }

    expect(res.status).toBe(200)
    expect(body.summary.expensesByCostCentre).toMatchObject({
      CC10: { total: 75000, expenseCount: 2 },
      CC40: { total: 25000, expenseCount: 1 },
      CC20: { total: 0, expenseCount: 0 },
    })
    expect(body.summary).toMatchObject({
      unassignedCostCentreTotal: 5000,
      unassignedCostCentreCount: 1,
    })
  })

  it('excludes pending, rejected, and unconverted foreign expenses from NGN P&L', async () => {
    queueSelect('orders', [])
    queueSelect('expenses', [
      expenseRow({ id: 'approved-ngn', amount: 10000 }),
      expenseRow({ id: 'pending-ngn', amount: 20000, approvalStatus: 'pending' }),
      expenseRow({ id: 'rejected-ngn', amount: 30000, approvalStatus: 'rejected' }),
      expenseRow({ id: 'approved-usd', amount: 20, currency: 'USD' }),
    ])
    queueSelect('payment_attempts', [])
    queueSelect('orders', [])
    queueSelect('payment_refunds', [])
    queueSelect('invoices', [])
    queueSelect('expense_label_links', [])

    const res = await (await app()).request('/finance/summary')
    const body = (await res.json()) as { summary: Row }

    expect(res.status).toBe(200)
    expect(body.summary).toMatchObject({
      currency: 'NGN',
      totalExpenses: 10000,
      netProfit: -10000,
      expenseCount: 1,
      pendingExpenseCount: 1,
      rejectedExpenseCount: 1,
      unconvertedForeignCount: 1,
    })
  })

  it('translates nothing for a French viewer', async () => {
    queueSelect('orders', [{ status: 'delivered', totalAmount: 45000, currency: 'NGN' }])
    queueSelect('expenses', [expenseRow()])
    queueSelect('payment_attempts', [{ totalKobo: 4500000 }])
    queueSelect('orders', [{ totalAmount: 12000, currency: 'NGN' }])
    queueSelect('payment_refunds', [])
    queueSelect('invoices', [{ total: 3 }])
    queueSelect('expense_label_links', [])

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

  it('excludes foreign-currency order revenue from NGN P&L', async () => {
    queueSelect('orders', [
      { status: 'delivered', totalAmount: 50000, currency: 'NGN' },
      { status: 'delivered', totalAmount: 20, currency: 'USD' },
    ])
    queueSelect('expenses', [expenseRow({ amount: 10000 })])
    queueSelect('payment_attempts', [])
    queueSelect('orders', [
      { totalAmount: 8000, currency: 'NGN' },
      { totalAmount: 5, currency: 'USD' },
    ])
    queueSelect('payment_refunds', [])
    queueSelect('invoices', [])
    queueSelect('expense_label_links', [])

    const res = await (await app()).request('/finance/summary')
    const body = (await res.json()) as { summary: Row }

    expect(res.status).toBe(200)
    expect(body.summary).toMatchObject({
      currency: 'NGN',
      revenue: 50000,
      deliveredRevenue: 50000,
      outstandingInvoices: 8000,
      totalExpenses: 10000,
      netProfit: 40000,
      orderCount: 1,
    })
  })

  it('applies the label filter to totals, categories, and label groups', async () => {
    queueSelect('orders', [])
    queueSelect('expenses', [
      expenseRow({ id: 'expense-capex', amount: 100000, category: 'equipment' }),
      expenseRow({ id: 'expense-opex', amount: 25000, category: 'utilities' }),
    ])
    queueSelect('payment_attempts', [])
    queueSelect('orders', [])
    queueSelect('payment_refunds', [])
    queueSelect('invoices', [])
    queueSelect('expense_label_links', [
      {
        expenseId: 'expense-capex',
        labelId: 'label-capex',
        labelName: 'Capex',
        labelSlug: 'capex',
      },
      {
        expenseId: 'expense-capex',
        labelId: 'label-recurring',
        labelName: 'Recurring',
        labelSlug: 'recurring',
      },
      {
        expenseId: 'expense-opex',
        labelId: 'label-recurring',
        labelName: 'Recurring',
        labelSlug: 'recurring',
      },
    ])

    const res = await (await app()).request('/finance/summary?labelId=label-capex')
    const body = (await res.json()) as { summary: Row }

    expect(res.status).toBe(200)
    expect(body.summary).toMatchObject({
      totalExpenses: 100000,
      expenseCount: 1,
      expensesByCategory: { equipment: 100000 },
      expensesByLabel: {
        'label-capex': { name: 'Capex', slug: 'capex', total: 100000 },
        'label-recurring': { name: 'Recurring', slug: 'recurring', total: 100000 },
      },
    })
  })
})
