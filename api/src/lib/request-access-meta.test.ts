import { describe, expect, it } from 'vitest'
import { requestAccessMeta, withAccessMeta } from './request-access-meta.js'

describe('requestAccessMeta', () => {
  it('resolves IP and optional Cloudflare country/region', () => {
    const headers: Record<string, string> = {
      'x-forwarded-for': '203.0.113.10, 10.0.0.1',
      'x-real-ip': '10.0.0.1',
      'cf-ipcountry': 'NG',
      'cf-region': 'LA',
    }
    const prev = process.env.TRUSTED_PROXY_HOPS
    process.env.TRUSTED_PROXY_HOPS = '1'
    try {
      const meta = requestAccessMeta((name) => headers[name.toLowerCase()])
      expect(meta).toEqual({ ip: '203.0.113.10', country: 'Nigeria', region: 'LA' })
    } finally {
      if (prev === undefined) delete process.env.TRUSTED_PROXY_HOPS
      else process.env.TRUSTED_PROXY_HOPS = prev
    }
  })

  it('approximates location from public IP when geo headers are absent', () => {
    const meta = requestAccessMeta((name) =>
      name === 'x-real-ip' ? '8.8.8.8' : undefined,
    )
    expect(meta.ip).toBe('8.8.8.8')
    expect(meta.country).toBe('United States')
  })

  it('omits XX / T1 country codes', () => {
    const meta = requestAccessMeta((name) =>
      name === 'cf-ipcountry' ? 'XX' : name === 'x-real-ip' ? '127.0.0.1' : undefined,
    )
    expect(meta.country).toBeUndefined()
    expect(meta.ip).toBe('127.0.0.1')
  })

  it('merges into metadata without dropping caller fields', () => {
    const merged = withAccessMeta(
      (name) => (name === 'x-real-ip' ? '198.51.100.2' : undefined),
      { reason: 'failed_login' },
    )
    expect(merged).toEqual({ reason: 'failed_login', ip: '198.51.100.2' })
  })
})
