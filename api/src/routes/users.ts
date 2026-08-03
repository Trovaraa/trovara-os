import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { users } from '../db/schema.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { requireRole } from '../lib/rbac.js'
import { hashPassword } from '../lib/session.js'
import { isBreakGlassEmail } from '../lib/registration.js'
import { logAudit } from '../lib/audit.js'
import {
  generateLinkCode,
  isTelegramLinked,
  revokeTelegramLink,
} from '../lib/butler-link-codes.js'
import { revokeAllUserAccess } from '../lib/access-revoke.js'
import { isAnonymizedUserEmail, removeStaffUser } from '../lib/user-remove.js'

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

const createUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(200),
  role: z.enum(['supervisor', 'field_worker', 'sales']),
  password: z.string().min(8).max(128),
  ...staffProfileFields,
})

const updateUserSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  role: z.enum(['supervisor', 'field_worker', 'sales']).optional(),
  password: z.string().min(8).max(128).optional(),
  active: z.boolean().optional(),
  ...staffProfileFields,
})

const userSelect = {
  id: users.id,
  email: users.email,
  name: users.name,
  role: users.role,
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
  try {
    requireRole(user, 'owner', 'supervisor')
  } catch {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const rows = await db
    .select(userSelect)
    .from(users)
    .where(eq(users.farmId, user.farmId))
    .orderBy(users.name)

  // Soft-removed (anonymized) staff stay in DB for FKs but leave the admin roster.
  const visible = rows.filter((row) => !isAnonymizedUserEmail(row.email))

  // Supervisors can assign tasks but should not see full employment/wage profile.
  if (user.role === 'supervisor') {
    return c.json({
      users: visible.map((row) => ({
        id: row.id,
        name: row.name,
        email: row.email,
        role: row.role,
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
      requireRole(c.get('user'), 'owner')
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

  const [created] = await db
    .insert(users)
    .values({
      farmId: user.farmId,
      email,
      name: body.name,
      role: body.role,
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

  return c.json({ user: created }, 201)
})

userRoutes.patch('/:id', zValidator('json', updateUserSchema), async (c) => {
  const user = c.get('user')
  try {
    requireRole(user, 'owner')
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

  const [updated] = await db
    .update(users)
    .set(updates)
    .where(eq(users.id, targetId))
    .returning(userSelect)

  if (body.password !== undefined || body.active === false) {
    await revokeAllUserAccess(targetId)
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
    requireRole(user, 'owner')
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
