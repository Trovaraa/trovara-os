import { describe, expect, it } from 'vitest'
import {
  computeRegistrationTokenStatus,
  hashRegistrationToken,
} from './registration-tokens.js'

describe('hashRegistrationToken', () => {
  it('is deterministic and trims surrounding whitespace', () => {
    expect(hashRegistrationToken('abc123')).toBe(hashRegistrationToken('  abc123 '))
  })

  it('produces a 64-char hex sha256 digest', () => {
    expect(hashRegistrationToken('abc123')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('differs for different tokens', () => {
    expect(hashRegistrationToken('one')).not.toBe(hashRegistrationToken('two'))
  })
})

describe('computeRegistrationTokenStatus', () => {
  const future = new Date(Date.now() + 60 * 60 * 1000)
  const past = new Date(Date.now() - 60 * 60 * 1000)

  it('is valid when unused, unrevoked, and unexpired', () => {
    expect(
      computeRegistrationTokenStatus({ usedAt: null, revokedAt: null, expiresAt: future }),
    ).toBe('valid')
  })

  it('reports used before checking expiry', () => {
    expect(
      computeRegistrationTokenStatus({ usedAt: new Date(), revokedAt: null, expiresAt: past }),
    ).toBe('used')
  })

  it('reports revoked with highest precedence', () => {
    expect(
      computeRegistrationTokenStatus({
        usedAt: new Date(),
        revokedAt: new Date(),
        expiresAt: future,
      }),
    ).toBe('revoked')
  })

  it('reports expired when past its window', () => {
    expect(
      computeRegistrationTokenStatus({ usedAt: null, revokedAt: null, expiresAt: past }),
    ).toBe('expired')
  })
})
