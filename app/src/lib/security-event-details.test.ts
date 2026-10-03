import { describe, expect, it } from 'vitest'
import { securityEventDetails } from './security-event-details'

describe('security role display', () => {
  it('shows both saved roles even when extra metadata precedes them', () => {
    expect(securityEventDetails({ via: 'totp', userId: 'user', email: 'synthetic@example.test', farmId: 'farm', role: 'Content Creator', systemRole: 'supervisor' }))
      .toContain('role: Content Creator · system role: supervisor')
  })
  it('labels old role-only entries accurately without modifying the record', () => {
    const old = { role: 'supervisor', ip: '127.0.0.1' }
    expect(securityEventDetails(old)).toBe('role (legacy system): supervisor')
    expect(old).toEqual({ role: 'supervisor', ip: '127.0.0.1' })
  })
  it('handles empty metadata', () => { expect(securityEventDetails({})).toBe('') })
})
