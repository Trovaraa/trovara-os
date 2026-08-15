import { getTableName } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../db/index.js', () => {
  const queryFor = (table: unknown) => {
    const name = getTableName(table as never)
    const rows = name === 'farm_roles'
      ? [
          { id: 'role-owner', clonedFrom: 'owner' },
          { id: 'role-supervisor', clonedFrom: 'supervisor' },
          { id: 'role-worker', clonedFrom: 'field_worker' },
          { id: 'role-sales', clonedFrom: 'sales' },
        ]
      : name === 'farm_role_permissions'
        ? [{ permissionKey: 'inventory.read' }, { permissionKey: 'finance.read' }]
        : name === 'permission_team_members'
          ? [{ permissionKey: 'knowledge.write' }]
          : name === 'user_permission_overrides'
            ? [{ permissionKey: 'finance.read', effect: 'deny' }, { permissionKey: 'knowledge.read', effect: 'allow' }]
            : []
    const chain: Record<string, unknown> = {}
    const same = () => chain
    Object.assign(chain, { where: same, innerJoin: same, limit: same, then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve) })
    return chain
  }
  return {
    db: {
      select: () => ({ from: (table: unknown) => queryFor(table) }),
      update: () => ({ set: () => ({ where: async () => undefined }) }),
      insert: () => ({ values: () => ({ returning: async () => [], onConflictDoNothing: async () => undefined }) }),
    },
  }
})
vi.mock('./access-revoke.js', () => ({ revokeAllUserAccess: vi.fn() }))

describe('effective role, team, and individual permissions', () => {
  it('unions role and team grants, then applies individual deny and allow last', async () => {
    const { resolvePermissionKeys } = await import('./farm-roles.js')
    const permissions = await resolvePermissionKeys({ role: 'supervisor', farmId: 'farm-1', farmRoleId: 'role-supervisor', userId: 'user-1' })
    expect(permissions).toContain('inventory.read')
    expect(permissions).toContain('knowledge.write')
    expect(permissions).toContain('knowledge.read')
    expect(permissions).not.toContain('finance.read')
  })
})
