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
          return { where: async () => undefined }
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

const createHarvestLotForOrder = vi.fn(async () => ({ id: 'lot-new', lotCode: 'LOT-1' }))
vi.mock('../lib/harvest-lots.js', () => ({
  createHarvestLotForOrder: (...args: unknown[]) => createHarvestLotForOrder(...(args as [])),
}))

const transitionOrder = vi.fn()
vi.mock('../lib/order-fulfillment.js', () => ({
  transitionOrder: (...args: unknown[]) => transitionOrder(...args),
}))

const initiateRefund = vi.fn()
vi.mock('../lib/order-payments.js', () => ({
  applySuccessfulPayment: vi.fn(),
  createPaymentAttemptForOrder: vi.fn(),
  initiateRefund: (...args: unknown[]) => initiateRefund(...args),
}))

vi.mock('../lib/paystack.js', () => ({
  authorizationUrlFromAccessCode: vi.fn(),
  isPaystackConfigured: vi.fn(() => true),
  verifyTransaction: vi.fn(),
}))

vi.mock('../lib/invoice-html.js', () => ({ renderInvoiceHtml: vi.fn(() => '<html></html>') }))
vi.mock('../lib/invoice-pdf.js', () => ({ renderInvoicePdf: vi.fn(async () => Buffer.from('')) }))

const FRENCH_TO_ENGLISH: Record<string, string> = {
  'Livrer avant midi, code du portail requis': 'Deliver before noon, gate code needed',
  'Le client a reçu des tubercules abîmés': 'The customer received damaged tubers',
  'Appeler le chauffeur avant le départ': 'Call the driver before departure',
}

const ENGLISH_TO_FRENCH: Record<string, string> = {
  'Deliver before noon, gate code needed': 'Livrer avant midi, code du portail requis',
  'The plantains arrived fresh and well packed':
    'Les plantains sont arrivés frais et bien emballés',
}

/** A staff create whose customer, money and reference must survive untouched. */
const FRENCH_ORDER = {
  customerName: 'Mme Diallo',
  customerPhone: '+2348012345678',
  totalAmount: 45000,
  currency: 'NGN',
  notes: 'Livrer avant midi, code du portail requis',
}

function orderRow(overrides: Row = {}): Row {
  return {
    id: 'aa11bb22-cc33-4d44-8e55-ff6677889900',
    customerName: 'Mme Diallo',
    customerPhone: '+2348012345678',
    status: 'confirmed',
    paymentStatus: 'paid',
    totalAmount: 45000,
    currency: 'NGN',
    lotId: null,
    lotCode: 'LOT-20260720-001',
    source: 'staff',
    customerContactId: null,
    notes: 'Deliver before noon, gate code needed',
    dispatchedAt: null,
    deliveryPhotoUrl: null,
    customerFeedback: 'The plantains arrived fresh and well packed',
    customerFeedbackAt: null,
    cancelledBy: null,
    refundRequestedAt: null,
    createdAt: new Date('2026-07-20T08:00:00Z'),
    updatedAt: new Date('2026-07-20T09:00:00Z'),
    sourceLocale: null,
    translationStatus: 'done',
    invoiceId: null,
    ...overrides,
  }
}

/** A bot order: `notes` holds the delivery address the customer typed. */
function botOrderRow(overrides: Row = {}): Row {
  return orderRow({
    id: 'bb22cc33-dd44-4e55-9f66-001122334455',
    source: 'whatsapp',
    customerContactId: 'contact-1',
    notes: 'Delivery: 12 Awolowo Road, Ikeja',
    ...overrides,
  })
}

async function app() {
  const { salesRoutes } = await import('./sales.js')
  const instance = new Hono()
  instance.route('/sales', salesRoutes)
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

function insertedOrder(): Row {
  const row = inserted.find((entry) => entry.table === 'orders')
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
  canonicalThrows = false
  isLlmConfigured.mockReturnValue(true)
  completeChat.mockImplementation(async (system: string, text: string) => {
    const table = /into English/i.test(system) ? FRENCH_TO_ENGLISH : ENGLISH_TO_FRENCH
    return { text: table[text] ?? `[${text}]`, model: 'test' }
  })
  createHarvestLotForOrder.mockResolvedValue({ id: 'lot-new', lotCode: 'LOT-1' })
  initiateRefund.mockResolvedValue({
    ok: true,
    refund: { id: 'refund-1', amountKobo: 45000, status: 'success', reason: 'stored' },
  })
  transitionOrder.mockResolvedValue({ ok: true, order: orderRow({ status: 'dispatched' }) })
  sessionUser = {
    id: 'user-owner',
    farmId: 'farm-1',
    role: 'owner',
    name: 'Owner',
    email: 'owner@trovara.farm',
  }
})

