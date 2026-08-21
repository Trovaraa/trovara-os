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
import { hasPermission, requirePermission } from '../lib/rbac.js'
import { SESSION_COOKIE, getUserFromSession } from '../lib/session.js'
import {
  getWhatsAppConfig,
  isWhatsAppConfigured,
  isWhatsAppCustomerConfigured,
  renderTemplate,
  sendWhatsAppText,
} from '../lib/whatsapp-meta.js'
import { notifyOwner, relayFreeFormEnglish } from '../lib/farm-notify.js'
import { logAudit } from '../lib/audit.js'
import { logSecurityEvent } from '../lib/security-log.js'
import { checkRateLimit } from '../lib/rate-limit.js'
import { isAllowedWhatsAppRecipient } from '../lib/whatsapp-recipients.js'
import { secureCompare } from '../lib/secure-compare.js'
import { clientIpFromHeaders } from '../lib/client-ip.js'

const templatesPath = join(dirname(fileURLToPath(import.meta.url)), '../../../whatsapp/templates.json')

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production'
}

async function canConfigureWhatsAppInProduction(c: Context): Promise<boolean> {
  if (!isProduction()) return true
  const token = getCookie(c, SESSION_COOKIE)
  const user = await getUserFromSession(token)
  return Boolean(user && hasPermission(user, 'whatsapp.configure'))
}

export const whatsappRoutes = new Hono<{ Variables: AppVariables }>()

/** Meta webhook verification + inbound messages (no session auth) */
whatsappRoutes.get('/webhook', async (c) => {
  // Meta uses one callback URL and verify token for both staff and customer
  // numbers. A customer-only deployment must still be able to verify the URL.
  const config = getWhatsAppConfig('staff') ?? getWhatsAppConfig('customer')
  if (!config) {
    return c.json({ error: 'WhatsApp not configured' }, 501)
  }

  const mode = c.req.query('hub.mode')
  const token = c.req.query('hub.verify_token')
  const challenge = c.req.query('hub.challenge')

  if (
    mode === 'subscribe' &&
    token &&
    secureCompare(token, config.verifyToken) &&
    challenge
  ) {
    return c.text(challenge)
  }
  logSecurityEvent('invalid_webhook_signature', {
    provider: 'whatsapp',
    reason: 'verify_token_mismatch',
    mode,
    ip: clientIpFromHeaders((name) => c.req.header(name)),
  })
  return c.json({ error: 'Verification failed' }, 403)
})

/**
 * Verify Meta's X-Hub-Signature-256 header (HMAC-SHA256 of the raw body with the
 * app secret). Enforced whenever META_APP_SECRET is set - always set it in
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

function extractWebhookPhoneNumberId(payload: unknown): string | undefined {
  const body = payload as {
    entry?: { changes?: { value?: { metadata?: { phone_number_id?: string } } }[] }[]
  }
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const id = change.value?.metadata?.phone_number_id?.trim()
      if (id) return id
    }
  }
  return undefined
}

whatsappRoutes.post('/webhook', async (c) => {
  if (!isWhatsAppConfigured() && !isWhatsAppCustomerConfigured()) {
    return c.json({ error: 'WhatsApp not configured' }, 501)
  }

  const raw = await c.req.text()
  if (!verifyMetaSignature(raw, c.req.header('x-hub-signature-256'))) {
    logSecurityEvent('invalid_webhook_signature', {
      provider: 'whatsapp',
      reason: 'invalid_hmac',
      ip: clientIpFromHeaders((name) => c.req.header(name)),
    })
    return c.json({ error: 'Invalid signature' }, 401)
  }

  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return c.json({ error: 'Invalid payload' }, 400)
  }

  const phoneNumberId = extractWebhookPhoneNumberId(body)
  const customerPhoneNumberId = process.env.WHATSAPP_CUSTOMER_PHONE_NUMBER_ID?.trim()
  if (customerPhoneNumberId && phoneNumberId === customerPhoneNumberId) {
    const { handleInboundCustomerWhatsApp } = await import('../lib/whatsapp-customer-inbound.js')
    const result = await handleInboundCustomerWhatsApp(body)
    return c.json({ ok: true, ...result })
  }

  const { handleInboundWhatsApp } = await import('../lib/whatsapp-inbound.js')
  const result = await handleInboundWhatsApp(body)
  return c.json({ ok: true, ...result })
})

whatsappRoutes.get('/status', async (c) => {
  if (!(await canConfigureWhatsAppInProduction(c))) {
    return c.json({ ok: true })
  }
  return c.json({
    configured: isWhatsAppConfigured(),
    customerConfigured: isWhatsAppCustomerConfigured(),
    hint: isWhatsAppConfigured()
      ? 'Ready to send via Meta Cloud API'
      : 'Set WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_VERIFY_TOKEN - see docs/INTEGRATIONS.md',
    customerHint: isWhatsAppCustomerConfigured()
      ? 'Customer order bot ready on the Meta WhatsApp Cloud API.'
      : 'Set WHATSAPP_CUSTOMER_PHONE_NUMBER_ID plus a customer or shared access token and WHATSAPP_VERIFY_TOKEN.',
  })
})

whatsappRoutes.get('/templates', async (c) => {
  if (!(await canConfigureWhatsAppInProduction(c))) {
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

const sendSchema = z
  .object({
    to: z.string().min(8).max(20),
    templateId: z.string().min(1).optional(),
    /** Free-form message body - requires whatsapp.configure; bypasses template allowlist when combined with overrideAllowlist. */
    text: z.string().min(1).max(1000).optional(),
    overrideAllowlist: z.boolean().optional(),
    lang: z.enum(['en', 'yo', 'pcm', 'fr']).default('en'),
    variables: z.record(z.string()).default({}),
  })
  .refine((v) => Boolean(v.templateId?.trim() || v.text?.trim()), {
    message: 'Provide templateId or text',
  })

