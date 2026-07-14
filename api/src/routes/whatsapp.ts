import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Context } from 'hono'
import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { requireRole } from '../lib/rbac.js'
import { SESSION_COOKIE, getUserFromSession } from '../lib/session.js'
import {
  getWhatsAppConfig,
  isWhatsAppConfigured,
  renderTemplate,
  sendWhatsAppText,
} from '../lib/whatsapp-meta.js'
import { notifyOwner } from '../lib/farm-notify.js'
import { logAudit } from '../lib/audit.js'
import { logSecurityEvent } from '../lib/security-log.js'

const templatesPath = join(dirname(fileURLToPath(import.meta.url)), '../../../whatsapp/templates.json')

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production'
}

async function isOwnerInProduction(c: Context): Promise<boolean> {
  if (!isProduction()) return true
  const token = getCookie(c, SESSION_COOKIE)
  const user = await getUserFromSession(token)
  return user?.role === 'owner'
}

export const whatsappRoutes = new Hono<{ Variables: AppVariables }>()

/** Meta webhook verification + inbound messages (no session auth) */
whatsappRoutes.get('/webhook', (c) => {
  const config = getWhatsAppConfig()
  if (!config) {
    return c.json({ error: 'WhatsApp not configured' }, 501)
  }

  const mode = c.req.query('hub.mode')
  const token = c.req.query('hub.verify_token')
  const challenge = c.req.query('hub.challenge')

  if (mode === 'subscribe' && token === config.verifyToken && challenge) {
    return c.text(challenge)
  }
  logSecurityEvent('invalid_webhook_signature', {
    provider: 'whatsapp',
    reason: 'verify_token_mismatch',
    mode,
    ip: c.req.header('x-forwarded-for') ?? 'local',
  })
  return c.json({ error: 'Verification failed' }, 403)
})

/**
 * Verify Meta's X-Hub-Signature-256 header (HMAC-SHA256 of the raw body with the
 * app secret). Enforced whenever META_APP_SECRET is set — always set it in
 * production, or anyone who discovers the URL can forge inbound messages.
 */
function verifyMetaSignature(rawBody: string, header: string | undefined): boolean {
  const secret = process.env.META_APP_SECRET?.trim()
  if (!secret) {
    return process.env.NODE_ENV !== 'production'
  }

  if (!header?.startsWith('sha256=')) return false
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')
  const given = header.slice('sha256='.length)
  const a = Buffer.from(expected, 'hex')
  const b = Buffer.from(given, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

whatsappRoutes.post('/webhook', async (c) => {
  if (!isWhatsAppConfigured()) {
    return c.json({ error: 'WhatsApp not configured' }, 501)
  }

  const raw = await c.req.text()
  if (!verifyMetaSignature(raw, c.req.header('x-hub-signature-256'))) {
    logSecurityEvent('invalid_webhook_signature', {
      provider: 'whatsapp',
      reason: 'invalid_hmac',
      ip: c.req.header('x-forwarded-for') ?? 'local',
    })
    return c.json({ error: 'Invalid signature' }, 401)
  }

  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return c.json({ error: 'Invalid payload' }, 400)
  }

  const { handleInboundWhatsApp } = await import('../lib/whatsapp-inbound.js')
  const result = await handleInboundWhatsApp(body)
  return c.json({ ok: true, ...result })
})

whatsappRoutes.get('/status', async (c) => {
  if (!(await isOwnerInProduction(c))) {
    return c.json({ ok: true })
  }
  return c.json({
    configured: isWhatsAppConfigured(),
    hint: isWhatsAppConfigured()
      ? 'Ready to send via Meta Cloud API'
      : 'Set WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_VERIFY_TOKEN — see docs/INTEGRATIONS.md',
  })
})

whatsappRoutes.get('/templates', async (c) => {
  if (!(await isOwnerInProduction(c))) {
    return c.json({ ok: true })
  }

  if (!existsSync(templatesPath)) {
    return c.json({ templates: [], source: 'whatsapp/templates.json', configured: false })
  }

  try {
    const raw = readFileSync(templatesPath, 'utf-8')
    const parsed = JSON.parse(raw) as { templates?: unknown[] }
    return c.json({
      templates: parsed.templates ?? [],
      source: 'whatsapp/templates.json',
      configured: isWhatsAppConfigured(),
    })
  } catch {
    return c.json({ error: 'Failed to parse templates.json' }, 500)
  }
})

const sendSchema = z.object({
  to: z.string().min(8).max(20),
  templateId: z.string().min(1),
  lang: z.enum(['en', 'yo', 'pcm']).default('en'),
  variables: z.record(z.string()).default({}),
})

whatsappRoutes.use('/send', authMiddleware)
whatsappRoutes.post('/send', zValidator('json', sendSchema), async (c) => {
  const user = c.get('user')
  try {
    requireRole(user, 'owner', 'supervisor')
  } catch {
    return c.json({ error: 'Forbidden' }, 403)
  }

  if (!isWhatsAppConfigured()) {
    return c.json(
      {
        error: 'WhatsApp not configured',
        hint: 'Add Meta credentials to .env — see docs/INTEGRATIONS.md',
      },
      501,
    )
  }

  const body = c.req.valid('json')
  const text = renderTemplate(body.templateId, body.lang, body.variables)
  if (!text) return c.json({ error: 'Unknown template' }, 400)

  try {
    const result = await sendWhatsAppText(body.to, text)
    await logAudit({
      farmId: user.farmId,
      userId: user.id,
      action: 'whatsapp_send',
      entityType: 'whatsapp_message',
      metadata: { to: body.to, templateId: body.templateId, messageId: result.messageId },
    })
    return c.json({ ok: true, messageId: result.messageId, preview: text })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Send failed'
    return c.json({ error: message }, 502)
  }
})

const notifyOwnerSchema = z.object({
  message: z.string().min(3).max(1000),
  reason: z.string().max(80).optional(),
})

whatsappRoutes.use('/notify-owner', authMiddleware)
whatsappRoutes.post('/notify-owner', zValidator('json', notifyOwnerSchema), async (c) => {
  const user = c.get('user')
  try {
    requireRole(user, 'owner', 'supervisor')
  } catch {
    return c.json({ error: 'Forbidden' }, 403)
  }

  if (!isWhatsAppConfigured()) {
    return c.json({ error: 'WhatsApp not configured', hint: 'Add Meta credentials to .env' }, 501)
  }

  const body = c.req.valid('json')
  const result = await notifyOwner(user.farmId, body.message, {
    actorUserId: user.id,
    reason: body.reason ?? 'manual',
  })
  return c.json({ ok: true, ...result })
})
