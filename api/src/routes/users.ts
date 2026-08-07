import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { users } from '../db/schema.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { hasPermission, requirePermission } from '../lib/rbac.js'
import { hashPassword } from '../lib/session.js'
import { isBreakGlassEmail, verifyArmedBreakGlassPassword } from '../lib/registration.js'
import { logAudit } from '../lib/audit.js'
import { logSecurityEvent } from '../lib/security-log.js'
import { withAccessMeta } from '../lib/request-access-meta.js'
import {
  generateLinkCode,
  isTelegramLinked,
  revokeTelegramLink,
} from '../lib/butler-link-codes.js'
import { revokeAllUserAccess } from '../lib/access-revoke.js'
import { isAnonymizedUserEmail, removeStaffUser } from '../lib/user-remove.js'
import {
  assignUserFarmRole,
  ensureFarmSystemRoles,
} from '../lib/farm-roles.js'
import { farmRoles } from '../db/schema.js'

const employmentTypeEnum = z.enum(['permanent', 'temporary', 'casual', 'contract'])
const employmentStatusEnum = z.enum(['employed', 'leave', 'ended'])

/** HTML forms often send "" for cleared optional fields; treat as null. */
function emptyToNullPreprocess(value: unknown): unknown {
  return value === '' ? null : value
}

const optionalDate = z.preprocess(
  emptyToNullPreprocess,
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
    .optional()
    .nullable(),
)

const optionalEmploymentType = z.preprocess(
  emptyToNullPreprocess,
  employmentTypeEnum.optional().nullable(),
)

const optionalEmploymentStatus = z.preprocess(
  emptyToNullPreprocess,
  employmentStatusEnum.optional().nullable(),
)

const optionalWage = z.preprocess((value) => {
  if (value === '' || value === undefined) return null
  if (typeof value === 'number' && Number.isNaN(value)) return null
  return value
}, z.number().int().min(0).optional().nullable())

const staffProfileFields = {
  phone: z.string().max(30).optional().nullable(),
  monthlyWageNgn: optionalWage,
  monthlyWageEffectiveFrom: optionalDate,
  confirmMonthlyWage: z.boolean().optional(),
  nextOfKinName: z.string().max(200).optional().nullable(),
  nextOfKinPhone: z.string().max(30).optional().nullable(),
  nextOfKinRelationship: z.string().max(100).optional().nullable(),
  employeeNumber: z.string().max(50).optional().nullable(),
  jobTitle: z.string().max(200).optional().nullable(),
  employmentType: optionalEmploymentType,
  employmentStartDate: optionalDate,
  employmentEndDate: optionalDate,
  employmentStatus: optionalEmploymentStatus,
}

const createUserSchema = z
  .object({
    email: z.string().email(),
    name: z.string().min(1).max(200),
    role: z.enum(['supervisor', 'field_worker', 'sales']).optional(),
    farmRoleId: z.string().uuid().optional(),
    password: z.string().min(8).max(128),
    ...staffProfileFields,
  })
  .refine((value) => Boolean(value.role || value.farmRoleId), {
    message: 'role or farmRoleId is required',
  })

const updateUserSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  role: z.enum(['supervisor', 'field_worker', 'sales']).optional(),
  farmRoleId: z.string().uuid().optional(),
  password: z.string().min(8).max(128).optional(),
  active: z.boolean().optional(),
  ...staffProfileFields,
})

const userSelect = {
  id: users.id,
  email: users.email,
  name: users.name,
  role: users.role,
  farmRoleId: users.farmRoleId,
  phone: users.phone,
  monthlyWageNgn: users.monthlyWageNgn,
  monthlyWageEffectiveFrom: users.monthlyWageEffectiveFrom,
  monthlyWageConfirmedAt: users.monthlyWageConfirmedAt,
  monthlyWageConfirmedById: users.monthlyWageConfirmedById,
  nextOfKinName: users.nextOfKinName,
  nextOfKinPhone: users.nextOfKinPhone,
  nextOfKinRelationship: users.nextOfKinRelationship,
  employeeNumber: users.employeeNumber,
  jobTitle: users.jobTitle,
  employmentType: users.employmentType,
  employmentStartDate: users.employmentStartDate,
  employmentEndDate: users.employmentEndDate,
  employmentStatus: users.employmentStatus,
  active: users.active,
  createdAt: users.createdAt,
}

