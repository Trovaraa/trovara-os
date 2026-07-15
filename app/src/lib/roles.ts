import type { UserRole } from '@/stores/auth'

/** Soft display labels - internal RBAC keys stay owner / supervisor / field_worker. */
export function roleLabel(role: UserRole | string): string {
  switch (role) {
    case 'owner':
      return 'Founder'
    case 'supervisor':
      return 'Supervisor'
    case 'field_worker':
      return 'Field worker'
    default:
      return String(role).replace(/_/g, ' ')
  }
}
