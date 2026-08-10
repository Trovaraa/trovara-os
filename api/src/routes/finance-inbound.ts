import { Hono } from 'hono'
import { checkRateLimit } from '../lib/rate-limit.js'
import { clientIpFromHeaders } from '../lib/client-ip.js'
import { processFinanceInboundWebhook } from '../lib/finance-inbound.js'
import { inboundWebhookConfigMissing } from '../lib/newsletter-resend.js'

export const publicFinanceInboundRoutes = new Hono()

function publicRateLimit(
  c: {
    req: { header: (name: string) => string | undefined }
    header: (name: string, value: string) => void
  },
  action: string,
  max: number,
): boolean {
  const ip = clientIpFromHeaders((name) => c.req.header(name)) ?? 'unknown'
  const result = checkRateLimit(`finance-inbound:${action}:${ip}`, max, 60_000)
  if (!result.allowed) c.header('Retry-After', String(result.retryAfterSec))
  return result.allowed
}

publicFinanceInboundRoutes.post('/inbound', async (c) => {
  if (!publicRateLimit(c, 'webhook', 300)) {
    return c.json({ error: 'Too many requests' }, 429)
  }
  if (inboundWebhookConfigMissing().length > 0) {
    return c.json({ error: 'Inbound finance webhook is not configured' }, 503)
  }

  const rawBody = await c.req.text()
  const svixId = c.req.header('svix-id') ?? ''
  const svixTimestamp = c.req.header('svix-timestamp') ?? ''
  const svixSignature = c.req.header('svix-signature') ?? ''
  if (!svixId || !svixTimestamp || !svixSignature) {
    return c.json({ error: 'Invalid webhook signature' }, 401)
  }

  try {
    const result = await processFinanceInboundWebhook({
      rawBody,
      svixId,
      svixTimestamp,
      svixSignature,
    })
    return c.json({ received: true, ...result })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Inbound processing failed'
    if (message.toLowerCase().includes('webhook') || message.toLowerCase().includes('signature')) {
      return c.json({ error: 'Invalid webhook signature' }, 401)
    }
    console.error('[finance-inbound]', message)
    return c.json({ error: 'Failed to process inbound email' }, 500)
  }
})
