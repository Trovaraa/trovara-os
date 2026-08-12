import { describe, expect, it } from 'vitest'
import {
  canAccessFinance,
  canApproveTasks,
  canAssignTasks,
  canViewAttendanceRoster,
  hasPermission,
  hasRole,
  requirePermission,
  requireRole,
} from './rbac.js'
import type { SessionUser } from './session.js'

function user(
  role: SessionUser['role'],
  permissions?: string[],
): SessionUser {
  return {
    id: '1',
    farmId: 'farm-1',
    email: 'test@trovara.farm',
    name: 'Test User',
    role,
    mustChangePassword: false,
    ...(permissions !== undefined ? { permissions } : {}),
  }
}

describe('hasRole', () => {
  it('returns true when user has one of the roles', () => {
    expect(hasRole(user('owner'), 'owner', 'supervisor')).toBe(true)
    expect(hasRole(user('field_worker'), 'owner')).toBe(false)
  })
})

describe('requireRole', () => {
  it('throws FORBIDDEN when role not allowed', () => {
    expect(() => requireRole(user('field_worker'), 'owner')).toThrow('FORBIDDEN')
  })

  it('does not throw for allowed role', () => {
    expect(() => requireRole(user('supervisor'), 'owner', 'supervisor')).not.toThrow()
  })
})

describe('canAssignTasks', () => {
  it('allows owner and supervisor', () => {
    expect(canAssignTasks(user('owner'))).toBe(true)
    expect(canAssignTasks(user('supervisor'))).toBe(true)
  })

  it('denies field_worker', () => {
    expect(canAssignTasks(user('field_worker'))).toBe(false)
  })
})

describe('canApproveTasks', () => {
  it('allows owner and supervisor', () => {
    expect(canApproveTasks(user('owner'))).toBe(true)
    expect(canApproveTasks(user('supervisor'))).toBe(true)
  })

  it('denies field_worker', () => {
    expect(canApproveTasks(user('field_worker'))).toBe(false)
  })
})

describe('canAccessFinance', () => {
  it('allows owner and sales', () => {
    expect(canAccessFinance(user('owner'))).toBe(true)
    expect(canAccessFinance(user('sales'))).toBe(true)
    expect(canAccessFinance(user('supervisor'))).toBe(false)
    expect(canAccessFinance(user('field_worker'))).toBe(false)
  })
})

describe('canViewAttendanceRoster', () => {
  it('allows owner and supervisor only', () => {
    expect(canViewAttendanceRoster(user('owner'))).toBe(true)
    expect(canViewAttendanceRoster(user('supervisor'))).toBe(true)
    expect(canViewAttendanceRoster(user('sales'))).toBe(false)
    expect(canViewAttendanceRoster(user('field_worker'))).toBe(false)
  })
})

describe('hasPermission fail-closed', () => {
  it('denies when permissions resolved to empty (non-owner)', () => {
    expect(hasPermission(user('field_worker', []), 'vault.view')).toBe(false)
    expect(hasPermission(user('supervisor', []), 'vault.view')).toBe(false)
    expect(hasPermission(user('sales', []), 'orders.read')).toBe(false)
  })

  it('owners still pass when permissions empty', () => {
    expect(hasPermission(user('owner', []), 'vault.reveal')).toBe(true)
  })

  it('uses explicit grants when permissions are loaded', () => {
    expect(hasPermission(user('sales', ['vault.view']), 'vault.view')).toBe(true)
    expect(hasPermission(user('sales', ['vault.view']), 'vault.manage')).toBe(false)
  })

  it('legacy fallback never grants vault.view to field workers', () => {
    // permissions undefined → legacy path (tests / pre-middleware)
    expect(hasPermission(user('field_worker'), 'vault.view')).toBe(false)
    expect(hasPermission(user('sales'), 'vault.view')).toBe(true)
    expect(hasPermission(user('supervisor'), 'vault.view')).toBe(true)
  })

  it('legacy fallback never grants field-operation actions to sales', () => {
    expect(hasPermission(user('sales'), 'assets.count')).toBe(false)
    expect(hasPermission(user('sales'), 'census.create')).toBe(false)
    expect(hasPermission(user('sales'), 'livestock.log')).toBe(false)
    expect(hasPermission(user('sales'), 'field_reports.create')).toBe(false)
    expect(hasPermission(user('field_worker'), 'field_reports.create')).toBe(true)
    expect(hasPermission(user('supervisor'), 'assets.count')).toBe(true)
  })
})

describe('requirePermission', () => {
  it('throws FORBIDDEN when grant missing', () => {
    expect(() => requirePermission(user('field_worker', []), 'vault.view')).toThrow('FORBIDDEN')
  })
})
