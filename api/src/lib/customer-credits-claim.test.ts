process.env.DATABASE_URL ??= 'postgresql://test:test@127.0.0.1:5432/test'

import { describe, expect, it } from 'vitest'
import {
  creditClaimPreservesExistingPassword,
  maskEmail,
  TROVARA_WELCOME_CREDITS,
} from './customer-credits.js'

describe('Trovara Credits welcome award', () => {
  it('awards exactly 2,000 credits when an eligible invitation is claimed', () => {
    expect(TROVARA_WELCOME_CREDITS).toBe(2_000)
  })
})

describe('maskEmail', () => {
  it('keeps the first local character and the domain', () => {
    expect(maskEmail('ada@trovara.farm')).toBe('a***@trovara.farm')
  })

  it('rejects malformed addresses', () => {
    expect(maskEmail('not-an-email')).toBe('***')
    expect(maskEmail('@farm')).toBe('***')
  })
})

describe('creditClaimPreservesExistingPassword', () => {
  it('preserves a verified account password', () => {
    expect(creditClaimPreservesExistingPassword({ emailVerifiedAt: new Date() })).toBe(true)
  })

  it('allows setting a password for unverified or missing accounts', () => {
    expect(creditClaimPreservesExistingPassword({ emailVerifiedAt: null })).toBe(false)
    expect(creditClaimPreservesExistingPassword(null)).toBe(false)
  })
})
