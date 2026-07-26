import {
  buildWeatherAlerts,
  type WeatherAlert,
  type WeatherAlertType,
  type WeatherDay,
} from './weather-alerts.js'

export type WeatherActionPriority = 'high' | 'medium' | 'low'

export type WeatherAction = {
  id: string
  priority: WeatherActionPriority
  title: string
  detail: string
  relatedAlert?: WeatherAlertType
}

type ActionSeed = {
  id: string
  title: string
  detail: string
}

/** Theme-keyed suggestions for tropical West African farms (plantain, oil palm, coconut, poultry). */
const THEME_BY_ALERT: Record<WeatherAlertType, ActionSeed[]> = {
  rain: [
    {
      id: 'rain-delay-irrigation',
      title: 'Delay irrigation',
      detail:
        'Skip or cut back watering while rain is expected — plantain, oil palm, and coconut beds rarely need extra water in a wet spell.',
    },
    {
      id: 'rain-protect-young',
      title: 'Protect young plants',
      detail:
        'Check nursery bags and young plantain suckers for waterlogging; clear drains around oil palm seedlings.',
    },
    {
      id: 'rain-postpone-spray',
      title: 'Postpone spraying',
      detail:
        'Hold foliar sprays and fertiliser applications until leaves dry — rain washes product off and wastes input.',
    },
  ],
  heat: [
    {
      id: 'heat-shade-livestock',
      title: 'Shade and water livestock',
      detail:
        'Ensure poultry houses and pens have shade, airflow, and cool drinking water through the hottest hours.',
    },
    {
      id: 'heat-irrigate-cool-hours',
      title: 'Irrigate early or evening',
      detail:
        'Water plantain and young palms at dawn or dusk to cut heat stress and evaporation loss.',
    },
    {
      id: 'heat-electrolytes',
      title: 'Offer electrolytes',
      detail:
        'Add electrolytes or vitamins to poultry water on peak heat days to reduce heat-stress losses.',
    },
  ],
  wind: [
    {
      id: 'wind-secure-covers',
      title: 'Secure covers and lines',
      detail:
        'Tie down shade nets, nursery covers, and drip/irrigation lines before strong gusts hit.',
    },
    {
      id: 'wind-delay-foliar',
      title: 'Delay foliar spray',
      detail:
        'Skip foliar spraying in strong wind — drift wastes chemical and can damage neighbouring crops.',
    },
  ],
  cold: [
    {
      id: 'cold-protect-tender',
      title: 'Protect tender crops and young stock',
      detail:
        'Cover nursery seedlings and young plantain; keep chicks and ducklings warm and dry overnight.',
    },
  ],
}

/**
 * Every theme id this module can emit. The fallback table in
 * `advisory-fallback-messages.ts` is keyed by these, so a theme added here
 * without a translation is caught by test rather than by a French worker.
 */
export const WEATHER_ACTION_THEME_IDS: string[] = [
  ...new Set(Object.values(THEME_BY_ALERT).flatMap((seeds) => seeds.map((seed) => seed.id))),
]

function priorityForAlert(severity: WeatherAlert['severity']): WeatherActionPriority {
  return severity === 'high' ? 'high' : 'medium'
}

function priorityRank(p: WeatherActionPriority): number {
  if (p === 'high') return 0
  if (p === 'medium') return 1
  return 2
}

/**
 * Turn forecast alerts into concise farm actions.
 * Deduplicates by theme id (one suggestion per theme).
 */
export function buildWeatherActions(
  daily: WeatherDay[],
  currentWindKmh = 0,
  alerts?: WeatherAlert[],
): WeatherAction[] {
  const source = alerts ?? buildWeatherAlerts(daily, currentWindKmh)
  const byTheme = new Map<string, WeatherAction>()

  for (const alert of source) {
    const seeds = THEME_BY_ALERT[alert.type] ?? []
    const priority = priorityForAlert(alert.severity)
    for (const seed of seeds) {
      const existing = byTheme.get(seed.id)
      if (!existing || priorityRank(priority) < priorityRank(existing.priority)) {
        byTheme.set(seed.id, {
          id: seed.id,
          priority,
          title: seed.title,
          detail: seed.detail,
          relatedAlert: alert.type,
        })
      }
    }
  }

  return [...byTheme.values()].sort((a, b) => {
    const byPriority = priorityRank(a.priority) - priorityRank(b.priority)
    if (byPriority !== 0) return byPriority
    return a.id.localeCompare(b.id)
  })
}
