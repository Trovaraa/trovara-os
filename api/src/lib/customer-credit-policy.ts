export const DEFAULT_REFERRAL_REFUND_WINDOW_DAYS = 2
export const REFERRAL_QUALIFYING_PAYMENT_STATUSES = ['paid', 'not_required'] as const

export function referralRefundWindowDays(raw = process.env.TROVARA_REFERRAL_REFUND_WINDOW_DAYS): number {
  const configured = Number(raw)
  if (!Number.isInteger(configured) || configured < 0 || configured > 365) {
    return DEFAULT_REFERRAL_REFUND_WINDOW_DAYS
  }
  return configured
}

export function referralRewardEligibleAt(
  deliveredAt: Date,
  refundWindowDays = referralRefundWindowDays(),
): Date {
  return new Date(deliveredAt.getTime() + refundWindowDays * 24 * 60 * 60 * 1000)
}

export function isQualifyingReferralPurchase(order: {
  status: string
  paymentStatus: string
  totalAmount: number
  deliveredAt: Date | null
}): boolean {
  return (
    order.status === 'delivered' &&
    order.deliveredAt !== null &&
    order.totalAmount > 0 &&
    REFERRAL_QUALIFYING_PAYMENT_STATUSES.includes(
      order.paymentStatus as (typeof REFERRAL_QUALIFYING_PAYMENT_STATUSES)[number],
    )
  )
}