describe('POST /sales - canonical English on write', () => {
  it('stores a French order note in English with the author locale', async () => {
    queueSelect('users', [{ preferredLocale: 'fr' }])
    queueSelect('orders', [orderRow()])

    const res = await post('/sales', FRENCH_ORDER)

    expect(res.status).toBe(201)
    expect(insertedOrder()).toMatchObject({
      notes: 'Deliver before noon, gate code needed',
      sourceLocale: 'fr',
      translationStatus: 'done',
    })
  })

  it('leaves the customer, the money and the currency verbatim', async () => {
    queueSelect('users', [{ preferredLocale: 'fr' }])
    queueSelect('orders', [orderRow()])

    await post('/sales', FRENCH_ORDER)

    expect(insertedOrder()).toMatchObject({
      customerName: 'Mme Diallo',
      customerPhone: '+2348012345678',
      totalAmount: 45000,
      currency: 'NGN',
      source: 'staff',
    })
    // The note is the only prose; nothing else reaches the translator.
    expect(translatedTexts()).toEqual(['Livrer avant midi, code du portail requis'])
  })

  it('returns the author their own words while storing the English', async () => {
    queueSelect('users', [{ preferredLocale: 'fr' }])
    queueSelect('orders', [orderRow()])

    const res = await post('/sales', FRENCH_ORDER)
    const body = (await res.json()) as { order: Row }

    expect(body.order.notes).toBe('Livrer avant midi, code du portail requis')
    expect(insertedOrder().notes).toBe('Deliver before noon, gate code needed')
  })

  it('gives the auto-created harvest lot the canonical English label', async () => {
    queueSelect('users', [{ preferredLocale: 'fr' }])
    queueSelect('orders', [orderRow()])

    await post('/sales', FRENCH_ORDER)

    expect(createHarvestLotForOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        lines: [
          expect.objectContaining({ productName: 'Deliver before noon, gate code needed' }),
        ],
      }),
    )
  })

  it('stores the original as pending and still succeeds when the LLM is unavailable', async () => {
    isLlmConfigured.mockReturnValue(false)
    queueSelect('users', [{ preferredLocale: 'fr' }])
    queueSelect('orders', [orderRow()])

    const res = await post('/sales', FRENCH_ORDER)

    expect(res.status).toBe(201)
    expect(insertedOrder()).toMatchObject({
      notes: 'Livrer avant midi, code du portail requis',
      sourceLocale: 'fr',
      translationStatus: 'pending',
    })
  })

  it('still succeeds and stays pending when the translator throws', async () => {
    completeChat.mockRejectedValue(new Error('upstream 503'))
    queueSelect('users', [{ preferredLocale: 'fr' }])
    queueSelect('orders', [orderRow()])

    const res = await post('/sales', FRENCH_ORDER)

    expect(res.status).toBe(201)
    expect(insertedOrder()).toMatchObject({
      notes: 'Livrer avant midi, code du portail requis',
      translationStatus: 'pending',
    })
  })

  it('never labels a failed write English, so the retry job can still find it', async () => {
    canonicalThrows = true
    queueSelect('users', [{ preferredLocale: 'en' }])
    queueSelect('orders', [orderRow()])

    const res = await post('/sales', FRENCH_ORDER)

    expect(res.status).toBe(201)
    // 'en' would short-circuit the retry job's own `toCanonicalEnglish` call and
    // freeze this row as English while it holds French.
    expect(insertedOrder()).toMatchObject({
      notes: 'Livrer avant midi, code du portail requis',
      sourceLocale: null,
      translationStatus: 'pending',
    })
  })

  it('makes no translation call at all for an English create', async () => {
    queueSelect('users', [{ preferredLocale: 'en' }])
    queueSelect('orders', [orderRow()])

    const res = await post('/sales', {
      ...FRENCH_ORDER,
      notes: 'Deliver before noon, gate code needed',
    })

    expect(res.status).toBe(201)
    expect(completeChat).not.toHaveBeenCalled()
    expect(insertedOrder()).toMatchObject({
      notes: 'Deliver before noon, gate code needed',
      sourceLocale: 'en',
      translationStatus: 'done',
    })
  })

  it('does not enter the translation service for an order with no notes', async () => {
    queueSelect('users', [{ preferredLocale: 'fr' }])
    queueSelect('orders', [orderRow()])

    const res = await post('/sales', { customerName: 'Mme Diallo', totalAmount: 45000 })

    expect(res.status).toBe(201)
    expect(canonicalCalls).not.toHaveBeenCalled()
    expect(insertedOrder()).toMatchObject({ notes: null, translationStatus: 'done' })
  })
})

