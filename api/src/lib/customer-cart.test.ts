import { describe, expect, it } from 'vitest'
import {
  addToCart,
  cartHasUnpriced,
  cartTotalKobo,
  formatCart,
  formatCatalog,
  formatNaira,
  orderReference,
  orderStatusLabel,
  parseChoice,
  type CatalogItem,
} from './customer-cart.js'

const catalog: CatalogItem[] = [
  { id: 'p1', name: 'Trovara Farm Plantain', unit: 'bunch', priceKobo: 250000, currency: 'NGN' },
  { id: 'p2', name: 'Trovara Farm Eggs', unit: 'crate', priceKobo: 0, currency: 'NGN' },
]

describe('addToCart', () => {
  it('adds a new line', () => {
    expect(addToCart([], 'p1', 2)).toEqual([{ productId: 'p1', qty: 2 }])
  })

  it('accumulates quantity for an existing product', () => {
    const cart = addToCart([{ productId: 'p1', qty: 1 }], 'p1', 3)
    expect(cart).toEqual([{ productId: 'p1', qty: 4 }])
  })

  it('ignores non-positive quantities', () => {
    expect(addToCart([], 'p1', 0)).toEqual([])
    expect(addToCart([], 'p1', -2)).toEqual([])
  })

  it('does not mutate the input cart', () => {
    const original = [{ productId: 'p1', qty: 1 }]
    addToCart(original, 'p1', 5)
    expect(original).toEqual([{ productId: 'p1', qty: 1 }])
  })
})

describe('cartTotalKobo / cartHasUnpriced', () => {
  it('sums known prices and skips unpriced items', () => {
    const cart = [
      { productId: 'p1', qty: 2 },
      { productId: 'p2', qty: 1 },
    ]
    expect(cartTotalKobo(cart, catalog)).toBe(500000)
    expect(cartHasUnpriced(cart, catalog)).toBe(true)
  })

  it('reports no unpriced items when all have prices', () => {
    expect(cartHasUnpriced([{ productId: 'p1', qty: 1 }], catalog)).toBe(false)
  })
})

describe('formatNaira', () => {
  it('formats NGN with the naira symbol', () => {
    expect(formatNaira(250000)).toBe('₦2,500')
  })

  it('prefixes other currencies with the code', () => {
    expect(formatNaira(100000, 'USD')).toBe('USD 1,000')
  })
})

describe('orderReference', () => {
  it('derives a short uppercase reference from the order id', () => {
    expect(orderReference('8fkd12ab-cdef-0000-0000-000000000000')).toBe('TRV-ORD-8FKD12')
  })
})

describe('formatCatalog', () => {
  it('numbers items and shows price on request when unpriced', () => {
    const out = formatCatalog(catalog)
    expect(out).toContain('1. Trovara Farm Plantain - ₦2,500 / bunch')
    expect(out).toContain('2. Trovara Farm Eggs - price on request')
  })

  it('handles an empty catalogue', () => {
    expect(formatCatalog([])).toMatch(/being updated/)
  })
})

describe('formatCart', () => {
  it('shows a subtotal and flags on-request items', () => {
    const out = formatCart(
      [
        { productId: 'p1', qty: 2 },
        { productId: 'p2', qty: 1 },
      ],
      catalog,
    )
    expect(out).toContain('2 × Trovara Farm Plantain')
    expect(out).toContain('Subtotal: ₦5,000 (+ items priced on request)')
  })

  it('says price on request when nothing is priced', () => {
    expect(formatCart([{ productId: 'p2', qty: 1 }], catalog)).toContain('Total: price on request')
  })
})

describe('parseChoice', () => {
  it('parses positive integers only', () => {
    expect(parseChoice(' 3 ')).toBe(3)
    expect(parseChoice('abc')).toBeNull()
    expect(parseChoice('2.5')).toBeNull()
  })
})

describe('orderStatusLabel', () => {
  it('maps known statuses to friendly text', () => {
    expect(orderStatusLabel('dispatched')).toBe('Out for delivery')
    expect(orderStatusLabel('unknown')).toBe('unknown')
  })
})
