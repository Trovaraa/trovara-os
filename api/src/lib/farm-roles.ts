import { and, eq, inArray, isNull } from 'drizzle-orm'
import { db } from '../db/index.js'
import { farmRolePermissions, farmRoles, users, type UserRole } from '../db/schema.js'
import {
  NON_DELEGABLE_PERMISSIONS,
  SYSTEM_ROLE_TEMPLATES,
  filterDelegablePermissions,
  isPermissionKey,
  type PermissionKey,
} from './permissions.js'
import { revokeAllUserAccess } from './access-revoke.js'

const SYSTEM_ROLE_KEYS: UserRole[] = ['owner', 'supervisor', 'field_worker', 'sales']

export async function ensureFarmSystemRoles(farmId: string): Promise<void> {
  const existing = await db
    .select({ id: farmRoles.id, clonedFrom: farmRoles.clonedFrom })
    .from(farmRoles)
    .where(and(eq(farmRoles.farmId, farmId), eq(farmRoles.isSystem, true)))

  const byClone = new Map(existing.map((r) => [r.clonedFrom, r.id]))

  for (const roleKey of SYSTEM_ROLE_KEYS) {
    const template = SYSTEM_ROLE_TEMPLATES[roleKey]
    const existingRoleId = byClone.get(roleKey)
    if (!existingRoleId) {
      const [created] = await db
        .insert(farmRoles)
        .values({
          farmId,
          name: template.name,
          isSystem: true,
          clonedFrom: roleKey,
        })
        .returning({ id: farmRoles.id })
      if (template.permissions.length) {
        await db.insert(farmRolePermissions).values(
          template.permissions.map((permissionKey) => ({ roleId: created.id, permissionKey })),
        )
      }
    } else if (template.permissions.length) {
      // Additive only: new catalog keys land on existing system roles without
      // wiping custom grants or bumping permissionsVersion (which revokes sessions).
      const granted = await db
        .select({ permissionKey: farmRolePermissions.permissionKey })
        .from(farmRolePermissions)
        .where(eq(farmRolePermissions.roleId, existingRoleId))
      const have = new Set(granted.map((row) => row.permissionKey))
      const missing = template.permissions.filter((permissionKey) => !have.has(permissionKey))
      if (missing.length) {
        await db
          .insert(farmRolePermissions)
          .values(missing.map((permissionKey) => ({ roleId: existingRoleId, permissionKey })))
          .onConflictDoNothing()
      }
    }
  }

  const templates = await db
    .select({ id: farmRoles.id, clonedFrom: farmRoles.clonedFrom })
    .from(farmRoles)
    .where(and(eq(farmRoles.farmId, farmId), eq(farmRoles.isSystem, true)))

  for (const tmpl of templates) {
    if (!tmpl.clonedFrom || !SYSTEM_ROLE_KEYS.includes(tmpl.clonedFrom as UserRole)) continue
    await db
      .update(users)
      .set({ farmRoleId: tmpl.id })
      .where(
        and(
          eq(users.farmId, farmId),
          eq(users.role, tmpl.clonedFrom as UserRole),
          isNull(users.farmRoleId),
        ),
      )
  }
}

export async function resolvePermissionKeys(input: {
  role: UserRole
  farmId: string
  farmRoleId?: string | null
}): Promise<PermissionKey[]> {
  if (input.role === 'owner') {
    return [...SYSTEM_ROLE_TEMPLATES.owner.permissions]
  }

  await ensureFarmSystemRoles(input.farmId)

  let roleId = input.farmRoleId
  if (!roleId) {
    const [tmpl] = await db
      .select({ id: farmRoles.id })
      .from(farmRoles)
      .where(
        and(
          eq(farmRoles.farmId, input.farmId),
          eq(farmRoles.isSystem, true),
          eq(farmRoles.clonedFrom, input.role),
        ),
      )
      .limit(1)
    roleId = tmpl?.id
  }

  if (!roleId) {
    return [...SYSTEM_ROLE_TEMPLATES[input.role].permissions]
  }

  const rows = await db
    .select({ permissionKey: farmRolePermissions.permissionKey })
    .from(farmRolePermissions)
    .where(eq(farmRolePermissions.roleId, roleId))

  const keys = rows
    .map((r) => r.permissionKey)
    .filter((k): k is PermissionKey => isPermissionKey(k))

  return keys.length ? keys : [...SYSTEM_ROLE_TEMPLATES[input.role].permissions]
}