function emptyToNull(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

export const userRoutes = new Hono<{ Variables: AppVariables }>()

userRoutes.use('*', authMiddleware)

userRoutes.post('/me/butler-link-code', async (c) => {
  const user = c.get('user')
  const { code, expiresAt } = await generateLinkCode(user.id, user.farmId)
  return c.json({
    code,
    expiresAt: expiresAt.toISOString(),
  })
})

userRoutes.delete('/me/telegram-link', async (c) => {
  const user = c.get('user')
  await revokeTelegramLink(user.id)
  return c.json({ ok: true })
})

userRoutes.get('/me/channel-links', async (c) => {
  const user = c.get('user')
  const telegramLinked = await isTelegramLinked(user.id)
  const [row] = await db
    .select({ phone: users.phone })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1)
  return c.json({ telegramLinked, phone: row?.phone ?? null })
})

const updateMeSchema = z.object({
  phone: z.string().max(30).optional().nullable(),
})

userRoutes.patch('/me', zValidator('json', updateMeSchema), async (c) => {
  const user = c.get('user')
  const body = c.req.valid('json')
  if (body.phone === undefined) {
    return c.json({ error: 'No fields to update' }, 400)
  }
  const phone = emptyToNull(body.phone)
  const [updated] = await db
    .update(users)
    .set({ phone })
    .where(eq(users.id, user.id))
    .returning({ id: users.id, phone: users.phone })
  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'update',
    entityType: 'user',
    entityId: user.id,
    metadata: { self: true, phone: Boolean(phone) },
  })
  return c.json({ user: updated })
})

userRoutes.get('/', async (c) => {
  const user = c.get('user')
  if (!hasPermission(user, 'users.view') && !hasPermission(user, 'users.manage')) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const rows = await db
    .select({
      ...userSelect,
      farmRoleName: farmRoles.name,
    })
    .from(users)
    .leftJoin(farmRoles, eq(users.farmRoleId, farmRoles.id))
    .where(eq(users.farmId, user.farmId))
    .orderBy(users.name)

  // Soft-removed (anonymized) staff stay in DB for FKs but leave the admin roster.
  const visible = rows.filter((row) => !isAnonymizedUserEmail(row.email))

  // Without users.manage, return a redacted roster (task assignment helpers).
  if (!hasPermission(user, 'users.manage')) {
    return c.json({
      users: visible.map((row) => ({
        id: row.id,
        name: row.name,
        email: row.email,
        role: row.role,
        farmRoleId: row.farmRoleId,
        farmRoleName: row.farmRoleName,
        active: row.active,
        phone: row.phone,
      })),
    })
  }

  return c.json({ users: visible })
})

