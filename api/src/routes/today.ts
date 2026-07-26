import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { db } from '../db/index.js'
import { users } from '../db/schema.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { gatherExceptions, gatherWorkerTodayTasks } from '../lib/exceptions.js'
import { renderException } from '../lib/exception-messages.js'
import { getFarmWeather, regenerateWeatherActions } from '../lib/weather.js'
import { listAdvisorySubjects, listRecommendationsForRole } from '../lib/advisory-engine.js'
import { toViewerLocaleMany } from '../lib/content-locale.js'
import { resolveStaffReplyLocale } from '../lib/reply-locale.js'
import type { SessionUser } from '../lib/session.js'

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

/**
 * Advisory prose is stored in canonical English and rendered on read.
 *
 * Nothing else on this endpoint is translated here: exception and action strings
 * carry i18n keys the client resolves (see docs/API.md), and weather actions
 * arrive from the weather layer already in the viewer's language. Weather alert
 * wording is owned by `weather-alerts.ts` and passes through untouched.
 *
 * `subject.label` names a crop, plot or batch, and `payload.products` are
 * product names and prices, so both stay as stored.
 */
async function advisoryTeaserFor(user: SessionUser, preferredLocale: string | null) {
  const [subjects, recommendations] = await Promise.all([
    listAdvisorySubjects(user.farmId),
    listRecommendationsForRole(user.farmId, user.role, 3),
  ])
  const subject = subjects[0] ?? null
  const recommendation = recommendations[0] ?? null
  const teaser = { subject, recommendation, openCount: recommendations.length }

  const locale = resolveStaffReplyLocale(preferredLocale)
  if (locale === 'en') return teaser

  const english: string[] = []
  const stage = (text: string) => {
    english.push(text)
    return english.length - 1
  }
  const prose = payloadProse(recommendation?.payload)
  const slots = {
    happeningNow: prose ? stage(prose.happeningNow) : null,
    whatNext: prose ? stage(prose.whatNext) : null,
    aiSummary: recommendation?.aiSummary ? stage(recommendation.aiSummary) : null,
    nextHint: subject?.nextHint ? stage(subject.nextHint) : null,
  }
  if (english.length === 0) return teaser

  // One batched call for the whole teaser; English survives a failed translation.
  const rendered = await toViewerLocaleMany({
    texts: english,
    targetLocale: locale,
    farmId: user.farmId,
  }).catch(() => english)
  const read = (slot: number) => rendered[slot] || english[slot]

  return {
    ...teaser,
    subject:
      subject && slots.nextHint != null ? { ...subject, nextHint: read(slots.nextHint) } : subject,
    recommendation: recommendation && {
      ...recommendation,
      payload:
        slots.happeningNow != null && slots.whatNext != null
          ? {
              ...(recommendation.payload as Record<string, unknown>),
              happeningNow: read(slots.happeningNow),
              whatNext: read(slots.whatNext),
            }
          : recommendation.payload,
      aiSummary: slots.aiSummary == null ? recommendation.aiSummary : read(slots.aiSummary),
    },
  }
}

/** `payload` is jsonb, and rows from older engine versions may lack prose. */
function payloadProse(payload: unknown): { happeningNow: string; whatNext: string } | null {
  if (!payload || typeof payload !== 'object') return null
  const { happeningNow, whatNext } = payload as Record<string, unknown>
  if (typeof happeningNow !== 'string' || typeof whatNext !== 'string') return null
  return { happeningNow, whatNext }
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
    // The weather layer owns the wording of an alert, so the title is passed
    // through as a plain param with no title key; only the "Weather:" prefix is
    // keyed for the client.
    const labelParams = { title: alert.title }
    actionList.push({
      priority: nextPriority++,
      action: 'review_weather',
      label: renderException('exceptions.action.weather', 'en', labelParams),
      labelKey: 'exceptions.action.weather',
      labelParams,
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
    user.role === 'sales' ? null : await advisoryTeaserFor(user, preferredLocale)

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
