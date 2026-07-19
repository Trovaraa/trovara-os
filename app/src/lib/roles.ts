import type { UserRole } from '@/stores/auth'

/** Soft display labels - internal RBAC keys stay owner / supervisor / field_worker / sales. */
export function roleLabel(role: UserRole | string): string {
  switch (role) {
    case 'owner':
      return 'Admin'
    case 'supervisor':
      return 'Supervisor'
    case 'field_worker':
      return 'Field worker'
    case 'sales':
      return 'Sales'
    default:
      return String(role).replace(/_/g, ' ')
  }
}
