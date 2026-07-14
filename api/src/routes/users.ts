import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { users } from '../db/schema.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { requireRole } from '../lib/rbac.js'
import { hashPassword } from '../lib/session.js'
import { logAudit } from '../lib/audit.js'
import {
  generateLinkCode,
  isTelegramLinked,
  revokeTelegramLink,
} from '../lib/butler-link-codes.js'

const createUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(200),
  role: z.enum(['owner', 'supervisor', 'field_worker']),
  password: z.string().min(8).max(128),
  phone: z.string().max(30).optional(),
  dailyWageNgn: z.number().int().min(0).optional(),
})

const updateUserSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  role: z.enum(['supervisor', 'field_worker']).optional(),
  password: z.string().min(8).max(128).optional(),
  active: z.boolean().optional(),
  phone: z.string().max(30).optional(),
  dailyWageNgn: z.number().int().min(0).nullable().optional(),
})

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
  return c.json({ telegramLinked })
})

userRoutes.get('/', async (c) => {
  const user = c.get('user')
  try {
    requireRole(user, 'owner')
  } catch {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      phone: users.phone,
      dailyWageNgn: users.dailyWageNgn,
      active: users.active,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.farmId, user.farmId))
    .orderBy(users.name)

  return c.json({ users: rows })
})

userRoutes.post('/', zValidator('json', createUserSchema), async (c) => {
  const user = c.get('user')
  try {
    requireRole(user, 'owner')
  } catch {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const body = c.req.valid('json')
  const email = body.email.toLowerCase()

  const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1)
  if (existing) return c.json({ error: 'Email already in use' }, 400)

  const [created] = await db
    .insert(users)
    .values({
      farmId: user.farmId,
      email,
      name: body.name,
      role: body.role,
      passwordHash: await hashPassword(body.password),
      phone: body.phone,
      dailyWageNgn: body.dailyWageNgn,
      active: true,
    })
    .returning({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      phone: users.phone,
      dailyWageNgn: users.dailyWageNgn,
      active: users.active,
      createdAt: users.createdAt,
    })

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
    return c.json({ error: 'Cannot modify owner account' }, 400)
  }

  const updates: Partial<typeof existing> = {}
  if (body.name !== undefined) updates.name = body.name
  if (body.role !== undefined) updates.role = body.role
  if (body.active !== undefined) updates.active = body.active
  if (body.phone !== undefined) updates.phone = body.phone
  if (body.dailyWageNgn !== undefined) updates.dailyWageNgn = body.dailyWageNgn
  if (body.password !== undefined) updates.passwordHash = await hashPassword(body.password)

  const [updated] = await db
    .update(users)
    .set(updates)
    .where(eq(users.id, targetId))
    .returning({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      phone: users.phone,
      dailyWageNgn: users.dailyWageNgn,
      active: users.active,
      createdAt: users.createdAt,
    })

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'update',
    entityType: 'user',
    entityId: targetId,
    metadata: { fields: Object.keys(body) },
  })

  return c.json({ user: updated })
})
