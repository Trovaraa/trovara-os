import { describe, expect, it } from 'vitest'
import { nextShopDeliveryWindow, nextShopRecurringCheckout, shopDeliveryWindowOn } from './shop-delivery-windows.js'

const saturday = { dayOfWeek: 6, startTime: '09:00', endTime: '12:00', cutoffHours: 24 }

describe('Shop delivery windows', () => {
  it('includes the exact cutoff instant and rolls to the following week immediately after', () => {
    const cutoff = new Date('2026-11-27T08:00:00.000Z')
    const next = nextShopDeliveryWindow(saturday, cutoff)
    expect(next).toEqual({
      deliveryDate: '2026-11-28',
      startsAt: new Date('2026-11-28T08:00:00.000Z'),
      orderCutoffAt: cutoff,
    })
    expect(shopDeliveryWindowOn(saturday, '2026-11-28')).toEqual(next)
    expect(nextShopDeliveryWindow(saturday, new Date(cutoff.getTime() + 1))?.deliveryDate).toBe('2026-12-05')
  })

  it('handles Lagos midnight and weekday rollover independently of the caller timezone', () => {
    const sunday = { ...saturday, dayOfWeek: 0, startTime: '00:15', cutoffHours: 0 }
    const date = new Date('2026-11-28T18:00:00-05:00')
    expect(nextShopDeliveryWindow(sunday, date)).toEqual({
      deliveryDate: '2026-11-29',
      startsAt: new Date('2026-11-28T23:15:00.000Z'),
      orderCutoffAt: new Date('2026-11-28T23:15:00.000Z'),
    })
    expect(shopDeliveryWindowOn(sunday, '2026-11-28')).toBeNull()
  })

  it('can skip multiple weeks when a seven-day occurrence falls inside a longer cutoff', () => {
    const cutoffTwoWeeks = { ...saturday, cutoffHours: 336 }
    const now = new Date('2026-12-19T08:00:00.001Z')
    expect(nextShopDeliveryWindow(cutoffTwoWeeks, now)?.deliveryDate).toBe('2027-01-09')
  })

  it('rejects nonexistent dates and malformed slots', () => {
    // 30 February would roll forward to a Monday in JS; the supplied date is still invalid.
    const monday = { ...saturday, dayOfWeek: 1 }
    expect(shopDeliveryWindowOn(monday, '2026-02-30')).toBeNull()
    expect(shopDeliveryWindowOn(saturday, '2026-13-01')).toBeNull()
    expect(shopDeliveryWindowOn(saturday, 'tomorrow')).toBeNull()
    const now = new Date('2026-11-25T12:00:00Z')
    expect(nextShopDeliveryWindow({ ...saturday, startTime: '25:00' }, now)).toBeNull()
    expect(nextShopDeliveryWindow({ ...saturday, endTime: '9am' }, now)).toBeNull()
    expect(nextShopDeliveryWindow({ ...saturday, dayOfWeek: 7 }, now)).toBeNull()
    expect(nextShopDeliveryWindow({ ...saturday, cutoffHours: -1 }, now)).toBeNull()
  })

  it('advances a midnight monthly repeat by its Lagos calendar date', () => {
    // 00:15 on 1 November in Lagos is still 31 October in UTC.
    const date = new Date('2026-10-31T23:15:00.000Z')
    expect(nextShopRecurringCheckout(date, 'monthly', 'Africa/Lagos').toISOString()).toBe('2026-11-30T23:15:00.000Z')
  })
})
