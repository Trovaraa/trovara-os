import { describe, expect, it, afterEach } from 'vitest'
import {
  normalizeMarketingOrigin,
  publicMarketingBaseUrl,
  publicMarketingUrlOrDefault,
  publicShopBaseUrl,
  shopAccountUrl,
  shopResetPasswordUrl,
  shopVerifyEmailUrl,
} from './public-app-url.js'

describe('normalizeMarketingOrigin', () => {
  it('strips trailing slashes', () => {
    expect(normalizeMarketingOrigin('https://www.trovara.farm/')).toBe('https://www.trovara.farm')
  })

  it('rewrites apex to www', () => {
    expect(normalizeMarketingOrigin('https://trovara.farm')).toBe('https://www.trovara.farm')
    expect(normalizeMarketingOrigin('http://trovara.farm/')).toBe('https://www.trovara.farm')
  })

  it('leaves non-apex hosts alone', () => {
    expect(normalizeMarketingOrigin('https://www.trovara.farm')).toBe('https://www.trovara.farm')
    expect(normalizeMarketingOrigin('http://localhost:8888')).toBe('http://localhost:8888')
  })
})

describe('publicMarketingUrlOrDefault', () => {
  const prev = process.env.PUBLIC_MARKETING_URL

  afterEach(() => {
    if (prev === undefined) delete process.env.PUBLIC_MARKETING_URL
    else process.env.PUBLIC_MARKETING_URL = prev
  })

  it('defaults to www when unset', () => {
    delete process.env.PUBLIC_MARKETING_URL
    expect(publicMarketingBaseUrl()).toBeNull()
    expect(publicMarketingUrlOrDefault()).toBe('https://www.trovara.farm')
  })

  it('normalizes configured apex', () => {
    process.env.PUBLIC_MARKETING_URL = 'https://trovara.farm/'
    expect(publicMarketingUrlOrDefault()).toBe('https://www.trovara.farm')
  })
})

describe('publicShopBaseUrl', () => {
  const prevShop = process.env.PUBLIC_SHOP_URL
  const prevNode = process.env.NODE_ENV

  afterEach(() => {
    if (prevShop === undefined) delete process.env.PUBLIC_SHOP_URL
    else process.env.PUBLIC_SHOP_URL = prevShop
    if (prevNode === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = prevNode
  })

  it('uses PUBLIC_SHOP_URL when set', () => {
    process.env.PUBLIC_SHOP_URL = 'https://shop.trovara.farm/'
    expect(publicShopBaseUrl()).toBe('https://shop.trovara.farm')
    expect(shopAccountUrl()).toBe('https://shop.trovara.farm')
  })

  it('defaults to shop.trovara.farm in production', () => {
    delete process.env.PUBLIC_SHOP_URL
    process.env.NODE_ENV = 'production'
    expect(publicShopBaseUrl()).toBe('https://shop.trovara.farm')
  })

  it('builds clean verify and reset paths', () => {
    process.env.PUBLIC_SHOP_URL = 'https://shop.trovara.farm'
    expect(shopVerifyEmailUrl('abc')).toBe('https://shop.trovara.farm/verify-email?token=abc')
    expect(shopResetPasswordUrl('xyz')).toBe('https://shop.trovara.farm/reset-password?token=xyz')
  })
})
