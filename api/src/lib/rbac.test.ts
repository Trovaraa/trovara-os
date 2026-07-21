import { describe, expect, it } from 'vitest'
import {
  canAccessFinance,
  canApproveTasks,
  canAssignTasks,
  canViewAttendanceRoster,
  hasRole,
  requireRole,
} from './rbac.js'
import type { SessionUser } from './session.js'

function user(role: SessionUser['role']): SessionUser {
  return {
    id: '1',
    farmId: 'farm-1',
    email: 'test@trovara.farm',
    name: 'Test User',
    role,
    mustChangePassword: false,
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
