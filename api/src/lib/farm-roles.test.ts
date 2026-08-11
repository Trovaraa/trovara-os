import { getTableName } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'

const transaction = vi.fn()
const deletedTables: string[] = []
const insertedTables: string[] = []
const rolePatches: Record<string, unknown>[] = []

vi.mock('../db/index.js', () => {
  const tx = {
    select: () => {
      let tableName = ''
      const query: Record<string, unknown> = {}
      const same = () => query
      Object.assign(query, {
        from: (table: unknown) => {
          tableName = getTableName(table as never)
          return query
        },
        where: same,
        limit: same,
        for: same,
        then: (resolve: (value: unknown[]) => unknown) =>
          Promise.resolve(
            tableName === 'farm_roles'
              ? [{ id: 'role-1', clonedFrom: 'supervisor', permissionsVersion: 4 }]
              : [{ permissionKey: 'security.admin' }],
          ).then(resolve),
      })
      return query
    },
    delete: (table: unknown) => ({
      where: async () => {
        deletedTables.push(getTableName(table as never))
      },
    }),
    insert: (table: unknown) => ({
      values: async () => {
        insertedTables.push(getTableName(table as never))
      },
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: async () => {
          rolePatches.push({ table: getTableName(table as never), ...patch })
        },
      }),
    }),
  }
  return {
    db: {
      transaction: (callback: (transaction: typeof tx) => unknown) => {
        transaction()
        return callback(tx)
      },
    },
  }
})
vi.mock('./access-revoke.js', () => ({ revokeAllUserAccess: vi.fn() }))

describe('farm role permission replacement', () => {
  it('replaces grants and increments the version in one transaction', async () => {
    const { setFarmRolePermissions } = await import('./farm-roles.js')
    const result = await setFarmRolePermissions(
      'farm-1',
      'role-1',
      ['reports.read'],
      { revokeSessions: false },
    )

    expect(result).toEqual({ ok: true, revokedUsers: 0 })
    expect(transaction).toHaveBeenCalledTimes(1)
    expect(deletedTables).toEqual(['farm_role_permissions'])
    expect(insertedTables).toEqual(['farm_role_permissions'])
    expect(rolePatches).toEqual([
      expect.objectContaining({ table: 'farm_roles', permissionsVersion: 5 }),
    ])
  })
})
