import { Hono } from 'hono'
import { getTableName } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, unknown>
const tableName = (table: unknown) => getTableName(table as never)
const selectQueue: Row[][] = []
const inserted: Array<{ table: string; values: Row }> = []
const updates: Array<{ table: string; values: Row }> = []
const updateReturnQueue: Row[][] = []
let sessionUser: Row = {
  id: '11111111-1111-4111-8111-111111111111',
  farmId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  role: 'owner',
}

const sendConfirmationEmail = vi.fn(async (_subscriber: Row, _token: string) => 'email-id')
const sendWelcomeEmail = vi.fn(async (_subscriber: Row, _version: string) => 'welcome-id')
const upsertResendContact = vi.fn(async (_subscriber: Row) => 'contact-id')

function promiseChain<T>(value: T) {
  return {
    then: (resolve: (result: T) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(value).then(resolve, reject),
  }
}

vi.mock('../db/index.js', () => ({
  db: {
    select: () => {
      const rows = selectQueue.shift() ?? []
      const chain: Record<string, unknown> = {}
      const same = () => chain
      Object.assign(chain, {
        from: same,
        where: same,
        orderBy: same,
        groupBy: same,
        limit: same,
        then: (resolve: (value: Row[]) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve(rows).then(resolve, reject),
      })
      return chain
    },
    insert: (table: unknown) => ({
      values: (values: Row) => {
        const name = tableName(table)
        inserted.push({ table: name, values })
        const row = { id: 'subscriber-new', ...values }
        return {
          returning: async () => [row],
          onConflictDoNothing: () => ({ returning: async () => [row] }),
          ...promiseChain(undefined),
        }
      },
    }),
    update: (table: unknown) => ({
      set: (values: Row) => {
        const name = tableName(table)
        updates.push({ table: name, values })
        return {
          where: () => ({
            returning: async () => updateReturnQueue.shift() ?? [],
            ...promiseChain(undefined),
          }),
        }
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
    location: 'Lagos',
  })),
}))

vi.mock('../lib/newsletter-resend.js', () => ({
  newsletterConsentVersion: () => '1.0',
  sendConfirmationEmail,
  sendWelcomeEmail,
  upsertResendContact,
  verifyResendWebhook: vi.fn(),
}))

vi.mock('../lib/rate-limit.js', () => ({
  checkRateLimit: () => ({ allowed: true, retryAfterSec: 0 }),
  checkDurableRateLimit: async () => ({ allowed: true, retryAfterSec: 0 }),
}))
vi.mock('../lib/audit.js', () => ({ logAudit: vi.fn() }))

async function publicApp() {
  const { publicNewsletterRoutes } = await import('./newsletter.js')
  const app = new Hono()
  app.route('/', publicNewsletterRoutes)
  return app
}

async function ownerApp() {
  const { newsletterRoutes } = await import('./newsletter.js')
  const app = new Hono()
  app.route('/', newsletterRoutes)
  return app
}

beforeEach(() => {
  vi.clearAllMocks()
  selectQueue.length = 0
  inserted.length = 0
  updates.length = 0
  updateReturnQueue.length = 0
  sessionUser = {
    id: '11111111-1111-4111-8111-111111111111',
    farmId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    role: 'owner',
  }
})

describe('public newsletter routes', () => {
  it('requires explicit phone consent', async () => {
    const response = await (await publicApp()).request('/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Ada Farmer',
        email: 'ada@example.com',
        phone: '+2348000000000',
        consent: true,
      }),
    })
    expect(response.status).toBe(400)
    expect(inserted).toHaveLength(0)
  })

  it('accepts a honeypot submission without side effects', async () => {
    const response = await (await publicApp()).request('/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Bot',
        email: 'bot@example.com',
        consent: true,
        honey: 'filled',
      }),
    })
    expect(response.status).toBe(202)
    expect(inserted).toHaveLength(0)
    expect(sendConfirmationEmail).not.toHaveBeenCalled()
  })

  it('normalizes email and stores only a hash of the confirmation token', async () => {
    selectQueue.push([])
    const response = await (await publicApp()).request('/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Ada Farmer',
        email: '  ADA@Example.COM ',
        consent: true,
      }),
    })
    expect(response.status).toBe(202)
    await expect(response.json()).resolves.toMatchObject({ ok: true, accepted: true })
    const subscriberInsert = inserted.find((entry) => entry.table === 'newsletter_subscribers')
    expect(subscriberInsert?.values.email).toBe('ada@example.com')
    expect(subscriberInsert?.values.confirmationTokenHash).toMatch(/^[a-f0-9]{64}$/)
    const rawToken = sendConfirmationEmail.mock.calls[0]?.[1]
    expect(rawToken).toMatch(/^[A-Za-z0-9_-]{40,}$/)
    expect(JSON.stringify(subscriberInsert?.values)).not.toContain(rawToken)
  })

  it('retains pending signup and returns 202 when delivery fails', async () => {
    selectQueue.push([])
    sendConfirmationEmail.mockRejectedValueOnce(new Error('provider unavailable'))
    const response = await (await publicApp()).request('/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Ada Farmer',
        email: 'ada@example.com',
        consent: true,
      }),
    })
    expect(response.status).toBe(202)
    const body = await response.json()
    expect(body).toMatchObject({ ok: true, accepted: true })
    expect(inserted.some((entry) => entry.table === 'newsletter_subscribers')).toBe(true)
    expect(
      updates.some(
        (entry) =>
          entry.table === 'newsletter_subscribers' &&
          entry.values.confirmationDeliveryStatus === 'failed',
      ),
    ).toBe(true)
  })
})

describe('owner newsletter routes', () => {
  it('rejects non-owner access', async () => {
    sessionUser = { ...sessionUser, role: 'supervisor' }
    const response = await (await ownerApp()).request('/')
    expect(response.status).toBe(403)
    expect(selectQueue).toHaveLength(0)
  })
})
