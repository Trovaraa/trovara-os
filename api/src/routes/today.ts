import { Hono } from 'hono'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { gatherExceptions, gatherWorkerTodayTasks } from '../lib/exceptions.js'
import { getFarmWeather } from '../lib/weather.js'

export const todayRoutes = new Hono<{ Variables: AppVariables }>()

todayRoutes.use('*', authMiddleware)

todayRoutes.get('/', async (c) => {
  const user = c.get('user')
  const [{ exceptions, actionList, summary }, weather] = await Promise.all([
    gatherExceptions(user),
    getFarmWeather(user.farmId),
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

  // High-priority weather farm actions (irrigation, livestock, spraying, etc.).
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
  summary.weatherAlerts = weather.alerts.length
  summary.total = exceptions.length

  if (user.role === 'field_worker') {
    const myTasksToday = await gatherWorkerTodayTasks(user)
    return c.json({
      role: user.role,
      exceptions,
      actionList,
      summary,
      weather,
      myTasksToday: myTasksToday.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        dueDate: t.dueDate,
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
  })
})
