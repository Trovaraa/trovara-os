import type { UserRole } from '../db/schema.js'

/** Stable permission keys. Catalog is code-owned; DB stores grants only. */
export const PERMISSION_CATALOG = [
  { key: 'users.view', category: 'people', description: 'View staff roster' },
  { key: 'users.manage', category: 'people', description: 'Create and update staff' },
  { key: 'sessions.revoke', category: 'people', description: 'Revoke own or others sessions' },
  { key: 'roles.manage', category: 'people', description: 'Edit farm roles and grants' },
  { key: 'security.admin', category: 'people', description: 'Security dashboard and TOTP admin' },
  { key: 'breakglass.cleanup', category: 'people', description: 'Break-glass admin deactivate' },
  { key: 'vault.view', category: 'integrations', description: 'View portal vault metadata' },
  { key: 'vault.manage', category: 'integrations', description: 'Create/update/delete vault entries' },
  { key: 'vault.reveal', category: 'integrations', description: 'Reveal vault passwords' },
  { key: 'tasks.work_own', category: 'tasks', description: 'Work assigned tasks' },
  { key: 'tasks.assign', category: 'tasks', description: 'Assign tasks' },
  { key: 'tasks.approve', category: 'tasks', description: 'Approve completed tasks' },
  { key: 'attendance.roster', category: 'tasks', description: 'View attendance roster' },
  { key: 'inventory.read', category: 'operations', description: 'View inventory' },
  { key: 'inventory.write', category: 'operations', description: 'Edit inventory items and movements' },
  { key: 'inventory.count', category: 'operations', description: 'Submit inventory counts' },
  { key: 'zones.manage', category: 'operations', description: 'Manage zones and plots' },
  { key: 'crops.manage', category: 'operations', description: 'Manage crops' },
  { key: 'livestock.manage', category: 'operations', description: 'Manage livestock' },
  { key: 'orders.read', category: 'orders', description: 'View orders' },
  { key: 'orders.manage', category: 'orders', description: 'Create and update orders' },
  { key: 'orders.pii', category: 'orders', description: 'View customer PII on orders' },
  { key: 'products.manage', category: 'orders', description: 'Manage product catalogue' },
  { key: 'products.delete', category: 'orders', description: 'Delete products' },
  { key: 'whatsapp.configure', category: 'comms', description: 'Configure WhatsApp integration' },
  { key: 'purchase_orders.approve', category: 'operations', description: 'Approve purchase orders' },
  { key: 'finance.read', category: 'finance', description: 'View finance' },
  { key: 'finance.write', category: 'finance', description: 'Create/update expenses' },
  { key: 'finance.delete', category: 'finance', description: 'Delete expenses' },
  { key: 'reports.read', category: 'reports', description: 'View reports' },
  { key: 'audit.export', category: 'reports', description: 'Export audit data' },
  { key: 'traceability.export', category: 'reports', description: 'Export traceability' },
  { key: 'whatsapp.send', category: 'comms', description: 'Send WhatsApp messages' },
  { key: 'newsletter.manage', category: 'comms', description: 'Manage newsletter' },
  { key: 'integrations.view', category: 'comms', description: 'View integration status' },
  { key: 'journal.manage', category: 'comms', description: 'Manage blog posts' },
  { key: 'brand.manage', category: 'comms', description: 'Manage brand kit assets and press packs' },
  { key: 'moments.manage', category: 'comms', description: 'Review public Moments gallery submissions' },
  { key: 'careers.manage', category: 'comms', description: 'Manage careers listings for the marketing site' },
  { key: 'privacy.admin', category: 'people', description: 'Privacy export and retention' },
  { key: 'farm.manage', category: 'people', description: 'Edit farm profile, go-live, and demo reset' },
] as const

export type PermissionKey = (typeof PERMISSION_CATALOG)[number]['key']

/** Cannot be granted to non-owner custom roles. */
export const NON_DELEGABLE_PERMISSIONS = new Set<PermissionKey>([
  'roles.manage',
  'security.admin',
  'breakglass.cleanup',
  'vault.manage',
  'vault.reveal',
  'privacy.admin',
  'farm.manage',
  'whatsapp.configure',
  'products.delete',
])

const ALL_KEYS = PERMISSION_CATALOG.map((p) => p.key) as PermissionKey[]

export const SYSTEM_ROLE_TEMPLATES: Record<UserRole, { name: string; permissions: PermissionKey[] }> = {
  owner: {
    name: 'Admin',
    permissions: [...ALL_KEYS],
  },
  supervisor: {
    name: 'Supervisor',
    permissions: [
      'users.view',
      'sessions.revoke',
      'tasks.work_own',
      'tasks.assign',
      'tasks.approve',
      'attendance.roster',
      'inventory.read',
      'inventory.write',
      'inventory.count',
      'zones.manage',
      'crops.manage',
      'livestock.manage',
      'orders.read',
      'orders.manage',
      'orders.pii',
      'products.manage',
      'reports.read',
      'whatsapp.send',
      'integrations.view',
      'vault.view',
      'purchase_orders.approve',
      'moments.manage',
    ],
  },
  sales: {
    name: 'Sales',
    permissions: [
      'sessions.revoke',
      'orders.read',
      'orders.manage',
      'orders.pii',
      'products.manage',
      'finance.read',
      'finance.write',
      'reports.read',
      'audit.export',
      'integrations.view',
      'vault.view',
    ],
  },
  field_worker: {
    name: 'Field worker',
    permissions: [
      'sessions.revoke',
      'tasks.work_own',
      'inventory.count',
    ],
  },
}

export function isPermissionKey(value: string): value is PermissionKey {
  return PERMISSION_CATALOG.some((p) => p.key === value)
}

export function filterDelegablePermissions(keys: string[]): PermissionKey[] {
  return keys.filter((k): k is PermissionKey => isPermissionKey(k) && !NON_DELEGABLE_PERMISSIONS.has(k))
}
