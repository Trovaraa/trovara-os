import { Hono } from 'hono'
import { getTableName } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, unknown>
const inserted: Array<{ table: string; values: Row }> = []
const conflicts: Row[] = []
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
    then: (resolve: (value: Row[]) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
  })
  return chain
}

vi.mock('../db/index.js', () => ({
  db: {
    select: (fields?: Row) =>
      queryChain(fields && Object.keys(fields).length === 1 && 'email' in fields
        ? []
        : (selectQueue.shift() ?? [])),
    insert: (table: unknown) => ({
      values: (values: Row) => {
        const row = { id: `lead-${inserted.length + 1}`, status: 'new', submissionCount: 1, ...values }
        inserted.push({ table: getTableName(table as never), values })
        return {
          returning: async () => [row],
          onConflictDoUpdate: (config: Row) => {
            conflicts.push(config)
            return { returning: async () => [row] }
          },
        }
      },
    }),
    update: () => ({
      set: () => ({ where: () => ({ returning: async () => [] }) }),
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
  checkRateLimit: () => ({ allowed: true, retryAfterSec: 0 }),
  checkDurableRateLimit: async () => ({ allowed: true, retryAfterSec: 0 }),
}))
vi.mock('../lib/audit.js', () => ({ logAudit: vi.fn() }))

async function publicApp() {
  const { publicMarketingLeadRoutes } = await import('./marketing-leads.js')
  const app = new Hono()
  app.route('/', publicMarketingLeadRoutes)
  return app
}

async function staffApp() {
  const { marketingLeadRoutes } = await import('./marketing-leads.js')
  const app = new Hono()
  app.route('/', marketingLeadRoutes)
  return app
}

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env.MARKETING_LEAD_NOTIFICATION_EMAILS
  delete process.env.MARKETING_LEAD_CONSENT_VERSION
  inserted.length = 0
  conflicts.length = 0
  selectQueue.length = 0
  sessionUser = {
    id: '11111111-1111-4111-8111-111111111111',
    farmId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    role: 'owner',
  }
})

describe('marketing lead notifications', () => {
  it('uses explicitly configured recipients instead of role-derived addresses', async () => {
    process.env.MARKETING_LEAD_NOTIFICATION_EMAILS = ' info@trovara.farm,INFO@trovara.farm '
    const { notifyMarketingLead } = await import('./marketing-leads.js')
    const { sendEmail } = await import('../lib/notifications.js')

    const sent = await notifyMarketingLead({
      id: '33333333-3333-4333-8333-333333333333',
      farmId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      leadType: 'contact',
      status: 'new',
      name: 'Ada',
      email: 'ada@example.com',
      phone: null,
      normalizedContact: 'email:ada@example.com',
      subjectKey: 'general',
      subjectLabel: 'General Enquiry',
      message: 'Hello',
      productKey: null,
      productLabel: null,
      source: 'marketing_public_contact',
      submissionCount: 1,
      lastSubmittedAt: new Date(),
      assignedToId: null,
      staffNotificationStatus: 'pending',
      staffNotificationError: null,
      staffNotifiedAt: null,
      consentAt: new Date(),
      consentVersion: '1.0',
      privacyNoticeUrl: 'https://trovara.farm/privacy',
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    expect(sent).toBe(true)
    expect(sendEmail).toHaveBeenCalledTimes(1)
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'info@trovara.farm',
      replyTo: 'ada@example.com',
    }))
  })
})