userRoutes.post(
  '/',
  async (c, next) => {
    try {
      requirePermission(c.get('user'), 'users.manage')
    } catch {
      return c.json({ error: 'Forbidden' }, 403)
    }
    await next()
  },
  zValidator('json', createUserSchema),
  async (c) => {
  const user = c.get('user')

  const body = c.req.valid('json')
  const email = body.email.toLowerCase()

  const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1)
  if (existing) return c.json({ error: 'Email already in use' }, 400)

  const employeeNumber = emptyToNull(body.employeeNumber)
  if (employeeNumber) {
    const [dup] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.farmId, user.farmId), eq(users.employeeNumber, employeeNumber)))
      .limit(1)
    if (dup) return c.json({ error: 'Employee number already in use' }, 400)
  }

  const confirmWage = body.confirmMonthlyWage === true && body.monthlyWageNgn != null

  await ensureFarmSystemRoles(user.farmId)

  let role = body.role
  let farmRoleId = body.farmRoleId
  if (farmRoleId) {
    const [chosen] = await db
      .select()
      .from(farmRoles)
      .where(and(eq(farmRoles.id, farmRoleId), eq(farmRoles.farmId, user.farmId)))
      .limit(1)
    if (!chosen || chosen.clonedFrom === 'owner') {
      return c.json({ error: 'Invalid farm role' }, 400)
    }
    if (chosen.clonedFrom === 'supervisor' || chosen.clonedFrom === 'sales' || chosen.clonedFrom === 'field_worker') {
      role = chosen.clonedFrom
    } else {
      role = role ?? 'field_worker'
    }
  } else if (role) {
    const [systemRole] = await db
      .select({ id: farmRoles.id })
      .from(farmRoles)
      .where(
        and(
          eq(farmRoles.farmId, user.farmId),
          eq(farmRoles.isSystem, true),
          eq(farmRoles.clonedFrom, role),
        ),
      )
      .limit(1)
    farmRoleId = systemRole?.id
  }

  if (!role) return c.json({ error: 'role or farmRoleId is required' }, 400)

  const [created] = await db
    .insert(users)
    .values({
      farmId: user.farmId,
      email,
      name: body.name,
      role,
      farmRoleId,
      passwordHash: await hashPassword(body.password),
      phone: emptyToNull(body.phone) ?? undefined,
      monthlyWageNgn: body.monthlyWageNgn ?? undefined,
      monthlyWageEffectiveFrom: emptyToNull(body.monthlyWageEffectiveFrom) ?? undefined,
      monthlyWageConfirmedAt: confirmWage ? new Date() : undefined,
      monthlyWageConfirmedById: confirmWage ? user.id : undefined,
      nextOfKinName: emptyToNull(body.nextOfKinName) ?? undefined,
      nextOfKinPhone: emptyToNull(body.nextOfKinPhone) ?? undefined,
      nextOfKinRelationship: emptyToNull(body.nextOfKinRelationship) ?? undefined,
      employeeNumber: employeeNumber ?? undefined,
      jobTitle: emptyToNull(body.jobTitle) ?? undefined,
      employmentType: body.employmentType ?? undefined,
      employmentStartDate: emptyToNull(body.employmentStartDate) ?? undefined,
      employmentEndDate: emptyToNull(body.employmentEndDate) ?? undefined,
      employmentStatus: body.employmentStatus ?? 'employed',
      active: true,
      mustChangePassword: true,
    })
    .returning(userSelect)

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'create',
    entityType: 'user',
    entityId: created.id,
    metadata: { role: created.role },
  })
  logSecurityEvent(
    'staff_user_created',
    withAccessMeta((name) => c.req.header(name), {
      actorUserId: user.id,
      actorEmail: user.email,
      targetUserId: created.id,
      targetEmail: created.email,
      role: created.role,
      farmId: user.farmId,
    }),
  )

  return c.json({ user: created }, 201)
})

