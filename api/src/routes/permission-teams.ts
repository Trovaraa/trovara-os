import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../db/index.js'
import {
  permissionTeamMembers,
  permissionTeamPermissions,
  permissionTeams,
  userPermissionOverrides,
  users,
} from '../db/schema.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { hasPermission } from '../lib/rbac.js'
import { filterDelegablePermissions, isPermissionKey } from '../lib/permissions.js'
import { revokeAllUserAccess } from '../lib/access-revoke.js'
import { logAudit } from '../lib/audit.js'

const teamSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).nullable().optional(),
  permissions: z.array(z.string()).max(100).default([]),
  memberIds: z.array(z.string().uuid()).max(500).default([]),
})

const overrideSchema = z.object({
  overrides: z
    .array(
      z.object({
        permissionKey: z.string(),
        effect: z.enum(['allow', 'deny']),
      }),
    )
    .max(100),
})

export const permissionTeamRoutes = new Hono<{ Variables: AppVariables }>()
permissionTeamRoutes.use('*', authMiddleware)
permissionTeamRoutes.use('*', async (c, next) => {
  if (!hasPermission(c.get('user'), 'roles.manage')) return c.json({ error: 'Forbidden' }, 403)
  await next()
})

async function assertFarmUsers(farmId: string, ids: string[]) {
  const unique = [...new Set(ids)]
  if (!unique.length) return unique
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.farmId, farmId), inArray(users.id, unique)))
  if (rows.length !== unique.length) throw new Error('INVALID_MEMBER')
  return unique
}

async function listAccess(farmId: string) {
  const [teams, members, grants, staff, overrides] = await Promise.all([
    db.select().from(permissionTeams).where(eq(permissionTeams.farmId, farmId)),
    db
      .select({ teamId: permissionTeamMembers.teamId, userId: permissionTeamMembers.userId })
      .from(permissionTeamMembers)
      .innerJoin(permissionTeams, eq(permissionTeamMembers.teamId, permissionTeams.id))
      .where(eq(permissionTeams.farmId, farmId)),
    db
      .select({ teamId: permissionTeamPermissions.teamId, permissionKey: permissionTeamPermissions.permissionKey })
      .from(permissionTeamPermissions)
      .innerJoin(permissionTeams, eq(permissionTeamPermissions.teamId, permissionTeams.id))
      .where(eq(permissionTeams.farmId, farmId)),
    db
      .select({ id: users.id, name: users.name, email: users.email, role: users.role })
      .from(users)
      .where(and(eq(users.farmId, farmId), eq(users.active, true))),
    db.select().from(userPermissionOverrides).where(eq(userPermissionOverrides.farmId, farmId)),
  ])
  return {
    teams: teams.map((team) => ({
      ...team,
      memberIds: members.filter((m) => m.teamId === team.id).map((m) => m.userId),
      permissions: grants.filter((g) => g.teamId === team.id).map((g) => g.permissionKey),
    })),
    users: staff,
    overrides: overrides.map(({ userId, permissionKey, effect }) => ({ userId, permissionKey, effect })),
  }
}

permissionTeamRoutes.get('/', async (c) => c.json(await listAccess(c.get('user').farmId)))

permissionTeamRoutes.post('/', zValidator('json', teamSchema), async (c) => {
  const actor = c.get('user')
  const body = c.req.valid('json')
  const memberIds = await assertFarmUsers(actor.farmId, body.memberIds)
  const permissions = filterDelegablePermissions(body.permissions)
  const team = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(permissionTeams)
      .values({
        farmId: actor.farmId,
        name: body.name,
        description: body.description || null,
        createdById: actor.id,
      })
      .returning()
    if (permissions.length) {
      await tx.insert(permissionTeamPermissions).values(
        permissions.map((permissionKey) => ({ teamId: created.id, permissionKey })),
      )
    }
    if (memberIds.length) {
      await tx.insert(permissionTeamMembers).values(
        memberIds.map((userId) => ({ teamId: created.id, userId })),
      )
    }
    return created
  })
  for (const id of memberIds) await revokeAllUserAccess(id)
  await logAudit({ farmId: actor.farmId, userId: actor.id, action: 'permission_team_create', entityType: 'permission_team', entityId: team.id })
  return c.json(await listAccess(actor.farmId), 201)
})

