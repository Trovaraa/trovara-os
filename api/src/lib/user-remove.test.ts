import { describe, expect, it } from 'vitest'
import { isAnonymizedUserEmail } from './user-remove.js'

describe('isAnonymizedUserEmail', () => {
  it('detects anonymized staff emails', () => {
    expect(isAnonymizedUserEmail('anon@abc-123.invalid')).toBe(true)
  })

  it('rejects normal emails', () => {
    expect(isAnonymizedUserEmail('worker@farm.example')).toBe(false)
    expect(isAnonymizedUserEmail('anon@somewhere.com')).toBe(false)
  })
})
