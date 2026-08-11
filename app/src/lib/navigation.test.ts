import { describe, expect, it } from 'vitest'
import { canAccessRoute, defaultHome } from './navigation'
import type { User } from '@/stores/auth'

function user(role: User['role'], permissions: string[] = []): User {
  return { id: 'u1', email: 'u@example.com', name: 'User', farmId: 'f1', role, permissions }
}

describe('frontend route access', () => {
  it('uses one canonical home for every role', () => {
    expect(defaultHome('field_worker')).toBe('/today')
    expect(defaultHome('sales')).toBe('/sales')
    expect(defaultHome('supervisor')).toBe('/dashboard')
  })

  it('honours exact delegated permissions without role fallbacks', () => {
    const delegated = user('supervisor', ['brand.manage'])
    expect(canAccessRoute(delegated, { requiresAuth: true, requiredPermission: 'brand.manage' })).toBe(true)
    expect(canAccessRoute(delegated, { requiresAuth: true, requiredPermission: 'moments.manage' })).toBe(false)
  })

  it('accepts any permission for count-only inventory access', () => {
    const worker = user('field_worker', ['inventory.count'])
    expect(
      canAccessRoute(worker, {
        requiresAuth: true,
        anyPermission: ['inventory.read', 'inventory.count'],
      }),
    ).toBe(true)
  })
})
