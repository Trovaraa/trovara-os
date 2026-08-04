import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { farmRoles } from '../db/schema.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { requirePermission } from '../lib/rbac.js'
import { PERMISSION_CATALOG, NON_DELEGABLE_PERMISSIONS } from '../lib/permissions.js'
import {
  createCustomFarmRole,
  listFarmRoles,
  setFarmRolePermissions,
} from '../lib/farm-roles.js'
import { logAudit } from '../lib/audit.js'
import { logSecurityEvent } from '../lib/security-log.js'
import { withAccessMeta } from '../lib/request-access-meta.js'

export const roleRoutes = new Hono<{ Variables: AppVariables }>()
roleRoutes.use('*', authMiddleware)

roleRoutes.get('/catalog', async (c) => {
  const user = c.get('user')
  try {
    requirePermission(user, 'roles.manage')
  } catch {
    return c.json({ error: 'Forbidden' }, 403)
  }
  return c.json({
    permissions: PERMISSION_CATALOG.map((p) => ({
      ...p,
      nonDelegable: NON_DELEGABLE_PERMISSIONS.has(p.key),
    })),
  })
})

roleRoutes.get('/', async (c) => {
  const user = c.get('user')
  try {
    requirePermission(user, 'roles.manage')
  } catch {
    return c.json({ error: 'Forbidden' }, 403)
  }
  const roles = await listFarmRoles(user.farmId)
  return c.json({ roles })
})

/** Roles that can be assigned to staff (excludes Admin / owner template). */
roleRoutes.get('/assignable', async (c) => {
  const user = c.get('user')
  try {
    requirePermission(user, 'users.manage')
  } catch {
    return c.json({ error: 'Forbidden' }, 403)
  }
  const roles = (await listFarmRoles(user.farmId)).filter((r) => r.clonedFrom !== 'owner')
  return c.json({
    roles: roles.map((r) => ({
      id: r.id,
      name: r.name,
      isSystem: r.isSystem,
      clonedFrom: r.clonedFrom,
    })),
  })
})

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  cloneFromRoleId: z.string().uuid().optional(),
  permissions: z.array(z.string()).optional(),
})

roleRoutes.post('/', zValidator('json', createSchema), async (c) => {
  const user = c.get('user')
  try {
    requirePermission(user, 'roles.manage')
  } catch {
    return c.json({ error: 'Forbidden' }, 403)
  }
  const body = c.req.valid('json')
  try {
    const created = await createCustomFarmRole(user.farmId, body)
    logSecurityEvent(
      'farm_role_created',
      withAccessMeta((name) => c.req.header(name), {
        actorUserId: user.id,
        roleId: created.id,
        name: created.name,
        farmId: user.farmId,
      }),
    )
    await logAudit({
      farmId: user.farmId,
      userId: user.id,
      action: 'create',
      entityType: 'farm_role',
      entityId: created.id,
      metadata: { name: created.name },
    })
    const roles = await listFarmRoles(user.farmId)
    return c.json({ role: roles.find((r) => r.id === created.id), roles }, 201)
  } catch (err) {
    if (err instanceof Error && err.message === 'CLONE_SOURCE_NOT_FOUND') {
      return c.json({ error: 'Clone source not found' }, 404)
    }
    if (err instanceof Error && String(err.message).includes('unique')) {
      return c.json({ error: 'A role with that name already exists' }, 400)
    }
    throw err
  }
})

const updatePermsSchema = z.object({
  permissions: z.array(z.string()),
})

roleRoutes.patch('/:id/permissions', zValidator('json', updatePermsSchema), async (c) => {
  const user = c.get('user')
  try {
    requirePermission(user, 'roles.manage')
  } catch {
    return c.json({ error: 'Forbidden' }, 403)
  }
  const roleId = c.req.param('id')
  const { permissions } = c.req.valid('json')
  const result = await setFarmRolePermissions(user.farmId, roleId, permissions)
  if (!result.ok) return c.json({ error: result.error }, result.status)

  logSecurityEvent(
    'farm_role_permissions_updated',
    withAccessMeta((name) => c.req.header(name), {
      actorUserId: user.id,
      roleId,
      farmId: user.farmId,
      permissionCount: permissions.length,
      revokedUsers: result.revokedUsers,
    }),
  )
  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'update',
    entityType: 'farm_role',
    entityId: roleId,
    metadata: { permissions, revokedUsers: result.revokedUsers },
  })

  const roles = await listFarmRoles(user.farmId)
  return c.json({ ok: true, revokedUsers: result.revokedUsers, roles })
})

roleRoutes.delete('/:id', async (c) => {
  const user = c.get('user')
  try {
    requirePermission(user, 'roles.manage')
  } catch {
    return c.json({ error: 'Forbidden' }, 403)
  }
  const roleId = c.req.param('id')
  const [role] = await db
    .select()
    .from(farmRoles)
    .where(and(eq(farmRoles.id, roleId), eq(farmRoles.farmId, user.farmId)))
    .limit(1)
  if (!role) return c.json({ error: 'Not found' }, 404)
  if (role.isSystem) return c.json({ error: 'System roles cannot be deleted' }, 400)

  await db.delete(farmRoles).where(eq(farmRoles.id, roleId))
  logSecurityEvent(
    'farm_role_deleted',
    withAccessMeta((name) => c.req.header(name), {
      actorUserId: user.id,
      roleId,
      name: role.name,
      farmId: user.farmId,
    }),
  )
  return c.json({ ok: true })
})
