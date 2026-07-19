import { describe, expect, it } from 'vitest'
import { parseStaffOrderCommand } from './order-fulfillment.js'

describe('parseStaffOrderCommand', () => {
  it('parses slash and plain commands with optional refs', () => {
    expect(parseStaffOrderCommand('/delivered')).toEqual({ action: 'deliver' })
    expect(parseStaffOrderCommand('/dispatch TRV-ORD-ABCDEF')).toEqual({
      action: 'dispatch',
      ref: 'TRV-ORD-ABCDEF',
    })
    expect(parseStaffOrderCommand('delivered TRV-ORD-ABCDEF')).toEqual({
      action: 'deliver',
      ref: 'TRV-ORD-ABCDEF',
    })
    expect(parseStaffOrderCommand('dispatched ABCDEF')).toEqual({
      action: 'dispatch',
      ref: 'ABCDEF',
    })
    expect(parseStaffOrderCommand('/cancel TRV-ORD-ABCDEF')).toEqual({
      action: 'cancel',
      ref: 'TRV-ORD-ABCDEF',
    })
  })

  it('ignores unrelated text', () => {
    expect(parseStaffOrderCommand('hello')).toBeNull()
    expect(parseStaffOrderCommand('/lots')).toBeNull()
  })
})
