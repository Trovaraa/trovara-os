import type { User, UserRole } from '@/stores/auth'

export type RouteAccessMeta = {
  requiresAuth?: boolean
  guest?: boolean
  fieldWorkerOnly?: boolean
  requiredPermission?: string
  anyPermission?: string[]
  allowedRoles?: UserRole[]
}

export function defaultHome(role?: UserRole | string): string {
  if (role === 'field_worker') return '/today'
  if (role === 'sales') return '/sales'
  return '/dashboard'
}

export function hasPermission(user: User | null | undefined, permission: string): boolean {
  return user?.role === 'owner' || Boolean(user?.permissions?.includes(permission))
}

export function canAccessRoute(user: User | null | undefined, meta: RouteAccessMeta): boolean {
  if (!user) return !meta.requiresAuth
  if (meta.fieldWorkerOnly && user.role !== 'field_worker') return false
  if (meta.allowedRoles?.length && !meta.allowedRoles.includes(user.role)) return false
  if (meta.requiredPermission && !hasPermission(user, meta.requiredPermission)) return false
  if (
    meta.anyPermission?.length &&
    !meta.anyPermission.some((permission) => hasPermission(user, permission))
  ) {
    return false
  }
  return true
}
