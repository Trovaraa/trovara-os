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
    configured: isTelegramConfigured(),
    mode: process.env.TELEGRAM_MODE ?? 'polling',
    hint: isTelegramConfigured()
      ? 'Bot connected. In polling mode it works without a public URL.'
      : 'Create a bot with @BotFather and set TELEGRAM_BOT_TOKEN — see docs/TELEGRAM-COPILOT.md',
  })
})

/** Webhook for production / ngrok mode. Telegram POSTs each update here. */
telegramRoutes.post('/webhook', async (c) => {
  if (!isTelegramConfigured()) return c.json({ error: 'Telegram not configured' }, 501)

  if (isProduction() && !process.env.TELEGRAM_WEBHOOK_SECRET?.trim()) {
    return c.json({ error: 'Telegram webhook secret not configured' }, 503)
  }

  const secret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim()
  if (secret && c.req.header('x-telegram-bot-api-secret-token') !== secret) {
    logSecurityEvent('invalid_webhook_signature', {
      provider: 'telegram',
      reason: 'invalid_secret_token',
      ip: c.req.header('x-forwarded-for') ?? 'local',
    })
    return c.json({ error: 'Invalid secret token' }, 401)
  }

  const body = await c.req.json().catch(() => null)
  if (!body) return c.json({ error: 'Invalid payload' }, 400)
  // Acknowledge fast; process inline (updates are small)
  const result = await handleTelegramWebhook(body)
  return c.json({ ok: true, ...result })
})

const setWebhookSchema = z.object({ url: z.string().url() })

telegramRoutes.use('/set-webhook', authMiddleware)
telegramRoutes.post('/set-webhook', zValidator('json', setWebhookSchema), async (c) => {
  const user = c.get('user')
  try {
    requireRole(user, 'owner')
  } catch {
    return c.json({ error: 'Forbidden' }, 403)
  }
  if (!isTelegramConfigured()) return c.json({ error: 'Telegram not configured' }, 501)

  const { url } = c.req.valid('json')
  try {
    await setTelegramWebhook(url)
    return c.json({ ok: true, url })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'setWebhook failed' }, 502)
  }
})

telegramRoutes.use('/delete-webhook', authMiddleware)
telegramRoutes.post('/delete-webhook', async (c) => {
  const user = c.get('user')
  try {
    requireRole(user, 'owner')
  } catch {
    return c.json({ error: 'Forbidden' }, 403)
  }
  if (!isTelegramConfigured()) return c.json({ error: 'Telegram not configured' }, 501)
  await deleteTelegramWebhook()
  return c.json({ ok: true })
})
