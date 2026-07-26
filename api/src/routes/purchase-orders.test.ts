import { Hono } from 'hono'
import { getTableName } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  purchaseOrderStatusAfterReceipt,
  receiptQuantityIsValid,
} from '../lib/purchase-order-receiving.js'

describe('purchase order receiving', () => {
  it('keeps a partially received order open', () => {
    expect(purchaseOrderStatusAfterReceipt([
      { quantityOrdered: 10, quantityReceived: 10 },
      { quantityOrdered: 5, quantityReceived: 2 },
    ])).toBe('partially_received')
  })

  it('marks an order received only when every line is complete', () => {
    expect(purchaseOrderStatusAfterReceipt([
      { quantityOrdered: 10, quantityReceived: 10 },
      { quantityOrdered: 5, quantityReceived: 5 },
    ])).toBe('received')
  })

  it('rejects zero, negative, fractional, and excess receipts', () => {
    const line = { quantityOrdered: 10, quantityReceived: 7 }
    expect(receiptQuantityIsValid(line, 3)).toBe(true)
    expect(receiptQuantityIsValid(line, 4)).toBe(false)
    expect(receiptQuantityIsValid(line, 0)).toBe(false)
    expect(receiptQuantityIsValid(line, -1)).toBe(false)
    expect(receiptQuantityIsValid(line, 1.5)).toBe(false)
  })
})

type Row = Record<string, unknown>

const nameOf = (table: unknown) => getTableName(table as never)

let sessionUser: Row = {
  id: 'user-owner',
  farmId: 'farm-1',
  role: 'owner',
  name: 'Ada',
  email: 'ada@trovara.farm',
}

