import type { Context } from 'hono'
import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { getCookie } from 'hono/cookie'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { requireRole } from '../lib/rbac.js'
import { SESSION_COOKIE, getUserFromSession } from '../lib/session.js'
import {
  deleteTelegramWebhook,
  isTelegramConfigured,
  setTelegramWebhook,
} from '../lib/telegram.js'
import { handleTelegramWebhook } from '../lib/telegram-inbound.js'
import { logSecurityEvent } from '../lib/security-log.js'

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production'
}

async function isOwnerInProduction(c: Context): Promise<boolean> {
  if (!isProduction()) return true
  const token = getCookie(c, SESSION_COOKIE)
  const user = await getUserFromSession(token)
  return user?.role === 'owner'
}

export const telegramRoutes = new Hono<{ Variables: AppVariables }>()

telegramRoutes.get('/status', async (c) => {
  if (!(await isOwnerInProduction(c))) {
    return c.json({ ok: true })
  }
  return c.json({
    configured: isTelegramConfigured('staff'),
    customerConfigured: isTelegramConfigured('customer'),
    mode: process.env.TELEGRAM_MODE ?? 'polling',
    hint: isTelegramConfigured('staff')
      ? 'Staff butler connected. In polling mode it works without a public URL.'
      : 'Create a bot with @BotFather and set TELEGRAM_BOT_TOKEN - see docs/TELEGRAM-COPILOT.md',
    customerHint: isTelegramConfigured('customer')
      ? 'Customer order bot connected.'
      : 'Create a second @BotFather bot and set TELEGRAM_CUSTOMER_BOT_TOKEN',
  })
})

/**
 * Verify a Telegram webhook request against the per-bot secret token. In
 * production the secret is mandatory (otherwise anyone who finds the URL can
 * forge updates); in dev it's optional.
 */
function verifyTelegramWebhook(
  c: Context,
  kind: 'staff' | 'customer',
): { ok: true } | { ok: false; status: 401 | 503 } {
  const secret = (
    kind === 'customer'
      ? process.env.TELEGRAM_CUSTOMER_WEBHOOK_SECRET
      : process.env.TELEGRAM_WEBHOOK_SECRET
  )?.trim()

  if (isProduction() && !secret) return { ok: false, status: 503 }

  if (secret && c.req.header('x-telegram-bot-api-secret-token') !== secret) {
    logSecurityEvent('invalid_webhook_signature', {
      provider: 'telegram',
      reason: 'invalid_secret_token',
      ip: c.req.header('x-forwarded-for') ?? 'local',
    })
    return { ok: false, status: 401 }
  }
  return { ok: true }
}

/** Staff butler webhook for production / ngrok mode. Telegram POSTs updates here. */
telegramRoutes.post('/webhook', async (c) => {
  if (!isTelegramConfigured('staff')) return c.json({ error: 'Telegram not configured' }, 501)

  const check = verifyTelegramWebhook(c, 'staff')
  if (!check.ok) {
    return c.json(
      { error: check.status === 503 ? 'Telegram webhook secret not configured' : 'Invalid secret token' },
      check.status,
    )
  }

  const body = await c.req.json().catch(() => null)
  if (!body) return c.json({ error: 'Invalid payload' }, 400)
  const result = await handleTelegramWebhook(body)
  return c.json({ ok: true, ...result })
})

/** Customer order bot webhook (separate bot/token from the staff butler). */
telegramRoutes.post('/customer/webhook', async (c) => {
  if (!isTelegramConfigured('customer')) {
    return c.json({ error: 'Customer Telegram bot not configured' }, 501)
  }

  const check = verifyTelegramWebhook(c, 'customer')
  if (!check.ok) {
    return c.json(
      { error: check.status === 503 ? 'Telegram webhook secret not configured' : 'Invalid secret token' },
      check.status,
    )
  }

  const body = await c.req.json().catch(() => null)
  if (!body) return c.json({ error: 'Invalid payload' }, 400)
  const { handleCustomerTelegramUpdate } = await import('../lib/customer-telegram-inbound.js')
  await handleCustomerTelegramUpdate(body)
  return c.json({ ok: true, handled: 1 })
})

const setWebhookSchema = z.object({
  url: z.string().url(),
  bot: z.enum(['staff', 'customer']).default('staff'),
})

telegramRoutes.use('/set-webhook', authMiddleware)
telegramRoutes.post('/set-webhook', zValidator('json', setWebhookSchema), async (c) => {
  const user = c.get('user')
  try {
    requireRole(user, 'owner')
  } catch {
    return c.json({ error: 'Forbidden' }, 403)
  }
  const { url, bot } = c.req.valid('json')
  if (!isTelegramConfigured(bot)) return c.json({ error: 'Telegram not configured' }, 501)

  try {
    await setTelegramWebhook(url, bot)
    return c.json({ ok: true, url, bot })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'setWebhook failed' }, 502)
  }
})

const deleteWebhookSchema = z.object({ bot: z.enum(['staff', 'customer']).default('staff') })

telegramRoutes.use('/delete-webhook', authMiddleware)
telegramRoutes.post('/delete-webhook', zValidator('json', deleteWebhookSchema), async (c) => {
  const user = c.get('user')
  try {
    requireRole(user, 'owner')
  } catch {
    return c.json({ error: 'Forbidden' }, 403)
  }
  const { bot } = c.req.valid('json')
  if (!isTelegramConfigured(bot)) return c.json({ error: 'Telegram not configured' }, 501)
  await deleteTelegramWebhook(bot)
  return c.json({ ok: true, bot })
})