export async function listFarmRoles(farmId: string) {
  await ensureFarmSystemRoles(farmId)
  const roles = await db.select().from(farmRoles).where(eq(farmRoles.farmId, farmId))

  const roleIds = roles.map((r) => r.id)
  const grants =
    roleIds.length === 0
      ? []
      : await db
          .select()
          .from(farmRolePermissions)
          .where(inArray(farmRolePermissions.roleId, roleIds))

  const byRole = new Map<string, string[]>()
  for (const g of grants) {
    const list = byRole.get(g.roleId) ?? []
    list.push(g.permissionKey)
    byRole.set(g.roleId, list)
  }

  return roles
    .map((r) => ({
      id: r.id,
      name: r.name,
      isSystem: r.isSystem,
      clonedFrom: r.clonedFrom,
      permissionsVersion: r.permissionsVersion,
      permissions: (byRole.get(r.id) ?? []).sort(),
      updatedAt: r.updatedAt.toISOString(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export async function setFarmRolePermissions(
  farmId: string,
  roleId: string,
  permissionKeys: string[],
  options?: { revokeSessions?: boolean },
): Promise<{ ok: true; revokedUsers: number } | { ok: false; error: string; status: 400 | 404 }> {
  const next = filterDelegablePermissions(permissionKeys)
  const replacement = await db.transaction(async (tx) => {
    // Serialize replacements for one role so permissions and their version move
    // together and concurrent writers cannot interleave delete/insert phases.
    const [role] = await tx
      .select()
      .from(farmRoles)
      .where(and(eq(farmRoles.id, roleId), eq(farmRoles.farmId, farmId)))
      .limit(1)
      .for('update')
    if (!role) {
      return { ok: false as const, error: 'Role not found', status: 404 as const }
    }
    if (role.clonedFrom === 'owner') {
      return {
        ok: false as const,
        error: 'Admin role permissions cannot be edited',
        status: 400 as const,
      }
    }

    const current = await tx
      .select({ permissionKey: farmRolePermissions.permissionKey })
      .from(farmRolePermissions)
      .where(eq(farmRolePermissions.roleId, roleId))
    const keepNonDelegable = current
      .map((r) => r.permissionKey)
      .filter((k): k is PermissionKey => isPermissionKey(k) && NON_DELEGABLE_PERMISSIONS.has(k))
    const finalKeys = [...new Set([...next, ...keepNonDelegable])]

    await tx.delete(farmRolePermissions).where(eq(farmRolePermissions.roleId, roleId))
    if (finalKeys.length) {
      await tx.insert(farmRolePermissions).values(
        finalKeys.map((permissionKey) => ({ roleId, permissionKey })),
      )
    }
    await tx
      .update(farmRoles)
      .set({
        permissionsVersion: role.permissionsVersion + 1,
        updatedAt: new Date(),
      })
      .where(and(eq(farmRoles.id, roleId), eq(farmRoles.farmId, farmId)))

    return { ok: true as const }
  })
  if (!replacement.ok) return replacement

  let revokedUsers = 0
  if (options?.revokeSessions !== false) {
    const assigned = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.farmId, farmId), eq(users.farmRoleId, roleId)))
    for (const u of assigned) {
      await revokeAllUserAccess(u.id)
      revokedUsers += 1
    }
  }

  return { ok: true, revokedUsers }
}

export async function createCustomFarmRole(
  farmId: string,
  input: { name: string; cloneFromRoleId?: string; permissions?: string[] },
) {
  await ensureFarmSystemRoles(farmId)
  const name = input.name.trim()
  if (!name) throw new Error('NAME_REQUIRED')

  let permissions: PermissionKey[] = []
  let clonedFrom: string | null = null
  if (input.cloneFromRoleId) {
    const [source] = await db
      .select()
      .from(farmRoles)
      .where(and(eq(farmRoles.id, input.cloneFromRoleId), eq(farmRoles.farmId, farmId)))
      .limit(1)
    if (!source) throw new Error('CLONE_SOURCE_NOT_FOUND')
    clonedFrom = source.clonedFrom
    const grants = await db
      .select({ permissionKey: farmRolePermissions.permissionKey })
      .from(farmRolePermissions)
      .where(eq(farmRolePermissions.roleId, source.id))
    permissions = filterDelegablePermissions(grants.map((g) => g.permissionKey))
  } else if (input.permissions) {
    permissions = filterDelegablePermissions(input.permissions)
  }

  const [created] = await db
    .insert(farmRoles)
    .values({
      farmId,
      name,
      isSystem: false,
      clonedFrom,
    })
    .returning()

  if (permissions.length) {
    await db.insert(farmRolePermissions).values(
      permissions.map((permissionKey) => ({ roleId: created.id, permissionKey })),
    )
  }

  return created
}

export async function assignUserFarmRole(
  farmId: string,
  userId: string,
  farmRoleId: string,
): Promise<{ ok: true; systemRole: UserRole } | { ok: false; error: string; status: 400 | 404 }> {
  await ensureFarmSystemRoles(farmId)
  const [role] = await db
    .select()
    .from(farmRoles)
    .where(and(eq(farmRoles.id, farmRoleId), eq(farmRoles.farmId, farmId)))
    .limit(1)
  if (!role) return { ok: false, error: 'Role not found', status: 404 }

  let systemRole: UserRole = 'field_worker'
  if (role.clonedFrom && SYSTEM_ROLE_KEYS.includes(role.clonedFrom as UserRole)) {
    systemRole = role.clonedFrom as UserRole
  } else if (role.isSystem && role.clonedFrom === 'owner') {
    return { ok: false, error: 'Cannot assign Admin role via this path', status: 400 }
  }

  if (systemRole === 'owner') {
    return { ok: false, error: 'Cannot assign Admin role via this path', status: 400 }
  }

  await db
    .update(users)
    .set({ farmRoleId: role.id, role: systemRole })
    .where(and(eq(users.id, userId), eq(users.farmId, farmId)))

  await revokeAllUserAccess(userId)
  return { ok: true, systemRole }
}
