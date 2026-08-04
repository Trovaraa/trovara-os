import { Hono } from 'hono'
import { count, eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { farms, taskTemplates, users, zones } from '../db/schema.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { requirePermission } from '../lib/rbac.js'
import { resetDemoData } from '../lib/seed-data.js'
import { logAudit } from '../lib/audit.js'

export const onboardingRoutes = new Hono<{ Variables: AppVariables }>()

onboardingRoutes.use('*', authMiddleware)

onboardingRoutes.get('/status', async (c) => {
  const user = c.get('user')

  const [[zoneRow], [templateRow], [userRow], [farm]] = await Promise.all([
    db.select({ total: count() }).from(zones).where(eq(zones.farmId, user.farmId)),
    db.select({ total: count() }).from(taskTemplates).where(eq(taskTemplates.farmId, user.farmId)),
    db.select({ total: count() }).from(users).where(eq(users.farmId, user.farmId)),
    db
      .select({
        liveMode: farms.liveMode,
        liveStartedAt: farms.liveStartedAt,
      })
      .from(farms)
      .where(eq(farms.id, user.farmId))
      .limit(1),
  ])

  const zonesCount = Number(zoneRow?.total ?? 0)
  const templatesCount = Number(templateRow?.total ?? 0)
  const usersCount = Number(userRow?.total ?? 0)

  return c.json({
    checklist: {
      hasZones: zonesCount > 0,
      hasTemplates: templatesCount > 0,
      hasUsers: usersCount > 0,
      zonesCount,
      templatesCount,
      usersCount,
    },
    ready: zonesCount > 0 && templatesCount > 0 && usersCount > 0,
    liveMode: farm?.liveMode ?? false,
    liveStartedAt: farm?.liveStartedAt ?? null,
  })
})

onboardingRoutes.post('/go-live', async (c) => {
  const user = c.get('user')
  try {
    requirePermission(user, 'farm.manage')
  } catch {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const [farm] = await db
    .update(farms)
    .set({
      liveMode: true,
      liveStartedAt: new Date(),
    })
    .where(eq(farms.id, user.farmId))
    .returning({
      id: farms.id,
      liveMode: farms.liveMode,
      liveStartedAt: farms.liveStartedAt,
    })

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'go_live',
    entityType: 'farm',
    entityId: user.farmId,
  })

  return c.json({ farm })
})

onboardingRoutes.post('/reset-demo', async (c) => {
  const user = c.get('user')
  try {
    requirePermission(user, 'farm.manage')
  } catch {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const [farm] = await db
    .select({
      liveMode: farms.liveMode,
    })
    .from(farms)
    .where(eq(farms.id, user.farmId))
    .limit(1)

  const allowLiveModeReset = process.env.LIVE_MODE_OVERRIDE === 'true'
  if (farm?.liveMode && !allowLiveModeReset) {
    return c.json({ error: 'reset-demo disabled after go-live' }, 403)
  }

  try {
    await resetDemoData(user.farmId)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Seed failed'
    console.error('reset-demo seed failed:', err)
    return c.json({ error: message }, 500)
  }

  // Seed wipes all sessions and farm/user rows - client must sign in again.
  return c.json({
    ok: true,
    requiresReLogin: true,
    message:
      'Demo data reset. Sign in again with owner@trovara.farm (password from BREAK_GLASS_PASSWORD in .env).',
  })
})