userRoutes.patch('/:id', zValidator('json', updateUserSchema), async (c) => {
  const user = c.get('user')
  try {
    requirePermission(user, 'users.manage')
  } catch {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const targetId = c.req.param('id')
  const body = c.req.valid('json')

  const [existing] = await db
    .select()
    .from(users)
    .where(and(eq(users.id, targetId), eq(users.farmId, user.farmId)))
    .limit(1)

  if (!existing) return c.json({ error: 'Not found' }, 404)
  if (existing.role === 'owner' && targetId !== user.id && (body.active === false || body.role)) {
    return c.json({ error: 'Cannot modify Admin account' }, 400)
  }

  if (body.employeeNumber !== undefined) {
    const employeeNumber = emptyToNull(body.employeeNumber)
    if (employeeNumber) {
      const [dup] = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.farmId, user.farmId), eq(users.employeeNumber, employeeNumber)))
        .limit(1)
      if (dup && dup.id !== targetId) {
        return c.json({ error: 'Employee number already in use' }, 400)
      }
    }
  }

  const updates: Partial<typeof existing> = {}
  if (body.name !== undefined) updates.name = body.name
  if (body.role !== undefined) updates.role = body.role
  if (body.active !== undefined) updates.active = body.active
  if (body.phone !== undefined) updates.phone = emptyToNull(body.phone)
  if (body.nextOfKinName !== undefined) updates.nextOfKinName = emptyToNull(body.nextOfKinName)
  if (body.nextOfKinPhone !== undefined) updates.nextOfKinPhone = emptyToNull(body.nextOfKinPhone)
  if (body.nextOfKinRelationship !== undefined) {
    updates.nextOfKinRelationship = emptyToNull(body.nextOfKinRelationship)
  }
  if (body.employeeNumber !== undefined) updates.employeeNumber = emptyToNull(body.employeeNumber)
  if (body.jobTitle !== undefined) updates.jobTitle = emptyToNull(body.jobTitle)
  if (body.employmentType !== undefined) updates.employmentType = body.employmentType
  if (body.employmentStartDate !== undefined) {
    updates.employmentStartDate = emptyToNull(body.employmentStartDate)
  }
  if (body.employmentEndDate !== undefined) {
    updates.employmentEndDate = emptyToNull(body.employmentEndDate)
  }
  if (body.employmentStatus !== undefined) updates.employmentStatus = body.employmentStatus
  if (body.monthlyWageEffectiveFrom !== undefined) {
    updates.monthlyWageEffectiveFrom = emptyToNull(body.monthlyWageEffectiveFrom)
  }

  if (body.monthlyWageNgn !== undefined) {
    updates.monthlyWageNgn = body.monthlyWageNgn
    if (body.monthlyWageNgn !== existing.monthlyWageNgn) {
      updates.monthlyWageConfirmedAt = null
      updates.monthlyWageConfirmedById = null
    }
  }

  if (body.confirmMonthlyWage === true) {
    const wage = body.monthlyWageNgn !== undefined ? body.monthlyWageNgn : existing.monthlyWageNgn
    if (wage == null) {
      return c.json({ error: 'Set a monthly wage before confirming it' }, 400)
    }
    updates.monthlyWageConfirmedAt = new Date()
    updates.monthlyWageConfirmedById = user.id
  } else if (body.confirmMonthlyWage === false) {
    updates.monthlyWageConfirmedAt = null
    updates.monthlyWageConfirmedById = null
  }

  if (body.password !== undefined) {
    if (isBreakGlassEmail(existing.email)) {
      return c.json(
        {
          error:
            'Break-glass password is managed via BREAK_GLASS_PASSWORD in the server .env. Env login also requires BREAK_GLASS_ENABLED=true (arm for recovery, then disarm and restart).',
        },
        400,
      )
    }
    updates.passwordHash = await hashPassword(body.password)
    updates.mustChangePassword = true
  }

  let roleChanged = false
  let farmRoleAlreadyRevoked = false
  if (body.farmRoleId !== undefined && body.farmRoleId !== existing.farmRoleId) {
    const assigned = await assignUserFarmRole(user.farmId, targetId, body.farmRoleId)
    if (!assigned.ok) return c.json({ error: assigned.error }, assigned.status)
    delete updates.role
    delete updates.farmRoleId
    roleChanged = true
    farmRoleAlreadyRevoked = true
  } else if (body.role !== undefined && body.role !== existing.role) {
    await ensureFarmSystemRoles(user.farmId)
    const [systemRole] = await db
      .select({ id: farmRoles.id })
      .from(farmRoles)
      .where(
        and(
          eq(farmRoles.farmId, user.farmId),
          eq(farmRoles.isSystem, true),
          eq(farmRoles.clonedFrom, body.role),
        ),
      )
      .limit(1)
    if (systemRole) updates.farmRoleId = systemRole.id
    roleChanged = true
  }

  const updated =
    Object.keys(updates).length > 0
      ? (
          await db
            .update(users)
            .set(updates)
            .where(eq(users.id, targetId))
            .returning(userSelect)
        )[0]
      : (
          await db
            .select(userSelect)
            .from(users)
            .where(eq(users.id, targetId))
            .limit(1)
        )[0]

  if (!updated) return c.json({ error: 'Not found' }, 404)

  if (
    body.password !== undefined ||
    body.active === false ||
    (roleChanged && !farmRoleAlreadyRevoked)
  ) {
    await revokeAllUserAccess(targetId)
  }

  const accessMeta = (extra: Record<string, unknown>) =>
    withAccessMeta((name) => c.req.header(name), {
      actorUserId: user.id,
      actorEmail: user.email,
      targetUserId: targetId,
      targetEmail: existing.email,
      farmId: user.farmId,
      ...extra,
    })

  if (roleChanged) {
    logSecurityEvent(
      'staff_role_changed',
      accessMeta({
        fromRole: existing.role,
        toRole: updated.role,
        fromFarmRoleId: existing.farmRoleId,
        toFarmRoleId: updated.farmRoleId,
      }),
    )
  }
  if (body.active === false && existing.active) {
    logSecurityEvent('staff_user_deactivated', accessMeta({}))
  } else if (body.active === true && !existing.active) {
    logSecurityEvent('staff_user_activated', accessMeta({}))
  }
  if (body.password !== undefined) {
    logSecurityEvent('staff_password_reset', accessMeta({ mustChangePassword: true }))
  }

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'update',
    entityType: 'user',
    entityId: targetId,
    metadata: {
      fields: Object.keys(body),
      accessRevoked: body.password !== undefined || body.active === false,
    },
  })

  return c.json({ user: updated })
})