permissionTeamRoutes.patch('/:id', zValidator('json', teamSchema), async (c) => {
  const actor = c.get('user')
  const id = c.req.param('id')
  const body = c.req.valid('json')
  const memberIds = await assertFarmUsers(actor.farmId, body.memberIds)
  const permissions = filterDelegablePermissions(body.permissions)
  const previous = await db
    .select({ userId: permissionTeamMembers.userId })
    .from(permissionTeamMembers)
    .innerJoin(permissionTeams, eq(permissionTeamMembers.teamId, permissionTeams.id))
    .where(and(eq(permissionTeams.farmId, actor.farmId), eq(permissionTeamMembers.teamId, id)))
  const updated = await db.transaction(async (tx) => {
    const [team] = await tx
      .update(permissionTeams)
      .set({ name: body.name, description: body.description || null, updatedAt: new Date() })
      .where(and(eq(permissionTeams.id, id), eq(permissionTeams.farmId, actor.farmId)))
      .returning()
    if (!team) return null
    await tx.delete(permissionTeamPermissions).where(eq(permissionTeamPermissions.teamId, id))
    await tx.delete(permissionTeamMembers).where(eq(permissionTeamMembers.teamId, id))
    if (permissions.length) await tx.insert(permissionTeamPermissions).values(permissions.map((permissionKey) => ({ teamId: id, permissionKey })))
    if (memberIds.length) await tx.insert(permissionTeamMembers).values(memberIds.map((userId) => ({ teamId: id, userId })))
    return team
  })
  if (!updated) return c.json({ error: 'Team not found' }, 404)
  for (const userId of new Set([...memberIds, ...previous.map((row) => row.userId)])) await revokeAllUserAccess(userId)
  await logAudit({ farmId: actor.farmId, userId: actor.id, action: 'permission_team_update', entityType: 'permission_team', entityId: id })
  return c.json(await listAccess(actor.farmId))
})

permissionTeamRoutes.delete('/:id', async (c) => {
  const actor = c.get('user')
  const id = c.req.param('id')
  const members = await db
    .select({ userId: permissionTeamMembers.userId })
    .from(permissionTeamMembers)
    .innerJoin(permissionTeams, eq(permissionTeamMembers.teamId, permissionTeams.id))
    .where(and(eq(permissionTeams.farmId, actor.farmId), eq(permissionTeamMembers.teamId, id)))
  const [deleted] = await db.delete(permissionTeams).where(and(eq(permissionTeams.id, id), eq(permissionTeams.farmId, actor.farmId))).returning({ id: permissionTeams.id })
  if (!deleted) return c.json({ error: 'Team not found' }, 404)
  for (const row of members) await revokeAllUserAccess(row.userId)
  return c.json({ ok: true })
})

permissionTeamRoutes.put('/users/:userId/overrides', zValidator('json', overrideSchema), async (c) => {
  const actor = c.get('user')
  const userId = c.req.param('userId')
  await assertFarmUsers(actor.farmId, [userId])
  const overrides = c.req.valid('json').overrides.filter((item) => isPermissionKey(item.permissionKey))
  if (overrides.some((item) => filterDelegablePermissions([item.permissionKey]).length === 0)) {
    return c.json({ error: 'A protected permission cannot be overridden' }, 400)
  }
  await db.transaction(async (tx) => {
    await tx.delete(userPermissionOverrides).where(and(eq(userPermissionOverrides.farmId, actor.farmId), eq(userPermissionOverrides.userId, userId)))
    if (overrides.length) await tx.insert(userPermissionOverrides).values(overrides.map((item) => ({ farmId: actor.farmId, userId, permissionKey: item.permissionKey, effect: item.effect, updatedById: actor.id })))
  })
  await revokeAllUserAccess(userId)
  await logAudit({ farmId: actor.farmId, userId: actor.id, action: 'user_permission_override', entityType: 'user', entityId: userId, metadata: { count: overrides.length } })
  return c.json(await listAccess(actor.farmId))
})
