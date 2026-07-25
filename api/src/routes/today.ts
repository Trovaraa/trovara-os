import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { db } from '../db/index.js'
import { users } from '../db/schema.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { gatherExceptions, gatherWorkerTodayTasks } from '../lib/exceptions.js'
import { getFarmWeather, regenerateWeatherActions } from '../lib/weather.js'
import { listAdvisorySubjects, listRecommendationsForRole } from '../lib/advisory-engine.js'

export const todayRoutes = new Hono<{ Variables: AppVariables }>()

todayRoutes.use('*', authMiddleware)

async function preferredLocaleForUser(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ preferredLocale: users.preferredLocale })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  return row?.preferredLocale ?? null
}

todayRoutes.get('/', async (c) => {
  const user = c.get('user')
  const isSales = user.role === 'sales'
  const preferredLocale = await preferredLocaleForUser(user.id)

  const [{ exceptions, actionList, summary }, weather] = await Promise.all([
    gatherExceptions(user),
    getFarmWeather(user.farmId, { preferredLocale }),
  ])

  // Surface severe weather as Today exceptions (deduped already in weather service).
  let nextPriority = actionList.length + 1
  for (const alert of weather.alerts) {
    const type =
      alert.type === 'rain'
        ? 'weather_rain'
        : alert.type === 'heat'
          ? 'weather_heat'
          : alert.type === 'wind'
            ? 'weather_wind'
            : 'weather_cold'
    const entityId = `${user.farmId}:${alert.type}`
    exceptions.push({
      type,
      severity: alert.severity,
      title: alert.title,
      message: alert.message,
      entityType: 'weather',
      entityId,
      timestamp: weather.fetchedAt ?? new Date().toISOString(),
      metadata: { weatherType: alert.type },
    })
    actionList.push({
      priority: nextPriority++,
      action: 'review_weather',
      label: `Weather: ${alert.title}`,
      entityType: 'weather',
      entityId,
      link: '/today',
    })
  }

  // High-priority weather farm actions — skip for sales (field-ops tips).
  if (!isSales) {
    for (const weatherAction of weather.actions) {
      if (weatherAction.priority !== 'high') continue
      actionList.push({
        priority: nextPriority++,
        action: 'weather_farm_action',
        label: weatherAction.title,
        entityType: 'weather',
        entityId: `${user.farmId}:${weatherAction.id}`,
        link: '/today',
      })
    }
  }

  summary.weatherAlerts = weather.alerts.length
  summary.total = exceptions.length

  const advisoryTeaser =
    user.role === 'sales'
      ? null
      : await Promise.all([
          listAdvisorySubjects(user.farmId),
          listRecommendationsForRole(user.farmId, user.role, 3),
        ]).then(([subjects, recommendations]) => ({
          subject: subjects[0] ?? null,
          recommendation: recommendations[0] ?? null,
          openCount: recommendations.length,
        }))

  if (user.role === 'field_worker') {
    const myTasksToday = await gatherWorkerTodayTasks(user)
    return c.json({
      role: user.role,
      exceptions,
      actionList,
      summary,
      weather,
      advisory: advisoryTeaser,
      myTasksToday: myTasksToday.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        dueDate: t.dueDate,
        plotId: t.plotId,
        plotName: t.plotName,
      })),
    })
  }

  return c.json({
    role: user.role,
    exceptions,
    actionList,
    summary,
    weather,
    advisory: advisoryTeaser,
  })
})

todayRoutes.post('/weather-actions/regenerate', async (c) => {
  const user = c.get('user')
  const preferredLocale = await preferredLocaleForUser(user.id)
  const result = await regenerateWeatherActions(user.farmId, preferredLocale)
  if (!result) {
    return c.json({ error: 'Weather forecast not available yet' }, 404)
  }
  return c.json(result)
})