userRoutes.delete('/:id', async (c) => {
  const user = c.get('user')
  try {
    requirePermission(user, 'users.manage')
  } catch {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const targetId = c.req.param('id')
  if (targetId === user.id) {
    return c.json({ error: 'Cannot delete your own account' }, 400)
  }

  const [existing] = await db
    .select()
    .from(users)
    .where(and(eq(users.id, targetId), eq(users.farmId, user.farmId)))
    .limit(1)

  if (!existing) return c.json({ error: 'Not found' }, 404)
  if (existing.role === 'owner') {
    return c.json({ error: 'Cannot delete Admin account' }, 400)
  }
  if (isBreakGlassEmail(existing.email)) {
    return c.json({ error: 'Cannot delete the break-glass Admin account' }, 400)
  }
  if (isAnonymizedUserEmail(existing.email)) {
    return c.json({ error: 'User already removed' }, 400)
  }

  await removeStaffUser(targetId)

  logSecurityEvent(
    'staff_user_removed',
    withAccessMeta((name) => c.req.header(name), {
      actorUserId: user.id,
      actorEmail: user.email,
      targetUserId: targetId,
      targetEmail: existing.email,
      previousRole: existing.role,
      farmId: user.farmId,
    }),
  )
  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'delete',
    entityType: 'user',
    entityId: targetId,
    metadata: {
      previousEmail: existing.email,
      previousName: existing.name,
      previousRole: existing.role,
    },
  })

  return c.json({ ok: true })
})

const breakGlassAdminSchema = z.object({
  password: z.string().min(8).max(128),
  reason: z.string().trim().min(3).max(500),
})

async function countViableDailyOwners(farmId: string): Promise<number> {
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      active: users.active,
      role: users.role,
    })
    .from(users)
    .where(and(eq(users.farmId, farmId), eq(users.role, 'owner'), eq(users.active, true)))
  return rows.filter(
    (r) => !isBreakGlassEmail(r.email) && !isAnonymizedUserEmail(r.email),
  ).length
}

