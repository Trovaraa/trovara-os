import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, desc, eq, ne } from 'drizzle-orm'
import { db } from '../db/index.js'
import {
  auditEvents,
  customerContacts,
  expenses,
  inventoryItems,
  orders,
  tasks,
  users,
} from '../db/schema.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { requireRole } from '../lib/rbac.js'
import { logAudit } from '../lib/audit.js'
import { getRetentionPreview, runDataRetention } from '../lib/data-retention.js'
import {
  assertTenantScope,
  sanitizeAnonymizedContactName,
  sanitizeAnonymizedEmail,
} from '../lib/tenant-scope.js'
import { removeStaffUser } from '../lib/user-remove.js'
import { secureCompare } from '../lib/secure-compare.js'
import type { SessionUser } from '../lib/session.js'

const retentionSchema = z.object({
  farmId: z.string().uuid().optional(),
})

const exportReasonSchema = z.object({
  reason: z.string().max(500).optional(),
})

const anonymizeContactSchema = z.object({
  reason: z.string().max(500).optional(),
})

function hasValidCronSecret(c: any): boolean {
  const configured = process.env.CRON_SECRET?.trim()
  const provided = c.req.header('x-cron-secret')?.trim()
  return Boolean(configured && provided && secureCompare(provided, configured))
}

async function loadActorForRetention(c: any): Promise<{ user: SessionUser | null; cron: boolean }> {
  if (hasValidCronSecret(c)) return { user: null, cron: true }
  await authMiddleware(c, async () => undefined)
  const user = c.get('user') as SessionUser
  requireRole(user, 'owner')
  return { user, cron: false }
}

export const privacyRoutes = new Hono<{ Variables: AppVariables }>()

privacyRoutes.use('/privacy/*', authMiddleware)

privacyRoutes.get('/privacy/export', zValidator('query', exportReasonSchema), async (c) => {
  const user = c.get('user')
  try {
    requireRole(user, 'owner')
  } catch {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const { reason } = c.req.valid('query')

  const [userRows, taskRows, inventoryRows, orderRows, expenseRows, auditSample] = await Promise.all([
    db
      .select({
        id: users.id,
        farmId: users.farmId,
        email: users.email,
        name: users.name,
        role: users.role,
        phone: users.phone,
        monthlyWageNgn: users.monthlyWageNgn,
        monthlyWageEffectiveFrom: users.monthlyWageEffectiveFrom,
        monthlyWageConfirmedAt: users.monthlyWageConfirmedAt,
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
      })
      .from(users)
      .where(eq(users.farmId, user.farmId)),
    db.select().from(tasks).where(eq(tasks.farmId, user.farmId)),
    db.select().from(inventoryItems).where(eq(inventoryItems.farmId, user.farmId)),
    db.select().from(orders).where(eq(orders.farmId, user.farmId)),
    db.select().from(expenses).where(eq(expenses.farmId, user.farmId)),
    db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.farmId, user.farmId))
      .orderBy(desc(auditEvents.createdAt))
      .limit(200),
  ])

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'privacy_export',
    entityType: 'privacy',
    metadata: reason ? { reason } : undefined,
  })

  return c.json({
    exportedAt: new Date().toISOString(),
    farmId: user.farmId,
    exportReason: reason ?? null,
    users: userRows,
    tasks: taskRows,
    inventory: inventoryRows,
    orders: orderRows,
    expenses: expenseRows,
    auditSample,
  })
})

privacyRoutes.get('/privacy/retention-status', async (c) => {
  const user = c.get('user')
  try {
    requireRole(user, 'owner')
  } catch {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const preview = await getRetentionPreview(user.farmId)
  return c.json({ ok: true, farmId: user.farmId, ...preview })
})

privacyRoutes.get('/privacy/anonymize-targets', async (c) => {
  const user = c.get('user')
  try {
    requireRole(user, 'owner')
  } catch {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const [workerRows, contactRows] = await Promise.all([
    db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        role: users.role,
        active: users.active,
      })
      .from(users)
      .where(and(eq(users.farmId, user.farmId), ne(users.role, 'owner'))),
    db
      .select({
        id: customerContacts.id,
        name: customerContacts.name,
        phone: customerContacts.phone,
        channel: customerContacts.channel,
      })
      .from(customerContacts)
      .where(eq(customerContacts.farmId, user.farmId)),
  ])

  return c.json({
    workers: workerRows.filter((row) => !row.email.endsWith('.invalid')),
    contacts: contactRows.filter((row) => row.name || row.phone),
  })
})

