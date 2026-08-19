import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_REFERRAL_REFUND_WINDOW_DAYS,
  isQualifyingReferralPurchase,
  referralRefundWindowDays,
  referralRewardEligibleAt,
} from './customer-credit-policy.js'

describe('Trovara Farm Credits referral policy', () => {
  afterEach(() => {
    delete process.env.TROVARA_REFERRAL_REFUND_WINDOW_DAYS
  })

  it('uses the configured refund window and rejects unsafe values', () => {
    expect(referralRefundWindowDays('5')).toBe(5)
    expect(referralRefundWindowDays('-1')).toBe(DEFAULT_REFERRAL_REFUND_WINDOW_DAYS)
    expect(referralRefundWindowDays('not-a-number')).toBe(DEFAULT_REFERRAL_REFUND_WINDOW_DAYS)
  })

  it('starts the reward clock at delivery', () => {
    const deliveredAt = new Date('2026-08-19T12:00:00.000Z')
    expect(referralRewardEligibleAt(deliveredAt, 2).toISOString()).toBe('2026-08-21T12:00:00.000Z')
  })

  it('qualifies only delivered, paid or cash purchases with a positive total', () => {
    const deliveredAt = new Date('2026-08-19T12:00:00.000Z')
    expect(isQualifyingReferralPurchase({ status: 'delivered', paymentStatus: 'paid', totalAmount: 1, deliveredAt })).toBe(true)
    expect(isQualifyingReferralPurchase({ status: 'delivered', paymentStatus: 'not_required', totalAmount: 1, deliveredAt })).toBe(true)
    expect(isQualifyingReferralPurchase({ status: 'delivered', paymentStatus: 'refund_pending', totalAmount: 1, deliveredAt })).toBe(false)
    expect(isQualifyingReferralPurchase({ status: 'delivered', paymentStatus: 'refunded', totalAmount: 1, deliveredAt })).toBe(false)
    expect(isQualifyingReferralPurchase({ status: 'confirmed', paymentStatus: 'paid', totalAmount: 1, deliveredAt: null })).toBe(false)
  })
})
