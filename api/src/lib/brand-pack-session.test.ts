import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import {
  brandPackSessionCookieName,
  createBrandPackSessionToken,
  verifyBrandPackSessionToken,
} from './brand-pack-session.js'

describe('brand-pack-session', () => {
  const prev = process.env.BRAND_PACK_SESSION_SECRET

  beforeEach(() => {
    process.env.BRAND_PACK_SESSION_SECRET = 'test-brand-pack-secret'
  })

  afterEach(() => {
    if (prev === undefined) delete process.env.BRAND_PACK_SESSION_SECRET
    else process.env.BRAND_PACK_SESSION_SECRET = prev
  })

  it('creates a verifiable session token', () => {
    const packId = '11111111-1111-4111-8111-111111111111'
    const { token, maxAgeSec } = createBrandPackSessionToken(packId, null)
    expect(maxAgeSec).toBeGreaterThan(60)
    expect(verifyBrandPackSessionToken(token, packId)).toBe(true)
    expect(verifyBrandPackSessionToken(token, '22222222-2222-4222-8222-222222222222')).toBe(false)
    expect(verifyBrandPackSessionToken(token.slice(0, -2) + 'xx', packId)).toBe(false)
  })

  it('rejects expired tokens', () => {
    const packId = '11111111-1111-4111-8111-111111111111'
    const { token } = createBrandPackSessionToken(packId, new Date(Date.now() + 60_000))
    expect(verifyBrandPackSessionToken(token, packId, Date.now() + 120_000)).toBe(false)
  })

  it('uses a distinct cookie for each protected pack', () => {
    const first = brandPackSessionCookieName('11111111-1111-4111-8111-111111111111')
    const second = brandPackSessionCookieName('22222222-2222-4222-8222-222222222222')
    expect(first).not.toBe(second)
    expect(first).toMatch(/^trovara_brand_pack_[A-Za-z0-9_-]{16}$/)
  })
})
