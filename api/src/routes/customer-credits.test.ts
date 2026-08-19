import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, unknown>
const distinctQueue: Row[][] = []
const selectQueue: Row[][] = []
let sessionUser: Row = {
  id: '11111111-1111-4111-8111-111111111111',
  farmId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  role: 'owner',
}

const createOrRefreshCreditInvitation = vi.fn()
const markCreditInvitationSent = vi.fn(async () => undefined)
const sendEmail = vi.fn(async () => ({ status: 'delivered', id: 'email-1' }))
const logAudit = vi.fn(async () => undefined)

function selectChain(rows: Row[]) {
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
}

vi.mock('../db/index.js', () => ({
  db: {
    selectDistinctOn: () => selectChain(distinctQueue.shift() ?? []),
    select: () => selectChain(selectQueue.shift() ?? []),
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

vi.mock('../lib/customer-credits.js', () => ({
  createOrRefreshCreditInvitation,
  markCreditInvitationSent,
}))

vi.mock('../lib/notifications.js', () => ({
  emailProviderReady: () => true,
  sendEmail,
}))

vi.mock('../lib/email-template.js', () => ({
  trovaraCreditInvitationEmailContent: () => ({
    subject: 'Your Trovara update',
    text: 'Claim your account',
    html: '<p>Claim your account</p>',
  }),
  trovaraCreditsReadyEmailContent: () => ({
    subject: 'Your Trovara update',
    text: 'Your credits are ready',
    html: '<p>Your credits are ready</p>',
  }),
}))

vi.mock('../lib/public-app-url.js', () => ({
  shopAccountUrl: () => 'https://shop.trovara.farm/account',
  shopCreditClaimUrl: (token: string) => `https://shop.trovara.farm/credits/claim?token=${token}`,
}))

vi.mock('../lib/audit.js', () => ({ logAudit }))
vi.mock('../lib/request-access-meta.js', () => ({ requestAccessMeta: () => ({}) }))

async function app() {
  const { customerCreditRoutes } = await import('./customer-credits.js')
  return new Hono().route('/api/customer-credits', customerCreditRoutes)
}

function summaryRows() {
  selectQueue.push([{ count: 1 }], [{ count: 1 }], [{ count: 0 }], [{ count: 0 }])
}

beforeEach(() => {
  vi.clearAllMocks()
  distinctQueue.length = 0
  selectQueue.length = 0
  sessionUser = {
    id: '11111111-1111-4111-8111-111111111111',
    farmId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    role: 'owner',
  }
})

describe('single Trovara Credits invitation', () => {
  it('sends only the selected eligible survey respondent', async () => {
    distinctQueue.push([
      {
        id: 'survey-1',
        email: 'ada@example.com',
        name: 'Ada',
        leadId: 'lead-1',
        createdAt: new Date('2026-08-19T12:00:00Z'),
      },
    ])
    createOrRefreshCreditInvitation.mockResolvedValueOnce({
      kind: 'invitation',
      id: 'invite-1',
      email: 'ada@example.com',
      name: 'Ada',
      rawToken: 'raw-token',
    })
    summaryRows()

    const response = await (await app()).request('/api/customer-credits/invitations/send-one', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true, email: '  ADA@example.com ' }),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      result: {
        eligible: 1,
        invitationsSent: 1,
        accountsCredited: 0,
        alreadyProcessed: 0,
        failed: 0,
      },
    })
    expect(createOrRefreshCreditInvitation).toHaveBeenCalledTimes(1)
    expect(createOrRefreshCreditInvitation).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'ada@example.com', surveyResponseId: 'survey-1' }),
    )
    expect(sendEmail).toHaveBeenCalledTimes(1)
    expect(markCreditInvitationSent).toHaveBeenCalledWith('invite-1')
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ mode: 'single' }) }),
    )
  })

  it('does not send when the email is not an eligible survey respondent', async () => {
    distinctQueue.push([])

    const response = await (await app()).request('/api/customer-credits/invitations/send-one', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true, email: 'unknown@example.com' }),
    })

    expect(response.status).toBe(404)
    expect(sendEmail).not.toHaveBeenCalled()
    expect(createOrRefreshCreditInvitation).not.toHaveBeenCalled()
  })

  it('requires an explicit confirmation and a valid email', async () => {
    const response = await (await app()).request('/api/customer-credits/invitations/send-one', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: false, email: 'not-an-email' }),
    })

    expect(response.status).toBe(400)
    expect(sendEmail).not.toHaveBeenCalled()
  })
})
