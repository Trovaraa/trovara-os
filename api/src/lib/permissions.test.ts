import { describe, expect, it } from 'vitest'
import {
  NON_DELEGABLE_PERMISSIONS,
  SYSTEM_ROLE_TEMPLATES,
  filterDelegablePermissions,
  isPermissionKey,
} from './permissions.js'

describe('permissions catalog', () => {
  it('marks security capabilities as non-delegable', () => {
    expect(NON_DELEGABLE_PERMISSIONS.has('roles.manage')).toBe(true)
    expect(NON_DELEGABLE_PERMISSIONS.has('vault.reveal')).toBe(true)
    expect(NON_DELEGABLE_PERMISSIONS.has('breakglass.cleanup')).toBe(true)
  })

  it('filters non-delegable keys from custom grants', () => {
    expect(filterDelegablePermissions(['tasks.assign', 'roles.manage', 'nope'])).toEqual([
      'tasks.assign',
    ])
  })

  it('keeps owner template as full catalog', () => {
    expect(SYSTEM_ROLE_TEMPLATES.owner.permissions.every(isPermissionKey)).toBe(true)
    expect(SYSTEM_ROLE_TEMPLATES.field_worker.permissions).toContain('tasks.work_own')
    expect(SYSTEM_ROLE_TEMPLATES.field_worker.permissions).not.toContain('finance.delete')
  })
})
