import { describe, expect, it } from 'vitest'
import {
  AUDIT_DOMAIN_ENTITY_TYPES,
  auditDomainForEntityType,
  entityTypesForAuditDomain,
} from './audit-catalog.js'

describe('audit-catalog', () => {
  it('maps known entity types to domains', () => {
    expect(auditDomainForEntityType('order')).toBe('orders')
    expect(auditDomainForEntityType('portal_vault_entry')).toBe('vault')
    expect(auditDomainForEntityType('farm_role')).toBe('identity')
    expect(auditDomainForEntityType('payment_attempt')).toBe('payments')
    expect(auditDomainForEntityType('mystery_thing')).toBe('other')
  })

  it('returns entity types for a domain filter', () => {
    expect(entityTypesForAuditDomain('all')).toBeNull()
    expect(entityTypesForAuditDomain('orders')).toEqual(['order'])
    const otherKnown = entityTypesForAuditDomain('other')
    expect(otherKnown).toContain('order')
    expect(otherKnown!.length).toBeGreaterThan(5)
  })

  it('keeps catalog domains non-empty except other', () => {
    for (const [domain, types] of Object.entries(AUDIT_DOMAIN_ENTITY_TYPES)) {
      if (domain === 'other') {
        expect(types).toEqual([])
      } else {
        expect(types.length).toBeGreaterThan(0)
      }
    }
  })
})
