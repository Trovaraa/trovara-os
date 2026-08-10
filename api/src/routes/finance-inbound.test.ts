import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const processFinanceInboundWebhook = vi.fn()
const missingConfig: string[] = []

vi.mock('../lib/finance-inbound.js', () => ({ processFinanceInboundWebhook }))
vi.mock('../lib/newsletter-resend.js', () => ({
  inboundWebhookConfigMissing: () => missingConfig,
}))
vi.mock('../lib/rate-limit.js', () => ({
  checkRateLimit: () => ({ allowed: true, retryAfterSec: 0 }),
}))
vi.mock('../lib/client-ip.js', () => ({
  clientIpFromHeaders: () => '127.0.0.1',
}))

async function app() {
  const { publicFinanceInboundRoutes } = await import('./finance-inbound.js')
  const instance = new Hono()
  instance.route('/public/finance', publicFinanceInboundRoutes)
  return instance
}

const validHeaders = {
  'content-type': 'application/json',
  'svix-id': 'msg_1',
  'svix-timestamp': '1723300000',
  'svix-signature': 'v1,valid',
}

describe('public finance inbound route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    missingConfig.length = 0
    processFinanceInboundWebhook.mockResolvedValue({ ok: true, expenseId: 'exp-1' })
  })

  it('returns 503 without the Resend API key or inbound signing secret', async () => {
    missingConfig.push('RESEND_INBOUND_WEBHOOK_SECRET')

    const response = await (await app()).request('/public/finance/inbound', {
      method: 'POST',
      headers: validHeaders,
      body: '{}',
    })

    expect(response.status).toBe(503)
    expect(processFinanceInboundWebhook).not.toHaveBeenCalled()
  })

  it.each(['svix-id', 'svix-timestamp', 'svix-signature'])(
    'rejects a request missing %s',
    async (missingHeader) => {
      const headers = { ...validHeaders }
      delete headers[missingHeader as keyof typeof headers]

      const response = await (await app()).request('/public/finance/inbound', {
        method: 'POST',
        headers,
        body: '{}',
      })

      expect(response.status).toBe(401)
      await expect(response.json()).resolves.toEqual({ error: 'Invalid webhook signature' })
      expect(processFinanceInboundWebhook).not.toHaveBeenCalled()
    },
  )

  it('maps signature verification failure to 401', async () => {
    processFinanceInboundWebhook.mockRejectedValueOnce(new Error('Invalid webhook signature'))

    const response = await (await app()).request('/public/finance/inbound', {
      method: 'POST',
      headers: validHeaders,
      body: '{"type":"email.received"}',
    })

    expect(response.status).toBe(401)
    expect(processFinanceInboundWebhook).toHaveBeenCalledWith({
      rawBody: '{"type":"email.received"}',
      svixId: 'msg_1',
      svixTimestamp: '1723300000',
      svixSignature: 'v1,valid',
    })
  })

  it('passes the untouched body and Svix headers to the processor', async () => {
    const response = await (await app()).request('/public/finance/inbound', {
      method: 'POST',
      headers: validHeaders,
      body: '{"data":{"email_id":"email-1"}}',
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      received: true,
      ok: true,
      expenseId: 'exp-1',
    })
    expect(processFinanceInboundWebhook).toHaveBeenCalledWith({
      rawBody: '{"data":{"email_id":"email-1"}}',
      svixId: 'msg_1',
      svixTimestamp: '1723300000',
      svixSignature: 'v1,valid',
    })
  })
})
