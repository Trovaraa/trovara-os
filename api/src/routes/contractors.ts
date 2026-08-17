import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { contractorEngagements, contractors } from '../db/schema.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { requirePermission } from '../lib/rbac.js'
import { logAudit } from '../lib/audit.js'

const contractorSchema = z.object({
  name: z.string().trim().min(2).max(200),
  company: z.string().trim().max(200).nullable().optional(),
  specialty: z.string().trim().min(2).max(200),
  phone: z.string().trim().max(50).nullable().optional(),
  email: z.string().trim().email().max(254).nullable().optional(),
  status: z.enum(['active', 'inactive', 'blocked']).default('active'),
  insuranceExpiresAt: z.string().datetime().nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
})

const engagementSchema = z.object({
  contractorId: z.string().uuid(),
  title: z.string().trim().min(2).max(200),
  deliverables: z.string().trim().max(2000).nullable().optional(),
  startDate: z.string().date(),
  endDate: z.string().date().nullable().optional(),
  rateType: z.enum(['fixed', 'daily', 'hourly']).default('fixed'),
  agreedAmountMinor: z.number().int().min(0),
  paidAmountMinor: z.number().int().min(0).default(0),
  currency: z.string().trim().min(3).max(3).default('NGN'),
  costCentreCode: z.string().trim().max(20).nullable().optional(),
  status: z.enum(['planned', 'active', 'completed', 'cancelled']).default('planned'),
})

const engagementUpdateSchema = engagementSchema.pick({ paidAmountMinor: true, status: true }).partial()

export const contractorRoutes = new Hono<{ Variables: AppVariables }>()
contractorRoutes.use('*', authMiddleware)

contractorRoutes.get('/', async (c) => {
  const user = c.get('user')
  requirePermission(user, 'contractors.read')
  const [people, engagements] = await Promise.all([
    db.select().from(contractors).where(eq(contractors.farmId, user.farmId)).orderBy(contractors.name),
    db.select().from(contractorEngagements).where(eq(contractorEngagements.farmId, user.farmId)).orderBy(desc(contractorEngagements.startDate)),
  ])
  return c.json({ contractors: people.map((person) => ({ ...person, engagements: engagements.filter((row) => row.contractorId === person.id) })) })
})

contractorRoutes.post('/', zValidator('json', contractorSchema), async (c) => {
  const user = c.get('user')
  requirePermission(user, 'contractors.write')
  const body = c.req.valid('json')
  const [contractor] = await db.insert(contractors).values({
    farmId: user.farmId,
    ...body,
    company: body.company ?? null,
    phone: body.phone ?? null,
    email: body.email ?? null,
    insuranceExpiresAt: body.insuranceExpiresAt ? new Date(body.insuranceExpiresAt) : null,
    notes: body.notes ?? null,
    createdById: user.id,
  }).returning()
  await logAudit({ farmId: user.farmId, userId: user.id, action: 'create', entityType: 'contractor', entityId: contractor.id })
  return c.json({ contractor }, 201)
})

contractorRoutes.post('/engagements', zValidator('json', engagementSchema), async (c) => {
  const user = c.get('user')
  requirePermission(user, 'contractors.write')
  const body = c.req.valid('json')
  const [person] = await db.select({ id: contractors.id }).from(contractors)
    .where(and(eq(contractors.id, body.contractorId), eq(contractors.farmId, user.farmId))).limit(1)
  if (!person) return c.json({ error: 'Invalid contractor' }, 400)
  if (body.paidAmountMinor > body.agreedAmountMinor) {
    return c.json({ error: 'Paid amount cannot be more than the agreed amount' }, 400)
  }
  const [engagement] = await db.insert(contractorEngagements).values({
    farmId: user.farmId,
    ...body,
    deliverables: body.deliverables ?? null,
    endDate: body.endDate ?? null,
    costCentreCode: body.costCentreCode ?? null,
    approvedById: user.id,
    createdById: user.id,
  }).returning()
  await logAudit({ farmId: user.farmId, userId: user.id, action: 'create', entityType: 'contractor_engagement', entityId: engagement.id })
  return c.json({ engagement }, 201)
})

contractorRoutes.patch('/engagements/:id', zValidator('json', engagementUpdateSchema), async (c) => {
  const user = c.get('user')
  requirePermission(user, 'contractors.write')
  const [existing] = await db.select().from(contractorEngagements)
    .where(and(eq(contractorEngagements.id, c.req.param('id')), eq(contractorEngagements.farmId, user.farmId))).limit(1)
  if (!existing) return c.json({ error: 'Not found' }, 404)
  const body = c.req.valid('json')
  if (body.paidAmountMinor != null && body.paidAmountMinor > existing.agreedAmountMinor) {
    return c.json({ error: 'Paid amount cannot be more than the agreed amount' }, 400)
  }
  const [engagement] = await db.update(contractorEngagements).set({ ...body, updatedAt: new Date() })
    .where(eq(contractorEngagements.id, existing.id)).returning()
  await logAudit({ farmId: user.farmId, userId: user.id, action: 'update', entityType: 'contractor_engagement', entityId: existing.id })
  return c.json({ engagement })
})
