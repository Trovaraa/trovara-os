import { describe, expect, it } from 'vitest'
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
