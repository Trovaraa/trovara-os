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

/** Owner, supervisor, and sales may manage customer order status. */
export function canManageOrders(user: SessionUser): boolean {
  return user.role === 'owner' || user.role === 'supervisor' || user.role === 'sales'
}

/** Same staff can add / rename / price catalogue products. */
export function canManageProducts(user: SessionUser): boolean {
  return canManageOrders(user)
}

/** Owner, supervisor, and sales may record stock moves and opening counts. */
export function canManageInventory(user: SessionUser): boolean {
  return user.role === 'owner' || user.role === 'supervisor' || user.role === 'sales'
}

/** Roles that can act on orders in the app / messaging bots. */
export const ORDER_STAFF_ROLES: UserRole[] = ['owner', 'supervisor', 'sales']

/**
 * Roles that always receive customer-order push alerts (new order, feedback…).
 * Owner is separate (opt-in via users.order_alerts_subscribed). Field workers never.
 * Sales covers packing / delivery staff today (no separate delivery role).
 */
export const ORDER_ALERT_ALWAYS_ROLES: UserRole[] = ['supervisor', 'sales']

/**
 * Roles that always receive field-worker alerts (task done → awaiting approval, urgent reports).
 * Owner is separate (opt-in via users.worker_alerts_subscribed).
 */
export const WORKER_ALERT_ALWAYS_ROLES: UserRole[] = ['supervisor']