privacyRoutes.post('/privacy/anonymize-user/:id', async (c) => {
  const user = c.get('user')
  try {
    requireRole(user, 'owner')
  } catch {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const targetId = c.req.param('id')
  const [target] = await db
    .select()
    .from(users)
    .where(and(eq(users.id, targetId), eq(users.farmId, user.farmId)))
    .limit(1)

  if (!target) return c.json({ error: 'Not found' }, 404)
  assertTenantScope(user.farmId, target.farmId)

  if (target.role === 'owner') {
    return c.json({ error: 'Cannot anonymize Admin account' }, 400)
  }

  await removeStaffUser(target.id)

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'privacy_anonymize_user',
    entityType: 'user',
    entityId: target.id,
  })

  return c.json({ ok: true, userId: target.id, anonymizedEmail: sanitizeAnonymizedEmail(target.id) })
})

privacyRoutes.post(
  '/privacy/anonymize-contact/:id',
  zValidator('json', anonymizeContactSchema),
  async (c) => {
    const user = c.get('user')
    try {
      requireRole(user, 'owner')
    } catch {
      return c.json({ error: 'Forbidden' }, 403)
    }

    const contactId = c.req.param('id')
    const body = c.req.valid('json')
    const [contact] = await db
      .select()
      .from(customerContacts)
      .where(and(eq(customerContacts.id, contactId), eq(customerContacts.farmId, user.farmId)))
      .limit(1)

    if (!contact) return c.json({ error: 'Not found' }, 404)

    const anonymizedName = sanitizeAnonymizedContactName(contact.id)

    await db.transaction(async (tx) => {
      await tx
        .update(customerContacts)
        .set({
          name: anonymizedName,
          phone: null,
          updatedAt: new Date(),
        })
        .where(eq(customerContacts.id, contact.id))

      await tx
        .update(orders)
        .set({
          customerName: anonymizedName,
          customerPhone: null,
          updatedAt: new Date(),
        })
        .where(and(eq(orders.farmId, user.farmId), eq(orders.customerContactId, contact.id)))
    })

    await logAudit({
      farmId: user.farmId,
      userId: user.id,
      action: 'privacy_anonymize_contact',
      entityType: 'customer_contact',
      entityId: contact.id,
      metadata: body.reason ? { reason: body.reason } : undefined,
    })

    return c.json({ ok: true, contactId: contact.id, anonymizedName })
  },
)

privacyRoutes.post('/system/run-retention', zValidator('json', retentionSchema), async (c) => {
  const body = c.req.valid('json')
  let actor: { user: SessionUser | null; cron: boolean }
  try {
    actor = await loadActorForRetention(c)
  } catch {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  if (actor.cron && !body.farmId) {
    return c.json({ error: 'farmId required for cron retention' }, 400)
  }

  const farmId = actor.cron ? body.farmId : (body.farmId ?? actor.user?.farmId)
  if (!actor.cron && actor.user && farmId !== actor.user.farmId) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const result = await runDataRetention(farmId)

  if (actor.user) {
    await logAudit({
      farmId: actor.user.farmId,
      userId: actor.user.id,
      action: 'run_data_retention',
      entityType: 'privacy',
      metadata: {
        targetFarmId: farmId ?? null,
        purgedTaskEvidence: result.purgedTaskEvidence,
        purgedExpiredSessions: result.purgedExpiredSessions,
        redactedChatMessages: result.redactedChatMessages,
        nulledContactPhones: result.nulledContactPhones,
        purgedLoginRateLimits: result.purgedLoginRateLimits,
      },
    })
  }

  return c.json({ ok: true, ...result })
})
