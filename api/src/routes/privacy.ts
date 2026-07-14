import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { auditEvents, expenses, inventoryItems, orders, sessions, tasks, users } from '../db/schema.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { requireRole } from '../lib/rbac.js'
import { logAudit } from '../lib/audit.js'
import { runDataRetention } from '../lib/data-retention.js'
import { assertTenantScope, sanitizeAnonymizedEmail, sanitizeAnonymizedName } from '../lib/tenant-scope.js'
import { secureCompare } from '../lib/secure-compare.js'
import type { SessionUser } from '../lib/session.js'

const retentionSchema = z.object({
  farmId: z.string().uuid().optional(),
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

privacyRoutes.get('/privacy/export', async (c) => {
  const user = c.get('user')
  try {
    requireRole(user, 'owner')
  } catch {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const [userRows, taskRows, inventoryRows, orderRows, expenseRows, auditSample] = await Promise.all([
    db
      .select({
        id: users.id,
        farmId: users.farmId,
        email: users.email,
        name: users.name,
        role: users.role,
        phone: users.phone,
        dailyWageNgn: users.dailyWageNgn,
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
  })

  return c.json({
    exportedAt: new Date().toISOString(),
    farmId: user.farmId,
    users: userRows,
    tasks: taskRows,
    inventory: inventoryRows,
    orders: orderRows,
    expenses: expenseRows,
    auditSample,
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

  if (target.role !== 'field_worker') {
    return c.json({ error: 'Only worker profiles can be anonymized' }, 400)
  }

  const anonymizedEmail = sanitizeAnonymizedEmail(target.id)
  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({
        name: sanitizeAnonymizedName(),
        email: anonymizedEmail,
        phone: null,
        active: false,
        totpSecret: null,
        totpEnabled: false,
      })
      .where(eq(users.id, target.id))

    await tx.delete(sessions).where(eq(sessions.userId, target.id))
  })

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'privacy_anonymize_user',
    entityType: 'user',
    entityId: target.id,
  })

  return c.json({ ok: true, userId: target.id, anonymizedEmail })
})

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
      metadata: { targetFarmId: farmId ?? null, purgedTaskEvidence: result.purgedTaskEvidence },
    })
  }

  return c.json({ ok: true, ...result })
})
