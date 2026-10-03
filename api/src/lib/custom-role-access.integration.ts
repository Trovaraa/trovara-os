import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { farms, farmRoles, farmRolePermissions, users } from '../db/schema.js'
import { ensureFarmSystemRoles, resolvePermissionKeys } from './farm-roles.js'
import { staffLoginSecurityMeta } from './login-security-meta.js'
import { SYSTEM_ROLE_TEMPLATES } from './permissions.js'
import { createSession } from './session.js'
import { Hono } from 'hono'
import { eventRoutes } from '../routes/events.js'
import { SESSION_COOKIE } from './session.js'

// Runs only in the guarded, disposable finance_test database used by CI.
const farmId = randomUUID(), otherFarmId = randomUUID(), userId = randomUUID(), roleId = randomUUID(), foreignRoleId = randomUUID()
beforeAll(async () => {
  await db.insert(farms).values([
    { id: farmId, name: 'Synthetic role test', slug: farmId, location: 'Test' },
    { id: otherFarmId, name: 'Synthetic other farm', slug: otherFarmId, location: 'Test' },
  ])
  await db.insert(farmRoles).values([
    { id: roleId, farmId, name: 'Content Creator', isSystem: false, clonedFrom: 'supervisor' },
    { id: foreignRoleId, farmId: otherFarmId, name: 'Other farm private role', isSystem: false, clonedFrom: 'supervisor' },
  ])
  await db.insert(users).values({ id: userId, farmId, farmRoleId: roleId, name: 'Synthetic Creator', email: `${userId}@example.invalid`, passwordHash: 'not-a-password', role: 'supervisor' })
})

describe('custom roles against PostgreSQL and authenticated HTTP', () => {
  const identity = { id: userId, userId, farmId, farmRoleId: roleId, role: 'supervisor' as const, email: `${userId}@example.invalid` }
  it('does not seed supervisor permissions onto a custom clone, including an empty one', async () => {
    await ensureFarmSystemRoles(farmId)
    expect(await resolvePermissionKeys(identity)).toEqual([])
    const [system] = await db.select().from(farmRoles).where(and(eq(farmRoles.farmId, farmId), eq(farmRoles.isSystem, true), eq(farmRoles.clonedFrom, 'supervisor')))
    expect(await resolvePermissionKeys({ ...identity, farmRoleId: system.id })).toEqual(expect.arrayContaining(SYSTEM_ROLE_TEMPLATES.supervisor.permissions))
  })
  it('keeps explicit custom content grants without automatically granting new operational keys', async () => {
    await db.insert(farmRolePermissions).values([{ roleId, permissionKey: 'brand.manage' }, { roleId, permissionKey: 'ai.use' }])
    await ensureFarmSystemRoles(farmId)
    expect((await resolvePermissionKeys(identity)).sort()).toEqual(['ai.use', 'brand.manage'])
    await db.delete(farmRolePermissions).where(eq(farmRolePermissions.roleId, roleId))
  })
  it('never reads grants or names from a different farm', async () => {
    await db.insert(farmRolePermissions).values({ roleId: foreignRoleId, permissionKey: 'events.read' })
    expect(await resolvePermissionKeys({ ...identity, farmRoleId: foreignRoleId })).toEqual([])
    const meta = await staffLoginSecurityMeta(() => undefined, { ...identity, farmRoleId: foreignRoleId })
    expect(meta.role).not.toBe('Other farm private role')
  })
  it('keeps old role snapshots while subsequent logins capture renamed custom roles', async () => {
    const before = await staffLoginSecurityMeta(() => undefined, identity)
    await db.update(farmRoles).set({ name: 'Editor' }).where(eq(farmRoles.id, roleId))
    const after = await staffLoginSecurityMeta(() => undefined, identity)
    expect(before).toMatchObject({ role: 'Content Creator', systemRole: 'supervisor', farmRoleId: roleId })
    expect(after).toMatchObject({ role: 'Editor', systemRole: 'supervisor' })
  })
  it('enforces grants on the same live session, including revocation to an empty role', async () => {
    const token = await createSession(userId)
    const app = new Hono().route('/events', eventRoutes)
    const request = () => app.request('/events', { headers: { cookie: `${SESSION_COOKIE}=${token}` } })
    expect((await app.request('/events')).status).toBe(401)
    expect((await request()).status).toBe(403)
    await db.insert(farmRolePermissions).values({ roleId, permissionKey: 'events.read' })
    expect((await request()).status).toBe(200)
    await db.delete(farmRolePermissions).where(eq(farmRolePermissions.roleId, roleId))
    expect((await request()).status).toBe(403)
  })
})
