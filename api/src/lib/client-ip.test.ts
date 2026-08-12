import { createHmac } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { clientIpFromHeaders, resolveClientIp } from './client-ip.js'

const originalHops = process.env.TRUSTED_PROXY_HOPS
const originalEnv = process.env.NODE_ENV
const originalProxySecret = process.env.FORM_PROXY_SIGNING_SECRET

afterEach(() => {
  if (originalHops === undefined) delete process.env.TRUSTED_PROXY_HOPS
  else process.env.TRUSTED_PROXY_HOPS = originalHops
  if (originalEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = originalEnv
  if (originalProxySecret === undefined) delete process.env.FORM_PROXY_SIGNING_SECRET
  else process.env.FORM_PROXY_SIGNING_SECRET = originalProxySecret
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

  it('accepts a fresh signed Netlify client identity', () => {
    process.env.FORM_PROXY_SIGNING_SECRET = 'test-proxy-secret'
    const timestamp = String(Date.now())
    const clientId = 'visitor_identity_abcdefghijklmnopqrstuvwxyz1234'
    const signature = createHmac('sha256', process.env.FORM_PROXY_SIGNING_SECRET)
      .update(`${timestamp}.${clientId}`)
      .digest('base64url')
    const headers = new Map([
      ['x-trovara-client-id', clientId],
      ['x-trovara-client-timestamp', timestamp],
      ['x-trovara-client-signature', signature],
    ])

    expect(clientIpFromHeaders((name) => headers.get(name))).toBe(`proxy:${clientId}`)
  })

  it('rejects forged proxy identities', () => {
    process.env.FORM_PROXY_SIGNING_SECRET = 'test-proxy-secret'
    const headers = new Map([
      ['x-trovara-client-id', 'visitor_identity_abcdefghijklmnopqrstuvwxyz1234'],
      ['x-trovara-client-timestamp', String(Date.now())],
      ['x-trovara-client-signature', 'forged'],
      ['x-real-ip', '127.0.0.1'],
    ])

    expect(clientIpFromHeaders((name) => headers.get(name))).toBe('127.0.0.1')
  })
})
