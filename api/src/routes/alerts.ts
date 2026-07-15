import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { users } from '../db/schema.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { requireRole } from '../lib/rbac.js'
import { checkProactiveAlerts } from '../lib/proactive-alerts.js'
import { gatherExceptions } from '../lib/exceptions.js'
import {
  notifyOwner,
  notifyOwnerTelegram,
  notifySupervisors,
  notifySupervisorsTelegram,
} from '../lib/farm-notify.js'
import { secureCompare } from '../lib/secure-compare.js'
import type { SessionUser } from '../lib/session.js'

const cronSchema = z.object({
  farmId: z.string().uuid().optional(),
})

type AuthResult = { user: SessionUser; usedCronSecret: boolean } | null

async function getOwnerUserByFarmId(farmId: string): Promise<SessionUser | null> {
  const [owner] = await db
    .select()
    .from(users)
    .where(and(eq(users.farmId, farmId), eq(users.role, 'owner')))
    .limit(1)
  if (!owner) return null
  return {
    id: owner.id,
    farmId: owner.farmId,
    email: owner.email,
    name: owner.name,
    role: owner.role,
    mustChangePassword: owner.mustChangePassword,
  }
}

async function resolveAlertActor(
  c: any,
  payloadFarmId?: string,
): Promise<AuthResult> {
  const cronSecret = process.env.CRON_SECRET?.trim()
  const provided = c.req.header('x-cron-secret')?.trim()

  if (cronSecret && provided && secureCompare(provided, cronSecret)) {
    if (!payloadFarmId) return null
    const owner = await getOwnerUserByFarmId(payloadFarmId)
    if (!owner) return null
    return { user: owner, usedCronSecret: true }
  }

  const user = c.get('user') as SessionUser
  requireRole(user, 'owner', 'supervisor')
  return { user, usedCronSecret: false }
}

function formatProactiveAlertMessage(farmName: string, alerts: Awaited<ReturnType<typeof checkProactiveAlerts>>) {
  if (alerts.length === 0) {
    return `✅ Proactive check (${farmName}): no urgent issues detected.`
  }
  const lines = alerts.map((a) => `- ${a.title}: ${a.message}`)
  return [`⚠️ Proactive alerts for ${farmName}:`, ...lines].join('\n')
}

export const alertsRoutes = new Hono<{ Variables: AppVariables }>()

alertsRoutes.use('*', async (c, next) => {
  const cronSecret = process.env.CRON_SECRET?.trim()
  const provided = c.req.header('x-cron-secret')?.trim()
  if (cronSecret && provided && secureCompare(provided, cronSecret)) {
    await next()
    return
  }
  return authMiddleware(c, next)
})

alertsRoutes.post('/run-proactive', zValidator('json', cronSchema), async (c) => {
  const body = c.req.valid('json')
  const auth = await resolveAlertActor(c, body.farmId)
  if (!auth) return c.json({ error: 'Unauthorized' }, 401)

  const alerts = await checkProactiveAlerts(auth.user.farmId)
  const msg = formatProactiveAlertMessage(auth.user.farmId, alerts)
  const reason = auth.usedCronSecret ? 'cron_proactive' : 'manual_proactive'
  const tg = await notifyOwnerTelegram(auth.user.farmId, msg, {
    actorUserId: auth.user.id,
    reason,
  })
  const wa = await notifyOwner(auth.user.farmId, msg, {
    actorUserId: auth.user.id,
    reason,
  })

  // Field-ops reminders (equipment not logged / awaiting verification) are the
  // supervisor's job - send those lines straight to supervisors as well.
  const assetAlerts = alerts.filter(
    (a) => a.type === 'asset_log_missing' || a.type === 'asset_verification_pending',
  )
  let supervisorNotified = { telegram: 0, whatsapp: 0 }
  if (assetAlerts.length > 0) {
    const supMsg = ['🧰 Equipment reminder:', ...assetAlerts.map((a) => `- ${a.title}: ${a.message}`)].join(
      '\n',
    )
    const supTg = await notifySupervisorsTelegram(auth.user.farmId, supMsg, {
      actorUserId: auth.user.id,
      reason: `${reason}_assets`,
    })
    const supWa = await notifySupervisors(auth.user.farmId, supMsg, {
      actorUserId: auth.user.id,
      reason: `${reason}_assets`,
    })
    supervisorNotified = { telegram: supTg.notified, whatsapp: supWa.notified }
  }

  return c.json({
    ok: true,
    farmId: auth.user.farmId,
    alertsCount: alerts.length,
    alerts,
    notified: {
      owner: { telegram: tg.notified, whatsapp: wa.notified },
      supervisors: supervisorNotified,
    },
  })
})

alertsRoutes.post('/evening-digest', zValidator('json', cronSchema), async (c) => {
  const body = c.req.valid('json')
  const auth = await resolveAlertActor(c, body.farmId)
  if (!auth) return c.json({ error: 'Unauthorized' }, 401)

  const { summary } = await gatherExceptions(auth.user)
  const digestLines = [
    '🌙 Trovara evening digest',
    `Farm ID: ${auth.user.farmId}`,
    `- Overdue tasks: ${summary.overdueTasks}`,
    `- Low stock: ${summary.lowStock}`,
    `- Pending approvals: ${summary.pendingApprovals}`,
    `- Mortality today: ${summary.mortalityToday}`,
    `- Orders pending: ${summary.ordersPending}`,
    `- Rejected tasks: ${summary.rejectedTasks}`,
    `- Equipment not logged today: ${summary.assetLogsMissing}`,
    `- Asset logs to verify: ${summary.assetVerificationPending}`,
  ]
  const message = digestLines.join('\n')

  const tg = await notifyOwnerTelegram(auth.user.farmId, message, {
    actorUserId: auth.user.id,
    reason: auth.usedCronSecret ? 'cron_evening_digest' : 'manual_evening_digest',
  })
  const wa = await notifyOwner(auth.user.farmId, message, {
    actorUserId: auth.user.id,
    reason: auth.usedCronSecret ? 'cron_evening_digest' : 'manual_evening_digest',
  })

  return c.json({
    ok: true,
    farmId: auth.user.farmId,
    summary,
    notified: { telegram: tg.notified, whatsapp: wa.notified },
  })
})
