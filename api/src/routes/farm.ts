import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { farms } from '../db/schema.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { requireRole } from '../lib/rbac.js'
import { logAudit } from '../lib/audit.js'

function coordSchema(min: number, max: number, label: string) {
  return z
    .union([z.string(), z.number(), z.null()])
    .optional()
    .superRefine((v, ctx) => {
      if (v === undefined || v === null || v === '') return
      const n = typeof v === 'number' ? v : Number(String(v).trim())
      if (!Number.isFinite(n) || n < min || n > max) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label} must be between ${min} and ${max}`,
        })
      }
    })
    .transform((v) => {
      if (v === undefined) return undefined
      if (v === null || v === '') return null
      return String(typeof v === 'number' ? v : Number(String(v).trim()))
    })
}

const updateFarmSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  location: z.string().trim().min(1).max(200).optional(),
  latitude: coordSchema(-90, 90, 'latitude'),
  longitude: coordSchema(-180, 180, 'longitude'),
  timezone: z.string().trim().min(1).max(80).optional(),
})

export const farmRoutes = new Hono<{ Variables: AppVariables }>()

farmRoutes.use('*', authMiddleware)

farmRoutes.get('/', async (c) => {
  const user = c.get('user')
  const [farm] = await db
    .select({
      id: farms.id,
      name: farms.name,
      slug: farms.slug,
      location: farms.location,
      latitude: farms.latitude,
      longitude: farms.longitude,
      timezone: farms.timezone,
      liveMode: farms.liveMode,
    })
    .from(farms)
    .where(eq(farms.id, user.farmId))
    .limit(1)

  if (!farm) return c.json({ error: 'Farm not found' }, 404)
  return c.json({ farm })
})

farmRoutes.patch('/', zValidator('json', updateFarmSchema), async (c) => {
  const user = c.get('user')
  try {
    requireRole(user, 'owner')
  } catch {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const body = c.req.valid('json')
  const updates: Partial<typeof farms.$inferInsert> = {}
  if (body.name !== undefined) updates.name = body.name
  if (body.location !== undefined) updates.location = body.location
  if (body.latitude !== undefined) updates.latitude = body.latitude
  if (body.longitude !== undefined) updates.longitude = body.longitude
  if (body.timezone !== undefined) updates.timezone = body.timezone

  if (!Object.keys(updates).length) {
    return c.json({ error: 'No fields to update' }, 400)
  }

  const [farm] = await db
    .update(farms)
    .set(updates)
    .where(eq(farms.id, user.farmId))
    .returning({
      id: farms.id,
      name: farms.name,
      slug: farms.slug,
      location: farms.location,
      latitude: farms.latitude,
      longitude: farms.longitude,
      timezone: farms.timezone,
      liveMode: farms.liveMode,
    })

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'update',
    entityType: 'farm',
    entityId: user.farmId,
    metadata: { fields: Object.keys(updates) },
  })

  return c.json({ farm })
})
