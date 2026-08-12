import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { farms, users } from '../db/schema.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { requireRole } from '../lib/rbac.js'
import {
  checkProactiveAlerts,
  renderProactiveAlertPush,
  type ProactiveAlert,
} from '../lib/proactive-alerts.js'
import { runAdvisoryEngine } from '../lib/advisory-engine.js'
import { gatherExceptions } from '../lib/exceptions.js'
import { renderEveningDigest } from '../lib/digest-messages.js'
import { resolveStaffReplyLocale } from '../lib/reply-locale.js'
import {
  notifyOwner,
  notifyOwnerTelegram,
  notifyRolesTelegram,
  notifySupervisors,
  notifySupervisorsTelegram,
  type NotifyLocaleContext,
} from '../lib/farm-notify.js'
import {
  collectHealthSnapshotReport,
  healthSlaEnvEnabled,
  renderHealthSnapshotTelegram,
} from '../lib/health-sla.js'
import { secureCompare } from '../lib/secure-compare.js'
import type { SessionUser } from '../lib/session.js'
import { deliverCriticalAlert } from '../lib/notifications.js'

const cronSchema = z.object({
  farmId: z.string().uuid().optional(),
})

type ClaimedAlertRun = { period_key: string }

function alertRunKey(c: any): string {
  const supplied = c.req.header('idempotency-key')?.trim()
  return supplied && supplied.length <= 128 ? supplied : new Date().toISOString().slice(0, 10)
}

/**
 * A completed period is immutable. Failed runs and processing leases abandoned
 * for 15 minutes may be reclaimed.
 */
async function claimAlertRun(c: any, farmId: string, runType: string): Promise<boolean> {
  const periodKey = alertRunKey(c)
  const rows = await db.execute<ClaimedAlertRun>(sql`
    INSERT INTO alert_runs (farm_id, job_type, period_key, status, started_at)
    VALUES (${farmId}, ${runType}, ${periodKey}, 'processing', now())
    ON CONFLICT (farm_id, job_type, period_key) DO UPDATE SET
      status = 'processing',
      last_error = null,
      started_at = now(),
      completed_at = null
    WHERE alert_runs.status = 'failed'
       OR (alert_runs.status = 'processing' AND alert_runs.started_at < now() - interval '15 minutes')
    RETURNING period_key
  `)
  return rows.length === 1
}

async function completeAlertRun(c: any, farmId: string, runType: string): Promise<void> {
  const periodKey = alertRunKey(c)
  await db.execute(sql`
    UPDATE alert_runs
    SET status = 'completed', completed_at = now(), last_error = null
    WHERE farm_id = ${farmId} AND job_type = ${runType} AND period_key = ${periodKey}
  `)
}

function duplicateRunResponse(c: any, farmId: string) {
  return c.json({ ok: true, farmId, duplicate: true, notified: {} })
}

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

/**
 * A farm's human-readable name, never its id. `farms.id` and `farms.name` are
 * both plain strings, which is how a UUID ended up inside copy that reads
 * "alerts for X" on all three proactive pushes. Only `resolveFarmName` mints
 * this type, so a helper that asks for it cannot be handed a farm id.
 */
type FarmDisplayName = string & { readonly __brand: 'FarmDisplayName' }

/** Stand-in when the farm row cannot be read: an unnamed alert beats silence. */
const FALLBACK_FARM_NAME = 'Trovara' as FarmDisplayName

/**
 * Farm name for an owner-facing push. Alerts are the reason someone opens the
 * app at 6am, so a farms lookup that fails degrades to the fallback name rather
 * than throwing the whole run away.
 */
