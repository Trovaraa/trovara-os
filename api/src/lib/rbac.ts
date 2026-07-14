import type { UserRole } from '../db/schema.js'
import type { SessionUser } from './session.js'
import { logSecurityEvent } from './security-log.js'

export function hasRole(user: SessionUser, ...roles: UserRole[]): boolean {
  return roles.includes(user.role)
}

export function requireRole(user: SessionUser, ...roles: UserRole[]): void {
  if (!hasRole(user, ...roles)) {
    logSecurityEvent('forbidden_access', {
      userId: user.id,
      farmId: user.farmId,
      role: user.role,
      requiredRoles: roles,
    })
    throw new Error('FORBIDDEN')
  }
}

export function canAccessFinance(user: SessionUser): boolean {
  return user.role === 'owner'
}

export function canApproveTasks(user: SessionUser): boolean {
  return user.role === 'owner' || user.role === 'supervisor'
}

export function canAssignTasks(user: SessionUser): boolean {
  return user.role === 'owner' || user.role === 'supervisor'
}
