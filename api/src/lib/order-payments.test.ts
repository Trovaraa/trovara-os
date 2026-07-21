import { describe, expect, it } from 'vitest'
import { makePayReference } from './order-payments.js'

describe('makePayReference', () => {
  it('uses TRV-PAY prefix and order short id', () => {
    const orderId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
    const ref = makePayReference(orderId)
    expect(ref).toMatch(/^TRV-PAY-A1B2C3-[0-9A-F]{8}$/)
  })

  it('returns unique references for the same order', () => {
    const orderId = '11111111-2222-3333-4444-555555555555'
    const a = makePayReference(orderId)
    const b = makePayReference(orderId)
    expect(a).not.toBe(b)
  })
})
