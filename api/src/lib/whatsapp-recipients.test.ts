import { describe, expect, it } from 'vitest'
import { normalizePhone } from './whatsapp-recipients.js'

describe('normalizePhone', () => {
  it('strips non-digits', () => {
    expect(normalizePhone('+234 801 234 5678')).toBe('2348012345678')
  })
})
