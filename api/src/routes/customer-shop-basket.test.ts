import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { customerAccounts, customerRecurringOrders, products, shopDeliverySlots } from '../db/schema.js'

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  update: vi.fn(),
  insert: vi.fn(),
  draft: vi.fn(),
  saveDraft: vi.fn(),
  clearDraft: vi.fn(),
  session: vi.fn(),
  createOrder: vi.fn(),
  upsertContact: vi.fn(),
  resolveFarm: vi.fn(),
}))

vi.mock('../db/index.js', () => ({
  db: { select: mocks.select, update: mocks.update, insert: mocks.insert },
}))
vi.mock('../lib/customer-accounts.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/customer-accounts.js')>()),
  getCustomerFromSession: mocks.session,
}))
vi.mock('../lib/customer-draft-baskets.js', () => ({
  getCustomerDraftBasket: mocks.draft,
  saveCustomerDraftBasket: mocks.saveDraft,
  clearCustomerDraftBasket: mocks.clearDraft,
}))
vi.mock('../lib/customer-orders.js', () => ({
  createOrderFromCart: mocks.createOrder,
  upsertCustomerContact: mocks.upsertContact,
  resolveCustomerFarm: mocks.resolveFarm,
}))

const { customerShopRoutes } = await import('./customer-shop.js')
const app = new Hono().route('/shop', customerShopRoutes)

const PLANTAIN = '11111111-1111-4111-8111-111111111111'
const TOMATO = '22222222-2222-4222-8222-222222222222'
const EXTRA = '33333333-3333-4333-8333-333333333333'
const PLAN = '44444444-4444-4444-8444-444444444444'
const SLOT = '55555555-5555-4555-8555-555555555555'
const ITEM_PRICE = { unit: 'kg', priceKobo: 10000, currency: 'NGN', provenance: 'trovara_grown' }
const standard = [
  { ...ITEM_PRICE, id: PLANTAIN, name: 'Plantain', active: true, familyBasketQuantity: 2 },
  { ...ITEM_PRICE, id: TOMATO, name: 'Tomato', active: true, familyBasketQuantity: 1 },
]
const addon = { ...ITEM_PRICE, id: EXTRA, name: 'Yam', active: true, familyBasketQuantity: 0 }
const item = (productId: string, quantity: number) => ({ productId, quantity })
const account = { id: 'customer', farmId: 'farm', name: 'Example customer' }
const saturday = {
  id: SLOT,
  label: 'Saturday morning',
  dayOfWeek: 6,
  startTime: '09:00',
  endTime: '12:00',
  cutoffHours: 24,
}

function request(path: 'orders' | 'basket', body: object) {
  return app.request(`/shop/${path}`, {
    method: path === 'orders' ? 'POST' : 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: 'Example delivery address', ...body }),
  })
}

let catalogue: typeof standard
let recurring: Array<{ id: string; frequency: string; familyBasketActive: boolean }>
let slots: Array<typeof saturday>

beforeEach(() => {
  vi.clearAllMocks()
  catalogue = standard
  recurring = []
  slots = []
  mocks.select.mockImplementation(() => ({
    from: (table: unknown) => {
      const rows: unknown[] = new Map<unknown, unknown[]>([
        [customerAccounts, [{ emailVerifiedAt: new Date() }]],
        [shopDeliverySlots, slots],
        [customerRecurringOrders, recurring],
        [products, catalogue],
      ]).get(table) ?? []
      return {
        where: () => Object.assign(Promise.resolve(rows), {
          limit: () => Promise.resolve(rows),
          orderBy: () => Promise.resolve(rows),
        }),
      }
    },
  }))
  mocks.session.mockResolvedValue(account)
  mocks.resolveFarm.mockResolvedValue({ id: account.farmId, name: 'Example farm' })
  mocks.draft.mockResolvedValue({ items: [], familyBasketActive: false })
  mocks.saveDraft.mockImplementation(async (basket) => basket)
  mocks.upsertContact.mockResolvedValue({ id: 'contact' })
  mocks.createOrder.mockResolvedValue({ orderId: 'order', reference: 'TRV-ORD-TEST' })
  mocks.update.mockReturnValue({ set: vi.fn(() => ({ where: vi.fn() })) })
  mocks.insert.mockReturnValue({ values: vi.fn() })
})

