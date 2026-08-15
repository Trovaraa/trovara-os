import { Hono } from 'hono'
import { getTableName } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, unknown>
const inserted: Array<{ table: string; values: Row }> = []
const selectQueue: Row[][] = []
let sessionUser: Row = {
  id: '11111111-1111-4111-8111-111111111111',
  farmId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  role: 'owner',
}

function queryChain(rows: Row[]) {
  const chain: Record<string, unknown> = {}
  const same = () => chain
  Object.assign(chain, {
    from: same,
    leftJoin: same,
    where: same,
    orderBy: same,
    groupBy: same,
    limit: same,
    offset: same,
    then: (resolve: (value: Row[]) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
  })
  return chain
}

vi.mock('../db/index.js', () => ({
  db: {
    select: () => queryChain(selectQueue.shift() ?? []),
    insert: (table: unknown) => ({
      values: (values: Row) => {
        const row = { id: `row-${inserted.length + 1}`, ...values }
        inserted.push({ table: getTableName(table as never), values })
        return { returning: async () => [row] }
      },
    }),
  },
}))

vi.mock('../middleware/auth.js', () => ({
  authMiddleware: async (
    c: { set: (key: string, value: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set('user', sessionUser)
    await next()
  },
}))
vi.mock('../lib/customer-orders.js', () => ({
  resolveCustomerFarm: vi.fn(async () => ({
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    name: 'Trovara Farm',
  })),
}))
vi.mock('../lib/notifications.js', () => ({
  sendEmail: vi.fn(async () => ({ channel: 'email', status: 'delivered', required: false })),
}))
vi.mock('../lib/rate-limit.js', () => ({
  checkDurableRateLimit: async () => ({ allowed: true, retryAfterSec: 0 }),
}))

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    location: 'abeokuta',
    household: '3_4',
    buyPlaces: ['open_market'],
    frequency: 'weekly',
    frustrations: ['unknown_source'],
    priorities: ['freshness', 'origin', 'food_safety'],
    products: ['eggs', 'plantain'],
    hardToGet: 'Consistent chicken.',
    sourceMatters: 'definitely',
    shopPreference: 'customise_basket',
    priceExpectation: 'same',
    oneChange: 'Tell me where the food came from.',
    heardFrom: 'website',
    followUp: 'no',
    consent: true,
    ...overrides,
  }
}

async function publicApp() {
  const { publicCustomerSurveyRoutes } = await import('./customer-surveys.js')
  const app = new Hono()
  app.route('/', publicCustomerSurveyRoutes)
  return app
}

async function staffApp() {
  const { customerSurveyRoutes } = await import('./customer-surveys.js')
  const app = new Hono()
  app.route('/', customerSurveyRoutes)
  return app
}

beforeEach(() => {
  vi.clearAllMocks()
  inserted.length = 0
  selectQueue.length = 0
  sessionUser = {
    id: '11111111-1111-4111-8111-111111111111',
    farmId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    role: 'owner',
  }
})

describe('public customer surveys', () => {
  it('rejects submissions without consent', async () => {
    const response = await (await publicApp()).request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody({ consent: false })),
    })
    expect(response.status).toBe(400)
    expect(inserted).toHaveLength(0)
  })

  it('stores an anonymous survey without creating a lead', async () => {
    const response = await (await publicApp()).request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody()),
    })
    expect(response.status).toBe(202)
    expect(inserted.map((row) => row.table)).toEqual(['customer_survey_responses'])
    expect(inserted[0]?.values).toMatchObject({
      followUp: 'no',
      email: null,
      phone: null,
      leadId: null,
      surveyKey: 'food-shopping-v1',
    })
  })

  it('creates a follow-up lead when contact is provided', async () => {
    const response = await (await publicApp()).request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody({
        followUp: 'yes',
        name: 'Ada',
        contact: 'ada@example.com',
      })),
    })
    expect(response.status).toBe(202)
    expect(inserted.map((row) => row.table)).toEqual(['marketing_leads', 'customer_survey_responses'])
    expect(inserted[0]?.values).toMatchObject({
      leadType: 'survey_followup',
      email: 'ada@example.com',
      subjectKey: 'survey',
    })
    expect(inserted[1]?.values).toMatchObject({
      followUp: 'yes',
      email: 'ada@example.com',
      leadId: 'row-1',
    })
  })
})

describe('staff customer surveys', () => {
  it('forbids users without lead access', async () => {
    sessionUser = { ...sessionUser, role: 'field_worker', permissions: [] }
    const response = await (await staffApp()).request('/')
    expect(response.status).toBe(403)
  })

  it('does not expose survey contacts to finance-only users', async () => {
    sessionUser = { ...sessionUser, role: 'sales', permissions: ['finance.read'] }
    const response = await (await staffApp()).request('/')
    expect(response.status).toBe(403)
  })

  it('returns a paged response and reports when another page exists', async () => {
    selectQueue.push(
      Array.from({ length: 11 }, (_, index) => ({
        id: `survey-${index}`,
        surveyKey: 'food-shopping-v1',
        followUp: 'no',
        name: null,
        email: null,
        phone: null,
        source: 'website_food_survey',
        utmSource: null,
        utmMedium: null,
        utmCampaign: null,
        referrer: null,
        leadId: null,
        consentVersion: '2026-08-15',
        createdAt: new Date('2026-08-15T12:00:00Z'),
        answers: validBody(),
      })),
      [{ value: 'no', count: 11 }],
    )
    const response = await (await staffApp()).request('/?pageSize=10')
    expect(response.status).toBe(200)
    const body = await response.json() as { responses: Row[]; hasMore: boolean; page: number }
    expect(body.responses).toHaveLength(10)
    expect(body.hasMore).toBe(true)
    expect(body.page).toBe(1)
  })

  it('exports all matching responses as CSV', async () => {
    selectQueue.push([{
      id: 'survey-1',
      surveyKey: 'food-shopping-v1',
      followUp: 'yes',
      name: 'Ada',
      email: 'ada@example.com',
      phone: null,
      source: 'website_food_survey',
      utmSource: null,
      utmMedium: null,
      utmCampaign: null,
      referrer: null,
      leadId: 'lead-1',
      consentVersion: '2026-08-15',
      createdAt: new Date('2026-08-15T12:00:00Z'),
      answers: validBody({ oneChange: '=not a formula' }),
    }])
    const response = await (await staffApp()).request('/export?followUp=yes')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/csv')
    const csv = await response.text()
    expect(csv).toContain('ada@example.com')
    expect(csv).toContain('=not a formula')
  })
})
