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

  it('can combine a base permission with one of several report capabilities', () => {
    const worker = user('field_worker', ['reports.read'])
    const supervisor = user('supervisor', ['reports.read', 'tasks.approve'])
    const meta = {
      requiresAuth: true,
      requiredPermission: 'reports.read',
      anyPermission: ['tasks.approve', 'finance.read', 'audit.export'],
    }

    expect(canAccessRoute(worker, meta)).toBe(false)
    expect(canAccessRoute(supervisor, meta)).toBe(true)
  })

  it('honours role allowlists as well as delegated permissions', () => {
    const staleWorker = user('field_worker', ['orders.read', 'orders.manage'])
    expect(
      canAccessRoute(staleWorker, {
        requiresAuth: true,
        allowedRoles: ['owner', 'supervisor', 'sales'],
        requiredPermission: 'orders.read',
      }),
    ).toBe(false)
  })
})