userRoutes.post(
  '/:id/break-glass-deactivate',
  zValidator('json', breakGlassAdminSchema),
  async (c) => {
    const user = c.get('user')
    try {
      requirePermission(user, 'breakglass.cleanup')
    } catch {
      return c.json({ error: 'Forbidden' }, 403)
    }
    if (!isBreakGlassEmail(user.email)) {
      return c.json({ error: 'Only the break-glass account may use this action' }, 403)
    }

    const body = c.req.valid('json')
    if (!verifyArmedBreakGlassPassword(body.password)) {
      return c.json({ error: 'Armed break-glass password required' }, 403)
    }

    const targetId = c.req.param('id')
    if (targetId === user.id) {
      return c.json({ error: 'Cannot deactivate the break-glass account itself' }, 400)
    }

    const [existing] = await db
      .select()
      .from(users)
      .where(and(eq(users.id, targetId), eq(users.farmId, user.farmId)))
      .limit(1)
    if (!existing) return c.json({ error: 'Not found' }, 404)
    if (isBreakGlassEmail(existing.email)) {
      return c.json({ error: 'Cannot deactivate the break-glass account' }, 400)
    }
    if (existing.role !== 'owner') {
      return c.json(
        { error: 'This endpoint is for Admin accounts only; use normal deactivate for staff' },
        400,
      )
    }
    if (!existing.active) {
      return c.json({ error: 'Account is already inactive' }, 400)
    }

    const viableBefore = await countViableDailyOwners(user.farmId)
    if (viableBefore <= 1) {
      return c.json(
        {
          error:
            'Cannot deactivate the last viable daily Admin. Activate or register another Admin first.',
        },
        400,
      )
    }

    await db.update(users).set({ active: false }).where(eq(users.id, targetId))
    await revokeAllUserAccess(targetId)

    const viableAfter = await countViableDailyOwners(user.farmId)
    if (viableAfter < 1) {
      await db.update(users).set({ active: true }).where(eq(users.id, targetId))
      return c.json(
        { error: 'Cleanup aborted to avoid leaving the farm without a daily Admin' },
        400,
      )
    }

    logSecurityEvent(
      'break_glass_admin_deactivated',
      withAccessMeta((name) => c.req.header(name), {
        actorUserId: user.id,
        targetUserId: targetId,
        targetEmail: existing.email,
        reason: body.reason,
        viableOwnersBefore: viableBefore,
        viableOwnersAfter: viableAfter,
        farmId: user.farmId,
      }),
    )
    await logAudit({
      farmId: user.farmId,
      userId: user.id,
      action: 'break_glass_admin_deactivated',
      entityType: 'user',
      entityId: targetId,
      metadata: { reason: body.reason, previousEmail: existing.email },
    })

    return c.json({ ok: true, viableOwnersAfter: viableAfter })
  },
)

userRoutes.post(
  '/:id/break-glass-reactivate',
  zValidator('json', breakGlassAdminSchema),
  async (c) => {
    const user = c.get('user')
    try {
      requirePermission(user, 'breakglass.cleanup')
    } catch {
      return c.json({ error: 'Forbidden' }, 403)
    }
    if (!isBreakGlassEmail(user.email)) {
      return c.json({ error: 'Only the break-glass account may use this action' }, 403)
    }
    const body = c.req.valid('json')
    if (!verifyArmedBreakGlassPassword(body.password)) {
      return c.json({ error: 'Armed break-glass password required' }, 403)
    }

    const targetId = c.req.param('id')
    const [existing] = await db
      .select()
      .from(users)
      .where(and(eq(users.id, targetId), eq(users.farmId, user.farmId)))
      .limit(1)
    if (!existing) return c.json({ error: 'Not found' }, 404)
    if (existing.role !== 'owner' || isBreakGlassEmail(existing.email)) {
      return c.json({ error: 'Invalid target for admin reactivation' }, 400)
    }
    if (existing.active) return c.json({ error: 'Account is already active' }, 400)

    await db.update(users).set({ active: true }).where(eq(users.id, targetId))

    logSecurityEvent(
      'break_glass_admin_reactivated',
      withAccessMeta((name) => c.req.header(name), {
        actorUserId: user.id,
        targetUserId: targetId,
        targetEmail: existing.email,
        reason: body.reason,
        farmId: user.farmId,
      }),
    )
    await logAudit({
      farmId: user.farmId,
      userId: user.id,
      action: 'break_glass_admin_reactivated',
      entityType: 'user',
      entityId: targetId,
      metadata: { reason: body.reason },
    })

    return c.json({ ok: true })
  },
)
