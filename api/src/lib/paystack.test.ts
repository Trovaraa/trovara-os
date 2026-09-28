import { createHmac } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initializeTransaction, isAllowedPaystackCheckoutUrl, safePaystackCheckoutUrl, verifyWebhookSignature } from './paystack.js'

const ORIGINAL_SECRET = process.env.PAYSTACK_SECRET_KEY

afterEach(() => {
  vi.unstubAllGlobals()
  if (ORIGINAL_SECRET === undefined) delete process.env.PAYSTACK_SECRET_KEY
  else process.env.PAYSTACK_SECRET_KEY = ORIGINAL_SECRET
})

describe('Paystack checkout URL allowlist', () => {
  it.each([
    'https://other.paystack.com/abc', 'https://paystack.com/abc',
    'https://checkout.paystack.com.evil.example/abc', 'https://checkout.paystack.com@evil.example/abc',
    'https://user:password@checkout.paystack.com/abc', 'https://checkout.paystack.com:8443/abc',
    'http://checkout.paystack.com/abc', 'javascript:alert(1)', '//checkout.paystack.com/abc', '',
  ])('rejects untrusted or ambiguous destination %s', value => {
    expect(isAllowedPaystackCheckoutUrl(value)).toBe(false)
    expect(safePaystackCheckoutUrl(value, 'safe_code')).toBe('https://checkout.paystack.com/safe_code')
  })
  it('accepts checkout.paystack.com and falls back from access codes', () => {
    expect(isAllowedPaystackCheckoutUrl('https://checkout.paystack.com/abc')).toBe(true)
    expect(isAllowedPaystackCheckoutUrl('https://evil.example/abc')).toBe(false)
    expect(safePaystackCheckoutUrl('https://evil.example/abc', 'access_code')).toBe(
      'https://checkout.paystack.com/access_code',
    )
  })
})

describe('Paystack request deadline', () => {
  it('never follows provider redirects with payment payloads or credentials', async () => {
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_redirect'
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    vi.stubGlobal('fetch', fetchMock)
    const result = await initializeTransaction({ email: 'buyer@example.com', amountKobo: 1000, reference: 'TEST-REDIRECT' })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0][1].redirect).toBe('error')
    expect(result.ok).toBe(false)
  })
  it('passes an abortable deadline signal to provider calls', async () => {
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_deadline'
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      expect(init?.signal?.aborted).toBe(false)
      throw new DOMException('request timed out', 'AbortError')
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await initializeTransaction({
      email: 'buyer@example.com',
      amountKobo: 1000,
      reference: 'TRV-PAY-DEADLINE',
    })

    expect(result).toEqual({ ok: false, error: 'request timed out' })
    expect(fetchMock).toHaveBeenCalledOnce()
  })
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
