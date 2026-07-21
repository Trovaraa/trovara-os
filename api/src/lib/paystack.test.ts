import { createHmac } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyWebhookSignature } from './paystack.js'

const ORIGINAL_SECRET = process.env.PAYSTACK_SECRET_KEY

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.PAYSTACK_SECRET_KEY
  else process.env.PAYSTACK_SECRET_KEY = ORIGINAL_SECRET
})

describe('verifyWebhookSignature', () => {
  it('returns true for a valid HMAC SHA512 signature', () => {
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_verify_signature'
    const rawBody = JSON.stringify({ event: 'charge.success', data: { reference: 'TRV-PAY-ABC' } })
    const signature = createHmac('sha512', 'sk_test_verify_signature')
      .update(rawBody, 'utf8')
      .digest('hex')

    expect(verifyWebhookSignature(rawBody, signature)).toBe(true)
  })

  it('returns false for a wrong signature', () => {
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_verify_signature'
    const rawBody = '{"event":"charge.success"}'
    expect(verifyWebhookSignature(rawBody, 'deadbeef')).toBe(false)
  })

  it('returns false when signature header is missing', () => {
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_verify_signature'
    expect(verifyWebhookSignature('{}', undefined)).toBe(false)
  })

  it('returns false when secret is not configured', () => {
    delete process.env.PAYSTACK_SECRET_KEY
    const rawBody = '{}'
    const signature = createHmac('sha512', 'anything').update(rawBody, 'utf8').digest('hex')
    expect(verifyWebhookSignature(rawBody, signature)).toBe(false)
  })
})
