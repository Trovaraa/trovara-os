import { describe, expect, it, afterEach } from 'vitest'
import {
  normalizeMarketingOrigin,
  publicMarketingBaseUrl,
  publicMarketingUrlOrDefault,
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
