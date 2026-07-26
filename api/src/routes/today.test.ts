import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdvisoryRecommendationRow, AdvisorySubject } from '../lib/advisory-engine.js'
import type { ActionItem, ExceptionItem, ExceptionSummary } from '../lib/exceptions.js'
import type { WeatherSnapshot } from '../lib/weather.js'

type Row = Record<string, unknown>

let sessionUser: Row = {
  id: 'user-worker',
  farmId: 'farm-1',
  role: 'field_worker',
  email: 'worker@trovara.farm',
}

let preferredLocale: string | null = 'fr'

vi.mock('../db/index.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => [{ preferredLocale }] }),
      }),
    }),
  },
}))

vi.mock('../middleware/auth.js', () => ({
  authMiddleware: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set('user', sessionUser)
    await next()
  },
}))

vi.mock('../lib/exceptions.js', () => ({
  gatherExceptions: vi.fn(),
  gatherWorkerTodayTasks: vi.fn(async () => []),
}))

vi.mock('../lib/weather.js', () => ({
  getFarmWeather: vi.fn(),
  regenerateWeatherActions: vi.fn(),
}))

vi.mock('../lib/advisory-engine.js', () => ({
  listAdvisorySubjects: vi.fn(),
  listRecommendationsForRole: vi.fn(),
}))

vi.mock('../lib/content-locale.js', () => ({
  toViewerLocaleMany: vi.fn(),
  toViewerLocale: vi.fn(),
}))

const { gatherExceptions } = await import('../lib/exceptions.js')
const { getFarmWeather } = await import('../lib/weather.js')
const { listAdvisorySubjects, listRecommendationsForRole } = await import(
  '../lib/advisory-engine.js'
)
const { toViewerLocaleMany } = await import('../lib/content-locale.js')

const mockGatherExceptions = vi.mocked(gatherExceptions)
const mockGetFarmWeather = vi.mocked(getFarmWeather)
const mockSubjects = vi.mocked(listAdvisorySubjects)
const mockRecommendationsForRole = vi.mocked(listRecommendationsForRole)
const mockTranslateMany = vi.mocked(toViewerLocaleMany)

/** Already French: the weather layer localizes actions before we see them. */
const FRENCH_ACTION = {
  id: 'shelter-birds',
  priority: 'high' as const,
  title: 'Abritez les poulets avant la pluie',
  detail: 'Fermez les bâches côté vent et vérifiez la litière.',
  relatedAlert: 'rain' as const,
}

const RAIN_ALERT = {
  type: 'rain' as const,
  severity: 'high' as const,
  title: 'Heavy rain risk',
  message: 'Expected Tomorrow around 3:00 PM (18.0 mm · 80% chance).',
  whenLabel: 'Tomorrow around 3:00 PM',
  date: '2026-07-26',
}

function weatherSnapshot(): WeatherSnapshot {
  return {
    status: 'ok',
    provider: 'open-meteo',
    attribution: 'Open-Meteo',
    fetchedAt: '2026-07-25T06:00:00.000Z',
    timezone: 'Africa/Lagos',
    locationLabel: 'Ibadan',
    current: { tempC: 29, feelsLikeC: 31, humidity: 80, windKmh: 12, condition: 'Cloudy' },
    daily: [],
    alerts: [RAIN_ALERT],
    actions: [FRENCH_ACTION],
    actionsSource: 'ai',
    actionsLocale: 'fr',
  }
}

const LOW_STOCK_EXCEPTION: ExceptionItem = {
  type: 'low_stock',
  severity: 'medium',
  title: 'Layer mash',
  message: 'Only 2 bags left of Layer mash.',
  messageKey: 'exceptions.msg.lowStock',
  messageParams: { name: 'Layer mash', quantity: 2, unit: 'bags' },
  entityType: 'inventory_item',
  entityId: 'item-1',
  timestamp: '2026-07-25T05:00:00.000Z',
}

const APPROVE_ACTION: ActionItem = {
  priority: 1,
  action: 'restock',
  label: 'Restock Layer mash',
  labelKey: 'exceptions.action.restock',
  labelParams: { title: 'Layer mash' },
  entityType: 'inventory_item',
  entityId: 'item-1',
  link: '/inventory',
}

const EMPTY_SUMMARY: ExceptionSummary = {
  overdueTasks: 0,
  lowStock: 1,
  pendingApprovals: 0,
  mortalityToday: 0,
  ordersPending: 0,
  rejectedTasks: 0,
  assetLogsMissing: 0,
  assetVerificationPending: 0,
  censusMissing: 0,
  censusRejected: 0,
  censusStale: 0,
  weatherAlerts: 0,
  total: 1,
}

