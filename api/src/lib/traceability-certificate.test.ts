import { describe, expect, it } from 'vitest'
import { redactCustomerDisplayName } from './traceability-certificate.js'

describe('redactCustomerDisplayName', () => {
  it('redacts to first name + last initial', () => {
    expect(redactCustomerDisplayName('Ada Okafor')).toBe('Ada O.')
    expect(redactCustomerDisplayName('  Chidi  Emeka  Okonkwo ')).toBe('Chidi O.')
  })

  it('keeps single names and handles empty', () => {
    expect(redactCustomerDisplayName('Ada')).toBe('Ada')
    expect(redactCustomerDisplayName(null)).toBeNull()
    expect(redactCustomerDisplayName('   ')).toBeNull()
  })
})
