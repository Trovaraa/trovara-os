import { describe, expect, it } from 'vitest'
import {
  countryCodeToName,
  enrichAccessLocation,
  isNonPublicIp,
  lookupIpLocation,
} from './ip-location.js'

describe('ip-location', () => {
  it('maps ISO country codes to English names', () => {
    expect(countryCodeToName('nl')).toBe('Netherlands')
    expect(countryCodeToName('NG')).toBe('Nigeria')
  })

  it('treats loopback and private ranges as non-public', () => {
    expect(isNonPublicIp('127.0.0.1')).toBe(true)
    expect(isNonPublicIp('10.0.0.5')).toBe(true)
    expect(isNonPublicIp('192.168.1.10')).toBe(true)
    expect(isNonPublicIp('172.16.0.1')).toBe(true)
    expect(isNonPublicIp('8.8.8.8')).toBe(false)
  })

  it('looks up a well-known public IP', () => {
    const hit = lookupIpLocation('8.8.8.8')
    expect(hit?.countryCode).toBe('US')
    expect(hit?.country).toBe('United States')
  })

  it('enriches metadata that only has an IP', () => {
    const enriched = enrichAccessLocation({ ip: '8.8.8.8', reason: 'failed_login' })
    expect(enriched.reason).toBe('failed_login')
    expect(enriched.country).toBe('United States')
  })

  it('expands a two-letter country code already on the event', () => {
    const enriched = enrichAccessLocation({ ip: '203.0.113.10', country: 'nl', region: 'ZH' })
    expect(enriched.country).toBe('Netherlands')
    expect(enriched.region).toBe('ZH')
  })
})