const subject: AdvisorySubject = {
  kind: 'crop',
  id: 'cycle-1',
  label: 'Maize · Block A',
  cropType: 'maize',
  plotName: 'Block A',
  stage: 'vegetative',
  plantedAt: '2026-06-01T00:00:00.000Z',
  stageEnteredAt: '2026-07-01T00:00:00.000Z',
  dayInStage: 24,
  totalStageDays: null,
  daysUntilNextHint: 3,
  nextHint: 'Top-dress with compost and weed between the rows.',
}

const recommendation: AdvisoryRecommendationRow = {
  id: 'rec-1',
  farmId: 'farm-1',
  ruleKey: 'noiler.vaccination.gumboro',
  sourceType: 'livestock_batch',
  sourceId: 'batch-1',
  status: 'notified',
  notifyRoles: ['field_worker'],
  payload: {
    happeningNow: 'Batch A is due for its Gumboro vaccination.',
    whatNext: 'Give the vaccine in clean drinking water at dawn.',
    needQuery: 'gumboro vaccine',
    products: [{ title: 'AgroVet Gumboro Vaccine', url: null, source: 'llm', priceText: '₦4,200' }],
    reasonCode: 'vaccination_due',
  },
  aiSummary: 'Missing this window costs birds later in the cycle.',
  firedAt: new Date('2026-07-25T06:00:00Z'),
  resolvedAt: null,
  resolvedBy: null,
  createdAt: new Date('2026-07-25T06:00:00Z'),
  updatedAt: new Date('2026-07-25T06:00:00Z'),
}

type TodayBody = {
  exceptions: ExceptionItem[]
  actionList: ActionItem[]
  weather: WeatherSnapshot
  advisory: {
    subject: AdvisorySubject | null
    recommendation: { payload: Record<string, unknown>; aiSummary: string | null } | null
    openCount: number
  } | null
}

async function getToday(): Promise<{ status: number; body: TodayBody }> {
  const { todayRoutes } = await import('./today.js')
  const app = new Hono()
  app.route('/today', todayRoutes)
  const res = await app.request('/today')
  return { status: res.status, body: (await res.json()) as TodayBody }
}

function translatedTexts(): string[] {
  return mockTranslateMany.mock.calls[0]?.[0].texts ?? []
}

beforeEach(() => {
  vi.clearAllMocks()
  preferredLocale = 'fr'
  sessionUser = {
    id: 'user-worker',
    farmId: 'farm-1',
    role: 'field_worker',
    email: 'worker@trovara.farm',
  }
  mockGatherExceptions.mockResolvedValue({
    exceptions: [{ ...LOW_STOCK_EXCEPTION }],
    actionList: [{ ...APPROVE_ACTION }],
    summary: { ...EMPTY_SUMMARY },
  })
  mockGetFarmWeather.mockResolvedValue(weatherSnapshot())
  mockSubjects.mockResolvedValue([subject])
  mockRecommendationsForRole.mockResolvedValue([recommendation])
  mockTranslateMany.mockImplementation(async ({ texts }) => texts.map((t) => `[fr] ${t}`))
})