describe('public marketing lead routes', () => {
  it('rejects contact and waitlist submissions without consent', async () => {
    const app = await publicApp()
    const contact = await app.request('/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Ada',
        email: 'ada@example.com',
        subject: 'general',
        message: 'Hello',
      }),
    })
    const waitlist = await app.request('/waitlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Ada',
        contact: 'ada@example.com',
        product: 'coconut',
        consent: false,
      }),
    })
    expect(contact.status).toBe(400)
    expect(waitlist.status).toBe(400)
    expect(inserted).toHaveLength(0)
  })

  it('validates contact subjects and accepts the existing contact payload', async () => {
    const app = await publicApp()
    const invalid = await app.request('/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Ada',
        email: 'ada@example.com',
        subject: 'not-a-subject',
        message: 'Hello',
        consent: true,
      }),
    })
    expect(invalid.status).toBe(400)

    const valid = await app.request('/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Ada',
        email: ' ADA@Example.COM ',
        phone: '+234 800 000 0000',
        subject: 'farm-os',
        message: 'Tell me more.',
        consent: true,
      }),
    })
    expect(valid.status).toBe(202)
    expect(inserted[0]?.values).toMatchObject({
      leadType: 'contact',
      email: 'ada@example.com',
      subjectKey: 'farm-os',
      subjectLabel: 'Trovara Farm OS (Operations System)',
      consentVersion: '1.0',
      privacyNoticeUrl: 'https://trovara.farm/privacy',
    })
    expect(inserted[0]?.values.consentAt).toBeInstanceOf(Date)
  })

  it('stores consentVersion from the body when provided', async () => {
    const response = await (await publicApp()).request('/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Ada',
        email: 'ada@example.com',
        subject: 'general',
        message: 'Hello',
        consent: true,
        consentVersion: '2.1',
      }),
    })
    expect(response.status).toBe(202)
    expect(inserted[0]?.values).toMatchObject({ consentVersion: '2.1' })
  })

  it('falls back to MARKETING_LEAD_CONSENT_VERSION when the body omits it', async () => {
    process.env.MARKETING_LEAD_CONSENT_VERSION = '1.5'
    const response = await (await publicApp()).request('/waitlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Ada',
        contact: 'ada@example.com',
        product: 'eggs',
        consent: true,
      }),
    })
    expect(response.status).toBe(202)
    expect(inserted[0]?.values).toMatchObject({ consentVersion: '1.5' })
  })

  it.each([
    ['coconut', 'Coconut'],
    ['plantain', 'Plantain'],
    ['poultry', 'Pasture-raised Chicken'],
    ['eggs', 'Pasture-raised Eggs'],
    ['palm-oil', 'Palm Oil'],
  ])('accepts product %s with its canonical label', async (product, label) => {
    const response = await (await publicApp()).request('/waitlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Ada', contact: 'ADA@Example.COM', product, consent: true }),
    })
    expect(response.status).toBe(202)
    expect(inserted[0]?.values).toMatchObject({
      leadType: 'product_waitlist',
      productKey: product,
      productLabel: label,
      email: 'ada@example.com',
      normalizedContact: 'email:ada@example.com',
      consentVersion: '1.0',
    })
  })

  it('uses the partial waitlist conflict key and refreshes repeat submissions', async () => {
    const response = await (await publicApp()).request('/waitlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Ada Updated',
        contact: '+234 800 000 0000',
        product: 'eggs',
        consent: true,
        consentVersion: '1.0',
      }),
    })
    expect(response.status).toBe(202)
    expect(inserted[0]?.values).toMatchObject({
      phone: '+234 800 000 0000',
      normalizedContact: 'phone:+2348000000000',
    })
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toHaveProperty('targetWhere')
    expect(conflicts[0]?.set).toMatchObject({
      name: 'Ada Updated',
      email: null,
      phone: '+234 800 000 0000',
      staffNotificationStatus: 'pending',
      consentVersion: '1.0',
      privacyNoticeUrl: 'https://trovara.farm/privacy',
    })
    expect((conflicts[0]?.set as Row).submissionCount).toBeDefined()
    expect((conflicts[0]?.set as Row).status).toBeDefined()
    expect((conflicts[0]?.set as Row).consentAt).toBeInstanceOf(Date)
  })

  it('accepts honeypots without persistence', async () => {
    const response = await (await publicApp()).request('/waitlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Bot',
        contact: 'bot@example.com',
        product: 'coconut',
        consent: true,
        honey: 'filled',
      }),
    })
    expect(response.status).toBe(202)
    expect(inserted).toHaveLength(0)
  })
})

describe('marketing lead staff access', () => {
  it.each(['owner', 'sales'])('allows %s to list farm leads', async (role) => {
    sessionUser.role = role
    selectQueue.push([], [], [], [{
      id: '22222222-2222-4222-8222-222222222222',
      name: 'Sales User',
      role: 'sales',
      active: true,
    }])
    const response = await (await staffApp()).request('/')
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      leads: [],
      assignees: [{ name: 'Sales User', role: 'sales' }],
      summary: { total: 0 },
    })
  })

  it.each(['supervisor', 'field_worker'])('rejects %s', async (role) => {
    sessionUser.role = role
    const response = await (await staffApp()).request('/')
    expect(response.status).toBe(403)
  })
})