whatsappRoutes.use('/send', authMiddleware)
whatsappRoutes.post(
  '/send',
  async (c, next) => {
    try {
      requirePermission(c.get('user'), 'whatsapp.send')
    } catch {
      return c.json({ error: 'Forbidden' }, 403)
    }
    await next()
  },
  zValidator('json', sendSchema),
  async (c) => {
  const user = c.get('user')

  const { allowed, retryAfterSec } = checkRateLimit(
    `whatsapp-send:${user.id}`,
    20,
    60 * 60 * 1000,
  )
  if (!allowed) {
    return c.json(
      { error: `WhatsApp send rate limit exceeded - retry in ${retryAfterSec}s.` },
      429,
    )
  }

  if (!isWhatsAppConfigured()) {
    return c.json(
      {
        error: 'WhatsApp not configured',
        hint: 'Add Meta credentials to .env - see docs/INTEGRATIONS.md',
      },
      501,
    )
  }

  const body = c.req.valid('json')

  let messageText: string
  let usedTemplateId: string | null = null

  if (body.text?.trim()) {
    if (!hasPermission(user, 'whatsapp.configure')) {
      return c.json({ error: 'Free-form WhatsApp messages require whatsapp.configure' }, 403)
    }
    messageText = body.text.trim()
  } else {
    const rendered = renderTemplate(body.templateId!, body.lang, body.variables)
    if (!rendered) return c.json({ error: 'Unknown template' }, 400)
    messageText = rendered
    usedTemplateId = body.templateId!
  }

  const onAllowlist = await isAllowedWhatsAppRecipient(user.farmId, body.to)
  const canBypassAllowlist =
    hasPermission(user, 'whatsapp.configure') && Boolean(body.overrideAllowlist)
  if (!onAllowlist && !canBypassAllowlist) {
    logSecurityEvent('whatsapp_recipient_blocked', {
      farmId: user.farmId,
      userId: user.id,
      to: body.to,
    })
    return c.json(
      {
        error:
          'Recipient phone is not on this farm’s staff or customer contact list. Users with whatsapp.configure may send free-form with overrideAllowlist.',
      },
      403,
    )
  }

  try {
    const result = await sendWhatsAppText(body.to, messageText)
    await logAudit({
      farmId: user.farmId,
      userId: user.id,
      action: canBypassAllowlist ? 'whatsapp_send_override' : 'whatsapp_send',
      entityType: 'whatsapp_message',
      metadata: {
        to: body.to,
        templateId: usedTemplateId,
        freeForm: Boolean(body.text?.trim()),
        allowlistOverride: canBypassAllowlist,
        messageId: result.messageId,
      },
    })
    return c.json({ ok: true, messageId: result.messageId, preview: messageText })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Send failed'
    return c.json({ error: message }, 502)
  }
})

const notifyOwnerSchema = z.object({
  message: z.string().min(3).max(1000),
  reason: z.string().max(80).optional(),
  /**
   * Opt in to relaying `message` into each owner's preferred_locale. Only set it
   * when the body really is English - the relay treats its input as canonical
   * English, so a French body declared English gets run through the translator
   * on its way to a French reader.
   */
  localizeFromEnglish: z.boolean().default(false),
})

whatsappRoutes.use('/notify-owner', authMiddleware)
whatsappRoutes.post('/notify-owner', zValidator('json', notifyOwnerSchema), async (c) => {
  const user = c.get('user')
  try {
    requirePermission(user, 'whatsapp.send')
  } catch {
    return c.json({ error: 'Forbidden' }, 403)
  }

  if (!isWhatsAppConfigured()) {
    return c.json({ error: 'WhatsApp not configured', hint: 'Add Meta credentials to .env' }, 501)
  }

  const body = c.req.valid('json')

  // Verbatim by default. Unlike the proactive alerts, this body is free text a
  // colleague typed for a person they know: they already chose the language,
  // nothing here declares which language that was, and a message whose exact
  // wording is the point ("tell him ₦40k, not ₦45k") is worse off machine-
  // translated. Senders who know they wrote English can opt in and get the
  // relay's per-locale rendering, which falls back to the English source when a
  // translation fails.
  const message = body.localizeFromEnglish
    ? relayFreeFormEnglish(body.message, user.farmId)
    : body.message

  const result = await notifyOwner(user.farmId, message, {
    actorUserId: user.id,
    reason: body.reason ?? 'manual',
  })
  return c.json({ ok: true, ...result })
})
