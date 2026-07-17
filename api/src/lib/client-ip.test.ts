import { afterEach, describe, expect, it } from 'vitest'
import { resolveClientIp } from './client-ip.js'

const originalHops = process.env.TRUSTED_PROXY_HOPS
const originalEnv = process.env.NODE_ENV

afterEach(() => {
  if (originalHops === undefined) delete process.env.TRUSTED_PROXY_HOPS
  else process.env.TRUSTED_PROXY_HOPS = originalHops
  if (originalEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = originalEnv
})

describe('resolveClientIp', () => {
  it('ignores X-Forwarded-For when TRUSTED_PROXY_HOPS=0', () => {
    process.env.TRUSTED_PROXY_HOPS = '0'
    expect(
      resolveClientIp({
        forwardedFor: '1.2.3.4, 10.0.0.1',
        fallback: '127.0.0.1',
      }),
    ).toBe('127.0.0.1')
  })

  it('takes the client left of one trusted proxy hop', () => {
    process.env.TRUSTED_PROXY_HOPS = '1'
    expect(
      resolveClientIp({
        forwardedFor: '203.0.113.10, 10.0.0.1',
        fallback: 'local',
      }),
    ).toBe('203.0.113.10')
  })

  it('does not let a client spoof past the trusted hop', () => {
    process.env.TRUSTED_PROXY_HOPS = '1'
    // Attacker sends XFF: fake, real-client — nginx appends its own IP
    expect(
      resolveClientIp({
        forwardedFor: '8.8.8.8, 203.0.113.10, 10.0.0.1',
        fallback: 'local',
      }),
    ).toBe('203.0.113.10')
  })
})