describe('PATCH /sales/:id - canonical English on write', () => {
  it('normalizes a French note on a staff order and echoes the author', async () => {
    queueSelect('orders', [orderRow()])
    queueSelect('users', [{ preferredLocale: 'fr' }])
    queueSelect('orders', [orderRow({ notes: 'Call the driver before departure' })])

    const res = await patch('/sales/order-1', { notes: 'Appeler le chauffeur avant le départ' })
    const body = (await res.json()) as { order: Row }

    expect(res.status).toBe(200)
    expect(updates[0]).toMatchObject({
      table: 'orders',
      patch: {
        notes: 'Call the driver before departure',
        sourceLocale: 'fr',
      },
    })
    expect(body.order.notes).toBe('Appeler le chauffeur avant le départ')
  })

  it('leaves a bot order\u2019s delivery address exactly as the customer typed it', async () => {
    queueSelect('orders', [botOrderRow()])
    queueSelect('users', [{ preferredLocale: 'fr' }])
    queueSelect('orders', [botOrderRow({ notes: 'Delivery: 4 Marina Street, Lagos Island' })])

    const res = await patch('/sales/order-2', { notes: 'Delivery: 4 Marina Street, Lagos Island' })

    expect(res.status).toBe(200)
    expect(canonicalCalls).not.toHaveBeenCalled()
    expect(updates[0]).toMatchObject({
      table: 'orders',
      patch: { notes: 'Delivery: 4 Marina Street, Lagos Island' },
    })
    expect(updates[0].patch).not.toHaveProperty('sourceLocale')
    expect(updates[0].patch).not.toHaveProperty('translationStatus')
  })

  it('does not downgrade a row the retry job still owes work on', async () => {
    queueSelect('orders', [orderRow({ translationStatus: 'pending', sourceLocale: 'yo' })])
    queueSelect('users', [{ preferredLocale: 'en' }])
    queueSelect('orders', [orderRow()])

    await patch('/sales/order-1', { notes: 'Deliver before noon, gate code needed' })

    expect(updates[0].patch).not.toHaveProperty('sourceLocale')
    expect(updates[0].patch).not.toHaveProperty('translationStatus')
  })
})

describe('POST /sales/:id/refund - canonical English on write', () => {
  const FRENCH_REFUND = {
    amountKobo: 45000,
    reason: 'Le client a reçu des tubercules abîmés',
  }

  it('sends Paystack and the refund row the English, with the amount untouched', async () => {
    queueSelect('orders', [orderRow()])
    queueSelect('users', [{ preferredLocale: 'fr' }])
    queueSelect('orders', [orderRow()])

    const res = await post('/sales/order-1/refund', FRENCH_REFUND)

    expect(res.status).toBe(200)
    expect(initiateRefund).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'The customer received damaged tubers',
        amountKobo: 45000,
      }),
    )
    expect(updates).toContainEqual({
      table: 'payment_refunds',
      patch: { sourceLocale: 'fr', translationStatus: 'done' },
    })
  })

  it('echoes the author their own reason', async () => {
    queueSelect('orders', [orderRow()])
    queueSelect('users', [{ preferredLocale: 'fr' }])
    queueSelect('orders', [orderRow()])

    const res = await post('/sales/order-1/refund', FRENCH_REFUND)
    const body = (await res.json()) as { refund: Row }

    expect(body.refund.reason).toBe('Le client a reçu des tubercules abîmés')
  })

  it('records the reason as pending and still refunds when the LLM is unavailable', async () => {
    isLlmConfigured.mockReturnValue(false)
    queueSelect('orders', [orderRow()])
    queueSelect('users', [{ preferredLocale: 'fr' }])
    queueSelect('orders', [orderRow()])

    const res = await post('/sales/order-1/refund', FRENCH_REFUND)

    expect(res.status).toBe(200)
    expect(initiateRefund).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'Le client a reçu des tubercules abîmés' }),
    )
    expect(updates).toContainEqual({
      table: 'payment_refunds',
      patch: { sourceLocale: 'fr', translationStatus: 'pending' },
    })
  })

  it('still returns the refund when the locale bookkeeping write fails', async () => {
    isLlmConfigured.mockReturnValue(false)
    queueSelect('orders', [orderRow()])
    queueSelect('users', [{ preferredLocale: 'fr' }])
    queueSelect('orders', [orderRow()])
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { db } = (await import('../db/index.js')) as unknown as { db: Record<string, unknown> }
    const realUpdate = db.update
    db.update = () => ({
      set: () => ({
        where: async () => {
          throw new Error('db down')
        },
      }),
    })

    const res = await post('/sales/order-1/refund', FRENCH_REFUND)

    db.update = realUpdate
    consoleError.mockRestore()
    expect(res.status).toBe(200)
  })

  it('touches nothing on the refund row for an English reason', async () => {
    queueSelect('orders', [orderRow()])
    queueSelect('users', [{ preferredLocale: 'en' }])
    queueSelect('orders', [orderRow()])

    const res = await post('/sales/order-1/refund', {
      amountKobo: 45000,
      reason: 'The customer received damaged tubers',
    })

    expect(res.status).toBe(200)
    expect(completeChat).not.toHaveBeenCalled()
    expect(updates).toHaveLength(0)
  })
})

