import { describe, expect, it } from 'vitest'
import type { SessionUser } from './session.js'
import {
  redactOrderForRole,
  shouldRedactSalesPii,
} from './sales-redaction.js'

function user(role: SessionUser['role']): SessionUser {
  return {
    id: 'u-1',
    farmId: 'farm-1',
    email: 'w@trovara.farm',
    name: 'Worker',
    role,
    mustChangePassword: false,
  }
}

describe('sales-redaction', () => {
  it('redacts PII for field_worker', () => {
    expect(shouldRedactSalesPii(user('field_worker'))).toBe(true)
    const redacted = redactOrderForRole(
      {
        customerName: 'Ada Customer',
        customerPhone: '08012345678',
        notes: 'Call before delivery',
        customerFeedback: 'Ada here — the crates came late to 14 Bode Thomas',
        customerContactId: 'contact-1',
      },
      user('field_worker'),
    )
    expect(redacted.customerName).toBe('[redacted]')
    expect(redacted.customerPhone).toBeNull()
    expect(redacted.notes).toBeNull()
    expect(redacted.customerContactId).toBeNull()
  })

  // The review is written by the buyer and regularly names them or repeats the
  // delivery address, so it has to go with the name and phone rather than sit
  // beside them in the clear.
  it('redacts the customer review for field_worker', () => {
    const redacted = redactOrderForRole(
      { customerFeedback: 'Ada here — the crates came late to 14 Bode Thomas' },
      user('field_worker'),
    )
    expect(redacted.customerFeedback).toBeNull()
  })

  it('preserves full data for supervisor', () => {
    const order = {
      customerName: 'Ada Customer',
      customerPhone: '08012345678',
      notes: 'Gate B',
      customerFeedback: 'Great plantain, will reorder',
      customerContactId: 'contact-1',
    }
    expect(redactOrderForRole(order, user('supervisor'))).toEqual(order)
  })
})