describe('delivery windows from the public catalogue', () => {
  it('publishes the next Lagos window and hides an inactive standard product without offering a partial basket', async () => {
    slots = [saturday]
    catalogue = [standard[0], { ...standard[1], active: false }]
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2026-11-27T08:01:00Z'))
      const response = await app.request('/shop/catalog')
      expect(response.status).toBe(200)
      expect(response.headers.get('Cache-Control')).toBe('no-store')
      expect(await response.json()).toMatchObject({
        deliveryTimeZone: 'Africa/Lagos',
        familyBasketAvailable: false,
        products: [{ id: PLANTAIN }],
        deliverySlots: [{
          id: SLOT,
          nextDeliveryDate: '2026-12-05',
          nextOrderCutoffAt: '2026-12-04T08:00:00.000Z',
        }],
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects checkout against the previous cutoff without creating an order', async () => {
    slots = [saturday]
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2026-11-27T08:01:00Z'))
      const response = await request('orders', {
        items: [item(PLANTAIN, 1)],
        familyBasketActive: false,
        deliverySlotId: SLOT,
        deliveryDate: '2026-11-28',
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ code: 'delivery_window_changed' })
      expectNoOrderWrites()
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects a selected window that was removed from the schedule', async () => {
    const response = await request('orders', {
      items: [item(PLANTAIN, 1)],
      familyBasketActive: false,
      deliverySlotId: SLOT,
      deliveryDate: '2026-11-28',
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'delivery_window_changed' })
    expectNoOrderWrites()
  })
})

function expectNoOrderWrites() {
  expect(mocks.upsertContact).not.toHaveBeenCalled()
  expect(mocks.createOrder).not.toHaveBeenCalled()
  expect(mocks.insert).not.toHaveBeenCalled()
  expect(mocks.update).not.toHaveBeenCalled()
  expect(mocks.clearDraft).not.toHaveBeenCalled()
}

describe('Family Basket enforcement', () => {
  it.each([
    ['omitted', [item(PLANTAIN, 2)]],
    ['reduced', [item(PLANTAIN, 1), item(TOMATO, 1)]],
  ])('rejects an %s standard line before creating an order', async (_, items) => {
    const response = await request('orders', { items, familyBasketActive: true })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'family_basket_changed' })
    expectNoOrderWrites()
  })

  it('rejects duplicate lines instead of counting them toward the minimum', async () => {
    const response = await request('orders', {
      items: [item(PLANTAIN, 1), item(PLANTAIN, 1), item(TOMATO, 1)],
      familyBasketActive: true,
    })
    expect(response.status).toBe(400)
    expectNoOrderWrites()
  })

  it('pauses the full basket when a configured standard product is inactive', async () => {
    catalogue = [standard[0], { ...standard[1], active: false }]
    const response = await request('orders', { items: [item(PLANTAIN, 2)], familyBasketActive: true })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'family_basket_unavailable' })
    expectNoOrderWrites()
  })

  it('accepts additions above the minimum and saves Family Basket intent for repeat checkout', async () => {
    catalogue = [...standard, addon]
    const items = [item(PLANTAIN, 3), item(TOMATO, 1), item(EXTRA, 1)]
    const response = await request('orders', { items, familyBasketActive: true, recurrenceFrequency: 'weekly' })
    expect(response.status).toBe(201)
    expect(mocks.createOrder).toHaveBeenCalledWith(expect.objectContaining({
      cart: items.map(({ productId, quantity }) => ({ productId, qty: quantity })),
    }))
    expect(mocks.insert).toHaveBeenCalledWith(customerRecurringOrders)
    expect(mocks.insert.mock.results[0].value.values).toHaveBeenCalledWith(
      expect.objectContaining({ familyBasketActive: true, items }),
    )
  })

  it('enforces a persisted repeat plan even when the request switches off the flag', async () => {
    recurring = [{ id: PLAN, frequency: 'weekly', familyBasketActive: true }]
    const response = await request('orders', {
      items: [item(PLANTAIN, 1)],
      familyBasketActive: false,
      recurringOrderId: PLAN,
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'family_basket_changed' })
    expectNoOrderWrites()
  })

  it('honours the saved Family Basket for an older client that omits intent', async () => {
    mocks.draft.mockResolvedValue({ items: [], familyBasketActive: true })
    const response = await request('orders', { items: [item(PLANTAIN, 1)] })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'family_basket_changed' })
    expectNoOrderWrites()
  })

  it('allows a separate individual order below the Family Basket minimum', async () => {
    const response = await request('orders', { items: [item(PLANTAIN, 1)], familyBasketActive: false })
    expect(response.status).toBe(201)
    expect(mocks.draft).not.toHaveBeenCalled()
    expect(mocks.createOrder).toHaveBeenCalledOnce()
  })

  it('allows a legacy repeat plan without imposing minimums from an unrelated saved basket', async () => {
    recurring = [{ id: PLAN, frequency: 'weekly', familyBasketActive: false }]
    mocks.draft.mockResolvedValue({ items: [], familyBasketActive: true })
    const response = await request('orders', { items: [item(PLANTAIN, 1)], recurringOrderId: PLAN })
    expect(response.status).toBe(201)
    expect(mocks.draft).not.toHaveBeenCalled()
    expect(mocks.createOrder).toHaveBeenCalledOnce()
  })

  it('rejects an incomplete Family Basket draft but lets customers clear it', async () => {
    const response = await request('basket', { items: [item(PLANTAIN, 1)], familyBasketActive: true })
    expect(response.status).toBe(400)
    expect(mocks.saveDraft).not.toHaveBeenCalled()

    const cleared = await request('basket', { items: [], familyBasketActive: false })
    expect(cleared.status).toBe(200)
    expect(mocks.saveDraft).toHaveBeenCalledWith(expect.objectContaining({ items: [], familyBasketActive: false }))
  })
})