describe('GET /today - advisory teaser localization', () => {
  it('renders the teaser recommendation and subject hint in the viewer language', async () => {
    const { status, body } = await getToday()
    expect(status).toBe(200)

    expect(body.advisory?.recommendation?.payload.happeningNow).toBe(
      '[fr] Batch A is due for its Gumboro vaccination.',
    )
    expect(body.advisory?.recommendation?.payload.whatNext).toBe(
      '[fr] Give the vaccine in clean drinking water at dawn.',
    )
    expect(body.advisory?.recommendation?.aiSummary).toBe(
      '[fr] Missing this window costs birds later in the cycle.',
    )
    expect(body.advisory?.subject?.nextHint).toBe(
      '[fr] Top-dress with compost and weed between the rows.',
    )
    expect(body.advisory?.openCount).toBe(1)
  })

  it('spends a single batched translation call for the whole teaser', async () => {
    await getToday()
    expect(mockTranslateMany).toHaveBeenCalledTimes(1)
    expect(translatedTexts()).toEqual([
      'Batch A is due for its Gumboro vaccination.',
      'Give the vaccine in clean drinking water at dawn.',
      'Missing this window costs birds later in the cycle.',
      'Top-dress with compost and weed between the rows.',
    ])
  })

  it('leaves product names, prices and the subject label as stored', async () => {
    const { body } = await getToday()

    expect(body.advisory?.recommendation?.payload.products).toEqual([
      { title: 'AgroVet Gumboro Vaccine', url: null, source: 'llm', priceText: '₦4,200' },
    ])
    expect(body.advisory?.recommendation?.payload.reasonCode).toBe('vaccination_due')
    expect(body.advisory?.subject?.label).toBe('Maize · Block A')
    expect(translatedTexts()).not.toContain('AgroVet Gumboro Vaccine')
    expect(translatedTexts()).not.toContain('Maize · Block A')
  })

  it('costs an English viewer no translation call', async () => {
    preferredLocale = 'en'
    const { body } = await getToday()

    expect(mockTranslateMany).not.toHaveBeenCalled()
    expect(body.advisory?.recommendation?.payload.happeningNow).toBe(
      'Batch A is due for its Gumboro vaccination.',
    )
    expect(body.advisory?.subject?.nextHint).toBe(
      'Top-dress with compost and weed between the rows.',
    )
  })

  it('costs a viewer with no stored language preference no translation call', async () => {
    preferredLocale = null
    const { body } = await getToday()

    expect(mockTranslateMany).not.toHaveBeenCalled()
    expect(body.advisory?.recommendation?.payload.happeningNow).toBe(
      'Batch A is due for its Gumboro vaccination.',
    )
  })

  it('serves readable English when the translator fails', async () => {
    mockTranslateMany.mockRejectedValue(new Error('llm unavailable'))
    const { status, body } = await getToday()

    expect(status).toBe(200)
    expect(body.advisory?.recommendation?.payload.happeningNow).toBe(
      'Batch A is due for its Gumboro vaccination.',
    )
    expect(body.advisory?.subject?.nextHint).toBe(
      'Top-dress with compost and weed between the rows.',
    )
  })

  it('skips the teaser entirely for sales', async () => {
    sessionUser = { id: 'user-sales', farmId: 'farm-1', role: 'sales', email: 's@trovara.farm' }
    const { body } = await getToday()

    expect(body.advisory).toBeNull()
    expect(mockRecommendationsForRole).not.toHaveBeenCalled()
    expect(mockTranslateMany).not.toHaveBeenCalled()
  })

  it('has nothing to translate when the farm has no advisory content', async () => {
    mockSubjects.mockResolvedValue([])
    mockRecommendationsForRole.mockResolvedValue([])
    const { body } = await getToday()

    expect(body.advisory).toEqual({ subject: null, recommendation: null, openCount: 0 })
    expect(mockTranslateMany).not.toHaveBeenCalled()
  })
})

describe('GET /today - fields localized by other layers', () => {
  it('passes the viewer locale to the weather layer and reuses its localized actions', async () => {
    const { body } = await getToday()

    expect(mockGetFarmWeather).toHaveBeenCalledWith('farm-1', { preferredLocale: 'fr' })
    expect(body.weather.actions).toEqual([FRENCH_ACTION])
    const weatherAction = body.actionList.find((a) => a.action === 'weather_farm_action')
    expect(weatherAction?.label).toBe(FRENCH_ACTION.title)
  })

  it('does not send weather text through the translator a second time', async () => {
    await getToday()

    const staged = translatedTexts()
    expect(staged).not.toContain(FRENCH_ACTION.title)
    expect(staged).not.toContain(FRENCH_ACTION.detail)
    expect(staged).not.toContain(RAIN_ALERT.title)
    expect(staged).not.toContain(RAIN_ALERT.message)
  })

  it('leaves weather-derived exception copy exactly as the weather layer worded it', async () => {
    const { body } = await getToday()

    const rain = body.exceptions.find((e) => e.type === 'weather_rain')
    expect(rain?.title).toBe(RAIN_ALERT.title)
    expect(rain?.message).toBe(RAIN_ALERT.message)
    const review = body.actionList.find((a) => a.action === 'review_weather')
    expect(review?.labelParams).toEqual({ title: RAIN_ALERT.title })
  })

  it('leaves keyed exception title and message for the client to localize', async () => {
    const { body } = await getToday()

    const lowStock = body.exceptions.find((e) => e.type === 'low_stock')
    expect(lowStock?.title).toBe('Layer mash')
    expect(lowStock?.message).toBe('Only 2 bags left of Layer mash.')
    expect(lowStock?.messageKey).toBe('exceptions.msg.lowStock')
    expect(translatedTexts()).not.toContain('Only 2 bags left of Layer mash.')
  })

  it('leaves keyed action labels for the client to localize', async () => {
    const { body } = await getToday()

    const restock = body.actionList.find((a) => a.action === 'restock')
    expect(restock?.label).toBe('Restock Layer mash')
    expect(restock?.labelKey).toBe('exceptions.action.restock')
    expect(translatedTexts()).not.toContain('Restock Layer mash')
  })
})
