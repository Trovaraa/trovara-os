import type { UserRole } from '../db/schema.js'
import type { SessionUser } from './session.js'
import { logSecurityEvent } from './security-log.js'
import type { PermissionKey } from './permissions.js'

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

export function hasPermission(user: SessionUser, key: PermissionKey): boolean {
  if (user.role === 'owner') return true
  // Defined (even empty) means auth resolved grants — do not fall through to
  // legacy defaults (empty = deny). Undefined is for tests / pre-auth callers.
  if (user.permissions !== undefined) return user.permissions.includes(key)
  return legacyPermission(user, key)
}

export function requirePermission(user: SessionUser, key: PermissionKey): void {
  if (!hasPermission(user, key)) {
    logSecurityEvent('forbidden_access', {
      userId: user.id,
      farmId: user.farmId,
      role: user.role,
      requiredPermission: key,
    })
    throw new Error('FORBIDDEN')
  }
}

function legacyPermission(user: SessionUser, key: PermissionKey): boolean {
  switch (key) {
    case 'finance.read':
    case 'finance.write':
      return user.role === 'owner' || user.role === 'sales'
    case 'finance.delete':
    case 'users.manage':
    case 'roles.manage':
    case 'security.admin':
    case 'breakglass.cleanup':
    case 'vault.manage':
    case 'vault.reveal':
    case 'privacy.admin':
    case 'farm.manage':
    case 'newsletter.manage':
    case 'journal.manage':
    case 'brand.manage':
    case 'careers.manage':
    case 'products.delete':
    case 'whatsapp.configure':
      return user.role === 'owner'
    case 'moments.manage':
    case 'tasks.assign':
    case 'tasks.approve':
    case 'attendance.roster':
    case 'inventory.write':
    case 'zones.manage':
    case 'crops.manage':
    case 'livestock.manage':
    case 'whatsapp.send':
    case 'purchase_orders.approve':
      return user.role === 'owner' || user.role === 'supervisor'
    case 'orders.read':
    case 'orders.manage':
    case 'orders.pii':
    case 'products.manage':
      return user.role === 'owner' || user.role === 'supervisor' || user.role === 'sales'
    case 'inventory.count':
    case 'tasks.work_own':
    case 'sessions.revoke':
    case 'reports.read':
      // Broad staff defaults — match field-worker template minimums.
      return true
    case 'inventory.read':
    case 'users.view':
      return user.role === 'owner' || user.role === 'supervisor'
    case 'vault.view':
    case 'integrations.view':
      // Never grant vault/integrations metadata to field workers via legacy.
      return user.role === 'owner' || user.role === 'supervisor' || user.role === 'sales'
    case 'audit.export':
    case 'traceability.export':
      return user.role === 'owner' || user.role === 'sales'
    default:
      return false
  }
}

export function canAccessFinance(user: SessionUser): boolean {
  return hasPermission(user, 'finance.read')
}

/** Farm-wide attendance roster (not own clock-in). */
export function canViewAttendanceRoster(user: SessionUser): boolean {
  return hasPermission(user, 'attendance.roster')
}

export function canApproveTasks(user: SessionUser): boolean {
  return hasPermission(user, 'tasks.approve')
}

export function canAssignTasks(user: SessionUser): boolean {
  return hasPermission(user, 'tasks.assign')
}

/** Owner, supervisor, and sales may manage customer order status. */
export function canManageOrders(user: SessionUser): boolean {
  return hasPermission(user, 'orders.manage')
}

/** Same staff can add / rename / price catalogue products. */
export function canManageProducts(user: SessionUser): boolean {
  return hasPermission(user, 'products.manage')
}

/** Inventory changes are restricted to farm operations management. */
export function canManageInventory(user: SessionUser): boolean {
  return hasPermission(user, 'inventory.write')
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
 * Roles that always receive field-worker alerts (task done → awaiting approval,
 * urgent reports, clock-in). Owner is separate (opt-in via users.worker_alerts_subscribed).
 */
export const WORKER_ALERT_ALWAYS_ROLES: UserRole[] = ['supervisor']
