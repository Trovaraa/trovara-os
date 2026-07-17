import { describe, expect, it } from 'vitest'
import {
  MAX_CART_LINES,
  MAX_ORDER_VALUE_KOBO,
  MAX_QTY_PER_LINE,
  flagAbsurdOrder,
  validateCartLines,
  validateOrderValue,
} from './order-abuse-controls.js'
import type { CartLine, CatalogItem } from './customer-cart.js'

const catalog: CatalogItem[] = [
  { id: 'p1', name: 'Plantain', unit: 'bunch', priceKobo: 250000, currency: 'NGN' },
]

describe('order-abuse-controls', () => {
  it('rejects carts with too many lines', () => {
    const cart: CartLine[] = Array.from({ length: MAX_CART_LINES + 1 }, (_, i) => ({
      productId: `p${i}`,
      qty: 1,
    }))
    const result = validateCartLines(cart)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('CART_TOO_MANY_LINES')
  })

  it('rejects excessive quantity per line', () => {
    const result = validateCartLines([{ productId: 'p1', qty: MAX_QTY_PER_LINE + 1 }])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('QTY_TOO_HIGH')
  })

  it('rejects order value above cap', () => {
    const qtyAboveConfiguredCap = Math.floor(MAX_ORDER_VALUE_KOBO / catalog[0]!.priceKobo) + 1
    const cart: CartLine[] = [{ productId: 'p1', qty: qtyAboveConfiguredCap }]
    const result = validateOrderValue(cart, catalog)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('ORDER_VALUE_TOO_HIGH')
  })

  it('flags absurd orders near limits', () => {
    const cart: CartLine[] = [{ productId: 'p1', qty: 90 }]
    expect(flagAbsurdOrder(cart, catalog)).toBe(true)
  })
})
