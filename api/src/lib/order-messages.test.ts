import { describe, expect, it } from 'vitest'
import {
  customerStatusMessage,
  languageSavedMessage,
  newOrderStaffMessage,
  orderActionResultMessage,
  staffLocale,
} from './order-messages.js'

describe('order-messages', () => {
  it('normalizes staff locale', () => {
    expect(staffLocale('yo')).toBe('yo')
    expect(staffLocale('pidgin')).toBe('pcm')
    expect(staffLocale(null)).toBe('en')
  })

  it('builds localized new-order and status copy', () => {
    const msg = newOrderStaffMessage({
      locale: 'en',
      reference: 'TRV-ORD-ABCDEF',
      channel: 'telegram',
      itemLines: '• 2 × Eggs (crate) @ ₦6,500 = ₦13,000',
      totalLine: 'Total: ₦13,000',
      customerName: 'Ada',
      phone: '0800',
      address: 'Lagos',
      lotCode: 'LOT-1',
    })
    expect(msg).toContain('TRV-ORD-ABCDEF')
    expect(msg).toContain('Total: ₦13,000')
    expect(msg).toContain('confirm TRV-ORD-ABCDEF')

    expect(customerStatusMessage({ locale: 'en', reference: 'TRV-ORD-ABCDEF', status: 'confirmed' })).toContain(
      'confirmed',
    )
    expect(customerStatusMessage({ locale: 'fr', reference: 'TRV-ORD-ABCDEF', status: 'delivered' })).toContain(
      'Merci',
    )
  })

  it('formats action results and language saved', () => {
    expect(
      orderActionResultMessage({
        locale: 'en',
        reference: 'TRV-ORD-ABCDEF',
        status: 'confirmed',
        ok: true,
      }),
    ).toContain('confirmed')
    expect(languageSavedMessage('yo')).toMatch(/Yorùbá|èdè|butler/i)
  })
})
