import { describe, expect, it } from 'vitest'
import { advisoryCloseLine, ensureAdvisoryClose } from './advisory-close.js'

describe('advisory-close', () => {
  it('returns livestock close line', () => {
    expect(advisoryCloseLine('en', 'livestock')).toMatch(/see a vet/i)
  })

  it('appends close when missing', () => {
    const out = ensureAdvisoryClose('Give cool water and electrolytes.', 'en', 'livestock')
    expect(out).toContain('Give cool water')
    expect(out).toMatch(/see a vet/i)
  })

  it('does not duplicate close line', () => {
    const once = ensureAdvisoryClose('If the symptoms persist, see a vet.', 'en', 'livestock')
    expect(once.split(/see a vet/i).length).toBe(2)
  })
})