/** Rows the fake db returns, queued per table so query order does not matter. */
const selectQueue = new Map<string, Row[][]>()
const selectLog: string[] = []
const inserted: { table: string; values: Row }[] = []
const updates: { table: string; patch: Row }[] = []
/** Ids `returning()` hands back, so a fixture row and its insert line up. */
const insertIds = new Map<string, string>()

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
    execute: async () => undefined,
    insert: (table: unknown) => ({
      values: (values: Row | Row[]) => {
        const name = nameOf(table)
        const rows = Array.isArray(values) ? values : [values]
        for (const row of rows) inserted.push({ table: name, values: row })
        return {
          returning: async () =>
            rows.map((row) => ({ id: insertIds.get(name) ?? `${name}-new`, ...row })),
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
            returning: async () => [{ id: 'po-1', ...patch }],
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

const FRENCH_TO_ENGLISH: Record<string, string> = {
  'Livraison urgente, payer à la réception': 'Urgent delivery, pay on arrival',
  'Deux sacs éventrés à la livraison': 'Two bags torn on delivery',
}

/**
 * Deliberately not the inverse of the table above: rendering the stored English
 * back into French gives a different sentence from the one the author typed, so
 * a test can tell an echo apart from a round trip.
 */
const ENGLISH_TO_FRENCH: Record<string, string> = {
  'Urgent delivery, pay on arrival': 'Livraison urgente, payer à la réception',
  'Two bags torn on delivery': 'Deux sacs déchirés à la livraison',
}

const SUPPLIER_ID = '11111111-1111-4111-8111-111111111111'
const ITEM_ID = '22222222-2222-4222-8222-222222222222'
const LINE_ID = '33333333-3333-4333-8333-333333333333'

/** A create body whose supplier and line names must survive a translated write. */
const FRENCH_ORDER = {
  supplierId: SUPPLIER_ID,
  notes: 'Livraison urgente, payer à la réception',
  lines: [
    {
      itemId: ITEM_ID,
      itemName: 'Layer Mash 25kg',
      unit: 'bags' as const,
      quantityOrdered: 40,
      unitCostMinor: 1_250_000,
    },
  ],
}

function orderRow(overrides: Row = {}): Row {
  return {
    id: 'po-1',
    farmId: 'farm-1',
    supplierId: SUPPLIER_ID,
    supplierName: 'Ogun Feeds Ltd',
    status: 'draft',
    createdById: 'user-owner',
    approvedById: null,
    approvedAt: null,
    notes: 'Urgent delivery, pay on arrival',
    expectedAt: null,
    createdAt: new Date('2026-07-20T08:00:00Z'),
    updatedAt: new Date('2026-07-20T08:00:00Z'),
    ...overrides,
  }
}

function lineRow(overrides: Row = {}): Row {
  return {
    id: LINE_ID,
    purchaseOrderId: 'po-1',
    itemId: ITEM_ID,
    itemName: 'Layer Mash 25kg',
    unit: 'bags',
    quantityOrdered: 40,
    quantityReceived: 0,
    unitCostMinor: 1_250_000,
    ...overrides,
  }
}

function receiptRow(overrides: Row = {}): Row {
  return {
    id: 'receipt-1',
    farmId: 'farm-1',
    purchaseOrderId: 'po-1',
    idempotencyKey: 'receipt-key-0001',
    receivedById: 'user-owner',
    notes: 'Two bags torn on delivery',
    sourceLocale: null,
    translationStatus: 'done',
    receivedAt: new Date('2026-07-21T08:00:00Z'),
    ...overrides,
  }
}

/** Everything `purchaseOrderDetail` reads, in one call. */
function queueDetail(order: Row = orderRow(), receipts: Row[] = []) {
  queueSelect('purchase_orders', [order])
  queueSelect('purchase_order_lines', [lineRow()])
  queueSelect('goods_receipts', receipts)
}

async function app() {
  const { purchaseOrderRoutes } = await import('./purchase-orders.js')
  const instance = new Hono()
  instance.route('/purchase-orders', purchaseOrderRoutes)
  return instance
}

async function post(path: string, body: unknown) {
  return (await app()).request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function insertedInto(table: string): Row {
  const row = inserted.find((entry) => entry.table === table)
  expect(row).toBeDefined()
  return row!.values
}

/** Every string the translator was actually handed, in call order. */
function translatedTexts(): string[] {
  return completeChat.mock.calls.map((call) => call[1] as string)
}

/** Every string the write path handed to the canonical-English service. */
function canonicalTexts(): string[] {
  return canonicalCalls.mock.calls.map((call) => (call[0] as { text: string }).text)
}

beforeEach(() => {
  vi.clearAllMocks()
  selectQueue.clear()
  selectLog.length = 0
  inserted.length = 0
  updates.length = 0
  insertIds.clear()
  insertIds.set('goods_receipts', 'receipt-1')
  isLlmConfigured.mockReturnValue(true)
  completeChat.mockImplementation(async (system: string, text: string) => {
    const table = /into English/i.test(system) ? FRENCH_TO_ENGLISH : ENGLISH_TO_FRENCH
    return { text: table[text] ?? `[${text}]`, model: 'test' }
  })
  sessionUser = {
    id: 'user-owner',
    farmId: 'farm-1',
    role: 'owner',
    name: 'Ada',
    email: 'ada@trovara.farm',
  }
})

describe('POST /purchase-orders - canonical English on write', () => {
  function queueCreateReads(preferredLocale: string) {
    queueSelect('suppliers', [{ id: SUPPLIER_ID }])
    queueSelect('inventory_items', [{ id: ITEM_ID }])
    queueSelect('users', [{ preferredLocale }])
    queueDetail()
  }

  it('stores the order note in English with the author locale', async () => {
    queueCreateReads('fr')

    const res = await post('/purchase-orders', FRENCH_ORDER)

    expect(res.status).toBe(201)
    expect(insertedInto('purchase_orders')).toMatchObject({
      notes: 'Urgent delivery, pay on arrival',
      sourceLocale: 'fr',
      translationStatus: 'done',
    })
  })

  it('leaves the line item name, unit, quantity and cost verbatim', async () => {
    queueCreateReads('fr')

    await post('/purchase-orders', FRENCH_ORDER)

    expect(insertedInto('purchase_order_lines')).toMatchObject({
      itemName: 'Layer Mash 25kg',
      unit: 'bags',
      quantityOrdered: 40,
      unitCostMinor: 1_250_000,
    })
    // The order note is the only prose; nothing else reaches the translator.
    expect(translatedTexts()).toEqual(['Livraison urgente, payer à la réception'])
  })

  it('returns the author their own words while storing the English', async () => {
    queueCreateReads('fr')

    const res = await post('/purchase-orders', FRENCH_ORDER)
    const body = (await res.json()) as { purchaseOrder: Row }

    expect(body.purchaseOrder.notes).toBe('Livraison urgente, payer à la réception')
    expect(body.purchaseOrder.supplierName).toBe('Ogun Feeds Ltd')
    expect(insertedInto('purchase_orders').notes).toBe('Urgent delivery, pay on arrival')
  })

  it('stores the original as pending and still succeeds when the LLM is unavailable', async () => {
    isLlmConfigured.mockReturnValue(false)
    queueCreateReads('fr')

    const res = await post('/purchase-orders', FRENCH_ORDER)

    expect(res.status).toBe(201)
    expect(insertedInto('purchase_orders')).toMatchObject({
      notes: 'Livraison urgente, payer à la réception',
      sourceLocale: 'fr',
      translationStatus: 'pending',
    })
  })

  it('still succeeds and stays pending when the translator throws', async () => {
    completeChat.mockRejectedValue(new Error('upstream 503'))
    queueCreateReads('fr')

    const res = await post('/purchase-orders', FRENCH_ORDER)

    expect(res.status).toBe(201)
    expect(insertedInto('purchase_orders')).toMatchObject({
      notes: 'Livraison urgente, payer à la réception',
      translationStatus: 'pending',
    })
  })

  it('makes no translation call at all for an English create', async () => {
    queueCreateReads('en')

    const res = await post('/purchase-orders', {
      ...FRENCH_ORDER,
      notes: 'Urgent delivery, pay on arrival',
    })

    expect(res.status).toBe(201)
    expect(completeChat).not.toHaveBeenCalled()
    expect(insertedInto('purchase_orders')).toMatchObject({
      sourceLocale: 'en',
      translationStatus: 'done',
    })
  })

  it('does not enter the translation service for an order with no note', async () => {
    queueCreateReads('fr')

    const res = await post('/purchase-orders', { ...FRENCH_ORDER, notes: undefined })

    expect(res.status).toBe(201)
    expect(canonicalCalls).not.toHaveBeenCalled()
    expect(insertedInto('purchase_orders')).toMatchObject({ notes: null })
  })
})

describe('POST /purchase-orders/:id/receipts - canonical English on write', () => {
  function queueReceiveReads(preferredLocale: string) {
    queueSelect('users', [{ preferredLocale }])
    // Inside the transaction: the order, the idempotency probe, the lines.
    queueSelect('purchase_orders', [orderRow({ status: 'approved' })])
    queueSelect('goods_receipts', [])
    queueSelect('purchase_order_lines', [lineRow()])
    // After the transaction: the stored receipt and its lines, then the detail.
    queueSelect('goods_receipts', [receiptRow()])
    queueSelect('goods_receipt_lines', [{ id: 'grl-1', quantityReceived: 10 }])
    queueDetail(orderRow({ status: 'partially_received' }), [receiptRow()])
  }

  const RECEIPT_BODY = {
    idempotencyKey: 'receipt-key-0001',
    notes: 'Deux sacs éventrés à la livraison',
    lines: [{ purchaseOrderLineId: LINE_ID, quantityReceived: 10 }],
  }

  it('stores the receipt note in English with the author locale', async () => {
    queueReceiveReads('fr')

    const res = await post('/purchase-orders/po-1/receipts', RECEIPT_BODY)

    expect(res.status).toBe(201)
    expect(insertedInto('goods_receipts')).toMatchObject({
      notes: 'Two bags torn on delivery',
      idempotencyKey: 'receipt-key-0001',
      sourceLocale: 'fr',
      translationStatus: 'done',
    })
  })

  it('leaves the stock movement marker English and unlabelled', async () => {
    queueReceiveReads('fr')

    await post('/purchase-orders/po-1/receipts', RECEIPT_BODY)

    const movement = insertedInto('inventory_movements')
    expect(movement.reason).toBe('goods_receipt')
    expect(movement).not.toHaveProperty('sourceLocale')
    expect(movement).not.toHaveProperty('translationStatus')
    // The receipt note is the only prose the write path normalizes; the marker,
    // the idempotency key and the line names never enter the service.
    expect(canonicalTexts()).toEqual(['Deux sacs éventrés à la livraison'])
    expect(translatedTexts()).not.toContain('goods_receipt')
    expect(translatedTexts()).not.toContain('Layer Mash 25kg')
  })

  it('echoes the receiver their own note in the receipt and in the order history', async () => {
    queueReceiveReads('fr')

    const res = await post('/purchase-orders/po-1/receipts', RECEIPT_BODY)
    const body = (await res.json()) as {
      receipt: Row
      purchaseOrder: { notes: string; receipts: Row[] }
    }

    expect(body.receipt.notes).toBe('Deux sacs éventrés à la livraison')
    // One response must not show the same note in two languages.
    expect(body.purchaseOrder.receipts[0].notes).toBe('Deux sacs éventrés à la livraison')
    expect(body.purchaseOrder.notes).toBe('Livraison urgente, payer à la réception')
  })

  it('records the receipt as pending and still succeeds when the LLM is unavailable', async () => {
    isLlmConfigured.mockReturnValue(false)
    queueReceiveReads('fr')

    const res = await post('/purchase-orders/po-1/receipts', RECEIPT_BODY)

    expect(res.status).toBe(201)
    expect(insertedInto('goods_receipts')).toMatchObject({
      notes: 'Deux sacs éventrés à la livraison',
      sourceLocale: 'fr',
      translationStatus: 'pending',
    })
  })

  it('makes no translation call at all for an English receipt', async () => {
    queueReceiveReads('en')

    const res = await post('/purchase-orders/po-1/receipts', {
      ...RECEIPT_BODY,
      notes: 'Two bags torn on delivery',
    })

    expect(res.status).toBe(201)
    expect(completeChat).not.toHaveBeenCalled()
    expect(viewerBatchCalls).not.toHaveBeenCalled()
  })
})

describe('purchase order reads - viewer locale', () => {
  it('translates every order note in the list in one batched call', async () => {
    queueSelect('purchase_orders', [orderRow(), orderRow({ id: 'po-2', notes: null })])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await (await app()).request('/purchase-orders')
    const body = (await res.json()) as { purchaseOrders: Row[] }

    expect(res.status).toBe(200)
    expect(viewerBatchCalls).toHaveBeenCalledTimes(1)
    expect(selectLog.filter((table) => table === 'content_translations')).toHaveLength(1)
    expect(body.purchaseOrders[0].notes).toBe('Livraison urgente, payer à la réception')
    expect(body.purchaseOrders[0].supplierName).toBe('Ogun Feeds Ltd')
    expect(body.purchaseOrders[1].notes).toBeNull()
  })

  it('translates the order note and every receipt note in one batched call', async () => {
    queueSelect('users', [{ preferredLocale: 'fr' }])
    queueDetail(orderRow(), [receiptRow(), receiptRow({ id: 'receipt-2' })])

    const res = await (await app()).request('/purchase-orders/po-1')
    const body = (await res.json()) as {
      purchaseOrder: { notes: string; lines: Row[]; receipts: Row[] }
    }

    expect(viewerBatchCalls).toHaveBeenCalledTimes(1)
    expect(body.purchaseOrder.notes).toBe('Livraison urgente, payer à la réception')
    expect(body.purchaseOrder.receipts[0].notes).toBe('Deux sacs déchirés à la livraison')
    // Line names and quantities are procurement record, never translated.
    expect(body.purchaseOrder.lines[0]).toMatchObject({
      itemName: 'Layer Mash 25kg',
      unit: 'bags',
      quantityOrdered: 40,
    })
  })

  it('does no translation work at all for an English viewer', async () => {
    queueSelect('users', [{ preferredLocale: 'en' }])
    queueDetail(orderRow(), [receiptRow()])

    const res = await (await app()).request('/purchase-orders/po-1')
    const body = (await res.json()) as { purchaseOrder: { notes: string } }

    expect(viewerBatchCalls).not.toHaveBeenCalled()
    expect(completeChat).not.toHaveBeenCalled()
    expect(selectLog).not.toContain('content_translations')
    expect(body.purchaseOrder.notes).toBe('Urgent delivery, pay on arrival')
  })

  it('renders the note for the viewer after an approve, which writes no text', async () => {
    queueSelect('users', [{ preferredLocale: 'fr' }])
    queueDetail(orderRow({ status: 'approved' }))

    const res = await post('/purchase-orders/po-1/approve', {})
    const body = (await res.json()) as { purchaseOrder: { notes: string } }

    expect(res.status).toBe(200)
    expect(canonicalCalls).not.toHaveBeenCalled()
    expect(body.purchaseOrder.notes).toBe('Livraison urgente, payer à la réception')
  })
})