describe('GET /sales - viewer locale on read', () => {
  it('translates a staff order in one batched call', async () => {
    queueSelect('orders', [orderRow(), orderRow({ id: 'order-2', customerFeedback: null })])
    queueSelect('order_items', [])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await (await app()).request('/sales')
    const body = (await res.json()) as { orders: Row[] }

    expect(res.status).toBe(200)
    expect(viewerBatchCalls).toHaveBeenCalledTimes(1)
    expect(selectLog.filter((table) => table === 'content_translations')).toHaveLength(1)
    expect(body.orders[0].notes).toBe('Livrer avant midi, code du portail requis')
    expect(body.orders[0].customerFeedback).toBe(
      'Les plantains sont arrivés frais et bien emballés',
    )
    expect(body.orders[1].customerFeedback).toBeNull()
  })

  it('never translates a bot order\u2019s delivery address', async () => {
    queueSelect('orders', [botOrderRow()])
    queueSelect('order_items', [])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await (await app()).request('/sales')
    const order = ((await res.json()) as { orders: Row[] }).orders[0]

    expect(order.notes).toBe('Delivery: 12 Awolowo Road, Ikeja')
    expect(translatedTexts()).toEqual(['The plantains arrived fresh and well packed'])
  })

  it('leaves references, names, money and lot codes verbatim', async () => {
    queueSelect('orders', [orderRow()])
    queueSelect('order_items', [
      {
        orderId: 'aa11bb22-cc33-4d44-8e55-ff6677889900',
        productName: 'Plantain',
        unit: 'crate',
        quantity: 3,
        unitPriceKobo: 1500000,
        lineTotalKobo: 4500000,
      },
    ])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await (await app()).request('/sales')
    const order = ((await res.json()) as { orders: Row[] }).orders[0]

    expect(order).toMatchObject({
      reference: 'TRV-ORD-AA11BB',
      customerName: 'Mme Diallo',
      customerPhone: '+2348012345678',
      totalAmount: 45000,
      currency: 'NGN',
      lotCode: 'LOT-20260720-001',
      status: 'confirmed',
      paymentStatus: 'paid',
    })
    expect(order.items).toMatchObject([{ productName: 'Plantain', lineTotalKobo: 4500000 }])
    expect(viewerBatchCalls).toHaveBeenCalledWith(
      expect.objectContaining({
        texts: [
          'Deliver before noon, gate code needed',
          'The plantains arrived fresh and well packed',
        ],
      }),
    )
  })

  it('does no translation work at all for an English viewer', async () => {
    queueSelect('orders', [orderRow(), orderRow({ id: 'order-2' })])
    queueSelect('order_items', [])
    queueSelect('users', [{ preferredLocale: 'en' }])

    const res = await (await app()).request('/sales')
    const body = (await res.json()) as { orders: Row[] }

    expect(viewerBatchCalls).not.toHaveBeenCalled()
    expect(completeChat).not.toHaveBeenCalled()
    expect(selectLog).not.toContain('content_translations')
    expect(body.orders[0].notes).toBe('Deliver before noon, gate code needed')
  })

  // Redaction runs first, so a field worker's hidden prose is not merely absent
  // from the response — it is never sent to the translator either. With both
  // customer-authored columns withheld there is nothing left to localize.
  it('redacts before localizing, so hidden prose never reaches the translator', async () => {
    sessionUser = { ...sessionUser, id: 'user-fw', role: 'field_worker' }
    queueSelect('orders', [orderRow()])
    queueSelect('order_items', [])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await (await app()).request('/sales')
    const order = ((await res.json()) as { orders: Row[] }).orders[0]

    expect(order.notes).toBeNull()
    expect(order.customerFeedback).toBeNull()
    expect(order.customerName).toBe('[redacted]')
    expect(translatedTexts()).toEqual([])
  })
})