async function resolveFarmName(farmId: string): Promise<FarmDisplayName> {
  try {
    const [farm] = await db
      .select({ name: farms.name })
      .from(farms)
      .where(eq(farms.id, farmId))
      .limit(1)
    return (farm?.name as FarmDisplayName | undefined) ?? FALLBACK_FARM_NAME
  } catch (err) {
    console.error('Farm name lookup failed:', err instanceof Error ? err.message : err)
    return FALLBACK_FARM_NAME
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

/**
 * Email subject and SMS first line for a critical alert. Takes a
 * `FarmDisplayName` so the id this used to interpolate no longer compiles.
 */
function criticalAlertSubject(farmName: FarmDisplayName): string {
  return `Critical Trovara alert (${farmName})`
}

/**
 * Critical-alert body for one owner, in that owner's language.
 *
 * The notify helpers fall back to English on their own when a renderer
 * misbehaves; email and SMS have no such net, so the fallback is spelled out
 * here. It reuses the canonical English already stored on the alert rows rather
 * than calling back into the render module, so the last resort cannot fail for
 * the same reason the first attempt did.
 */
function renderCriticalAlert(
  preferredLocale: string,
  farmName: FarmDisplayName,
  alerts: ProactiveAlert[],
): string {
  try {
    return renderProactiveAlertPush(resolveStaffReplyLocale(preferredLocale), farmName, alerts)
  } catch (err) {
    console.error('Critical alert render failed:', err instanceof Error ? err.message : err)
    const lines = alerts.map((alert) => `- ${alert.title}: ${alert.message}`)
    return [`⚠️ Proactive alerts for ${farmName}:`, ...lines].join('\n')
  }
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
  if (!(await claimAlertRun(c, auth.user.farmId, 'proactive'))) {
    return duplicateRunResponse(c, auth.user.farmId)
  }

  const alerts = await checkProactiveAlerts(auth.user.farmId)
  const advisory = await runAdvisoryEngine(auth.user.farmId)
  const farmName = await resolveFarmName(auth.user.farmId)
  const renderPush = ({ locale }: NotifyLocaleContext) =>
    renderProactiveAlertPush(locale, farmName, alerts)
  const reason = auth.usedCronSecret ? 'cron_proactive' : 'manual_proactive'
  const tg = await notifyOwnerTelegram(auth.user.farmId, renderPush, {
    actorUserId: auth.user.id,
    reason,
  })
  const wa = await notifyOwner(auth.user.farmId, renderPush, {
    actorUserId: auth.user.id,
    reason,
  })

  const criticalAlerts = alerts.filter((alert) => alert.severity === 'high')
  let criticalDelivery = { email: 0, sms: 0 }
  if (criticalAlerts.length > 0) {
    const recipients = await db
      .select({
        email: users.email,
        phone: users.phone,
        preferredLocale: users.preferredLocale,
      })
      .from(users)
      .where(
        and(
          eq(users.farmId, auth.user.farmId),
          eq(users.role, 'owner'),
          eq(users.active, true),
        ),
      )
    // deliverCriticalAlert takes one subject and body per call, so owners go out
    // one at a time - that is what lets a francophone and an anglophone owner
    // each read the same alert in their own language. Rendering is a locale
    // table, not a network call, so there is nothing to batch per language.
    const subject = criticalAlertSubject(farmName)
    const deliveries = (
      await Promise.all(
        recipients.map((recipient) =>
          deliverCriticalAlert(
            [recipient],
            subject,
            renderCriticalAlert(recipient.preferredLocale, farmName, criticalAlerts),
          ),
        ),
      )
    ).flat()
    criticalDelivery = {
      email: deliveries.filter(
        (delivery) => delivery.channel === 'email' && delivery.status === 'delivered',
      ).length,
      sms: deliveries.filter(
        (delivery) => delivery.channel === 'sms' && delivery.status === 'delivered',
      ).length,
    }
  }

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

  await completeAlertRun(c, auth.user.farmId, 'proactive')
  return c.json({
    ok: true,
    farmId: auth.user.farmId,
    alertsCount: alerts.length,
    alerts,
    advisoryCreated: advisory.created,
    notified: {
      owner: {
        telegram: tg.notified,
        whatsapp: wa.notified,
        email: criticalDelivery.email,
        sms: criticalDelivery.sms,
      },
      supervisors: supervisorNotified,
    },
  })
})

alertsRoutes.post('/evening-digest', zValidator('json', cronSchema), async (c) => {
  const body = c.req.valid('json')
  const auth = await resolveAlertActor(c, body.farmId)
  if (!auth) return c.json({ error: 'Unauthorized' }, 401)
  if (!(await claimAlertRun(c, auth.user.farmId, 'evening_digest'))) {
    return duplicateRunResponse(c, auth.user.farmId)
  }

  const [{ summary }, farmName] = await Promise.all([
    gatherExceptions(auth.user),
    resolveFarmName(auth.user.farmId),
  ])
  // Same per-recipient shape as the proactive push: each owner gets the digest
  // in their preferred_locale, and resolveFarmName's fallback keeps a failed
  // farms lookup from silencing the whole run.
  const renderDigest = ({ locale }: NotifyLocaleContext) =>
    renderEveningDigest(locale, farmName, summary)

  const tg = await notifyOwnerTelegram(auth.user.farmId, renderDigest, {
    actorUserId: auth.user.id,
    reason: auth.usedCronSecret ? 'cron_evening_digest' : 'manual_evening_digest',
  })
  const wa = await notifyOwner(auth.user.farmId, renderDigest, {
    actorUserId: auth.user.id,
    reason: auth.usedCronSecret ? 'cron_evening_digest' : 'manual_evening_digest',
  })

  await completeAlertRun(c, auth.user.farmId, 'evening_digest')
  return c.json({
    ok: true,
    farmId: auth.user.farmId,
    summary,
    notified: { telegram: tg.notified, whatsapp: wa.notified },
  })
})

/** Point-in-time OS + marketing uptime/health snapshot. */
async function runHealthSnapshot(c: any) {
  const body = c.req.valid('json')
  const auth = await resolveAlertActor(c, body.farmId)
  if (!auth) return c.json({ error: 'Unauthorized' }, 401)

  if (!healthSlaEnvEnabled()) {
    return c.json({
      ok: true,
      farmId: auth.user.farmId,
      skipped: true,
      reason: 'env_disabled',
      notified: { telegram: 0 },
    })
  }

  const [farm] = await db
    .select({
      healthSlaAlertsEnabled: farms.healthSlaAlertsEnabled,
    })
    .from(farms)
    .where(eq(farms.id, auth.user.farmId))
    .limit(1)

  if (farm && !farm.healthSlaAlertsEnabled) {
    return c.json({
      ok: true,
      farmId: auth.user.farmId,
      skipped: true,
      reason: 'farm_disabled',
      notified: { telegram: 0 },
    })
  }

  if (!(await claimAlertRun(c, auth.user.farmId, 'health_snapshot'))) {
    return duplicateRunResponse(c, auth.user.farmId)
  }

  const report = await collectHealthSnapshotReport()
  const message = renderHealthSnapshotTelegram(report)
  const tg = await notifyRolesTelegram(auth.user.farmId, ['owner', 'supervisor'], message, {
    actorUserId: auth.user.id,
    reason: auth.usedCronSecret ? 'cron_health_snapshot' : 'manual_health_snapshot',
    kind: 'health_snapshot',
  })

  await completeAlertRun(c, auth.user.farmId, 'health_snapshot')
  return c.json({
    ok: true,
    farmId: auth.user.farmId,
    report,
    notified: { telegram: tg.notified },
  })
}

alertsRoutes.post('/run-health-snapshot', zValidator('json', cronSchema), runHealthSnapshot)
/** @deprecated Retained for existing schedulers and API clients. */
alertsRoutes.post('/run-health-sla', zValidator('json', cronSchema), runHealthSnapshot)
