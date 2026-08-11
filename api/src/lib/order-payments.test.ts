import { describe, expect, it } from 'vitest'
import { formatNaira, orderReference } from './customer-cart.js'
import {
  makePayReference,
  renderCustomerCancelRefund,
  renderPaymentReceived,
  webhookPaymentMatchesOrder,
} from './order-payments.js'
import type { ReplyLocale } from './reply-locale.js'

const LOCALES: ReplyLocale[] = ['en', 'fr', 'yo', 'pcm']

const ORDER_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
const ORDER_REF = orderReference(ORDER_ID)
const PAYMENT_REF = 'TRV-PAY-A1B2C3-DEADBEEF'
const AMOUNT = formatNaira(4_000_000) // ₦40,000

describe('makePayReference', () => {
  it('uses TRV-PAY prefix and order short id', () => {
    const ref = makePayReference(ORDER_ID)
    expect(ref).toMatch(/^TRV-PAY-A1B2C3-[0-9A-F]{8}$/)
  })

  it('returns unique references for the same order', () => {
    const a = makePayReference(ORDER_ID)
    const b = makePayReference(ORDER_ID)
    expect(a).not.toBe(b)
  })
})

describe('webhookPaymentMatchesOrder', () => {
  const valid = {
    metadataFarmId: 'farm-a',
    metadataOrderId: ORDER_ID,
    orderFarmId: 'farm-a',
    orderId: ORDER_ID,
    webhookAmountKobo: 4_000_000,
    orderAmountKobo: 4_000_000,
    currency: 'NGN',
  }

  it('accepts matching signed-webhook metadata', () => {
    expect(webhookPaymentMatchesOrder(valid)).toBe(true)
  })

  it('rejects a cross-tenant order claim even when order and amount match', () => {
    expect(webhookPaymentMatchesOrder({ ...valid, metadataFarmId: 'farm-b' })).toBe(false)
  })

  it('rejects amount and currency mismatches', () => {
    expect(webhookPaymentMatchesOrder({ ...valid, webhookAmountKobo: 3_999_999 })).toBe(false)
    expect(webhookPaymentMatchesOrder({ ...valid, currency: 'USD' })).toBe(false)
  })
})

describe('renderPaymentReceived', () => {
  it('keeps the order ref, pay ref, and naira amount verbatim in every locale', () => {
    for (const locale of LOCALES) {
      const msg = renderPaymentReceived(locale, {
        orderRef: ORDER_REF,
        amount: AMOUNT,
        paymentRef: PAYMENT_REF,
      })
      expect(msg).toContain(ORDER_REF)
      expect(msg).toContain(PAYMENT_REF)
      expect(msg).toContain(AMOUNT)
      expect(msg).toContain('₦')
    }
  })

  it('localizes the surrounding copy, not the money or references', () => {
    expect(
      renderPaymentReceived('en', {
        orderRef: ORDER_REF,
        amount: AMOUNT,
        paymentRef: PAYMENT_REF,
      }),
    ).toContain(`💰 Payment received for ${ORDER_REF}`)

    expect(
      renderPaymentReceived('fr', {
        orderRef: ORDER_REF,
        amount: AMOUNT,
        paymentRef: PAYMENT_REF,
      }),
    ).toContain(`💰 Paiement reçu pour ${ORDER_REF}`)

    expect(
      renderPaymentReceived('yo', {
        orderRef: ORDER_REF,
        amount: AMOUNT,
        paymentRef: PAYMENT_REF,
      }),
    ).toContain(`💰 A gba owó fún ${ORDER_REF}`)

    expect(
      renderPaymentReceived('pcm', {
        orderRef: ORDER_REF,
        amount: AMOUNT,
        paymentRef: PAYMENT_REF,
      }),
    ).toContain(`💰 Payment don land for ${ORDER_REF}`)
  })

  it('uses the same en-NG amount string a customer receipt would show', () => {
    expect(AMOUNT).toMatch(/^₦/)
    const fr = renderPaymentReceived('fr', {
      orderRef: ORDER_REF,
      amount: AMOUNT,
      paymentRef: PAYMENT_REF,
    })
    expect(fr).toContain(`Montant: ${AMOUNT}`)
  })
})

describe('renderCustomerCancelRefund', () => {
  it('keeps the TRV-ORD reference intact in every locale', () => {
    for (const locale of LOCALES) {
      const msg = renderCustomerCancelRefund(locale, { orderRef: ORDER_REF })
      expect(msg).toContain(ORDER_REF)
      expect(msg).toContain('Sales')
    }
  })

  it('localizes the cancel copy around the order reference', () => {
    expect(renderCustomerCancelRefund('en', { orderRef: ORDER_REF })).toContain(
      `⚠️ Customer cancelled ${ORDER_REF} — initiate refund in Sales.`,
    )
    expect(renderCustomerCancelRefund('fr', { orderRef: ORDER_REF })).toContain(
      `⚠️ Le client a annulé ${ORDER_REF} — lancez le remboursement dans Sales.`,
    )
    expect(renderCustomerCancelRefund('yo', { orderRef: ORDER_REF })).toContain(
      `⚠️ Oníbàárà fagilé ${ORDER_REF} — bẹ̀rẹ̀ ìdápadà owó ní Sales.`,
    )
    expect(renderCustomerCancelRefund('pcm', { orderRef: ORDER_REF })).toContain(
      `⚠️ Customer don cancel ${ORDER_REF} — start refund for Sales.`,
    )
  })
})
