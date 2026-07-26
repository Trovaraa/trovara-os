import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, unknown>

let sessionUser: Row = {
  id: 'user-supervisor',
  farmId: 'farm-1',
  role: 'supervisor',
  email: 's@t.farm',
}

let notifyRecipientRows: Row[] = []

vi.mock('../db/index.js', () => ({
  db: {
    select: () => {
      const load = async () => notifyRecipientRows
      return {
        from: () => ({
          where: () => Object.assign(load(), { orderBy: load }),
        }),
      }
    },
  },
}))

vi.mock('../middleware/auth.js', () => ({
  authMiddleware: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set('user', sessionUser)
    await next()
  },
}))

const sendWhatsAppText = vi.fn(async (to: string, _body: string) => ({ messageId: `wa-${to}` }))
const isWhatsAppConfigured = vi.fn(() => true)
const toViewerLocale = vi.fn(
  async (args: { english: string; targetLocale?: string | null }) =>
    args.targetLocale && args.targetLocale !== 'en'
      ? `[${args.targetLocale}] ${args.english}`
      : args.english,
)

vi.mock('../lib/whatsapp-meta.js', () => ({
  getWhatsAppConfig: () => null,
  isWhatsAppConfigured: () => isWhatsAppConfigured(),
  isWhatsAppCustomerConfigured: () => false,
  renderTemplate: () => '',
  sendWhatsAppText: (to: string, body: string) => sendWhatsAppText(to, body),
}))

vi.mock('../lib/telegram.js', () => ({
  sendTelegramMessage: vi.fn(),
}))

vi.mock('../lib/farm-events.js', () => ({
  recordFarmEvent: vi.fn(async () => undefined),
}))

vi.mock('../lib/content-locale.js', () => ({
  toViewerLocale: (args: { english: string; targetLocale?: string | null; farmId: string }) =>
    toViewerLocale(args),
}))

vi.mock('../lib/audit.js', () => ({
  logAudit: vi.fn(async () => undefined),
}))

vi.mock('../lib/security-log.js', () => ({
  logSecurityEvent: vi.fn(async () => undefined),
}))

vi.mock('../lib/rate-limit.js', () => ({
  checkRateLimit: vi.fn(() => ({ allowed: true, retryAfterSec: 0 })),
}))

vi.mock('../lib/whatsapp-recipients.js', () => ({
  isAllowedWhatsAppRecipient: vi.fn(async () => true),
}))

vi.mock('../lib/session.js', () => ({
  SESSION_COOKIE: 'trovara_session',
  getUserFromSession: vi.fn(async () => null),
}))

function owners(...locales: string[]): Row[] {
  return locales.map((preferredLocale, i) => ({
    id: `u${i + 1}`,
    phone: `+23480000000${i + 1}`,
    preferredLocale,
  }))
}

function sentBodies(): string[] {
  return sendWhatsAppText.mock.calls.map(([, body]) => body)
}

async function notifyOwner(
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const { whatsappRoutes } = await import('./whatsapp.js')
  const app = new Hono()
  app.route('/whatsapp', whatsappRoutes)
  const res = await app.request('/whatsapp/notify-owner', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

beforeEach(() => {
  vi.clearAllMocks()
  sessionUser = {
    id: 'user-supervisor',
    farmId: 'farm-1',
    role: 'supervisor',
    email: 's@t.farm',
  }
  notifyRecipientRows = owners('en', 'fr')
  isWhatsAppConfigured.mockReturnValue(true)
  toViewerLocale.mockImplementation(async (args) =>
    args.targetLocale && args.targetLocale !== 'en'
      ? `[${args.targetLocale}] ${args.english}`
      : args.english,
  )
})

describe('POST /whatsapp/notify-owner - free-form body', () => {
  /**
   * Human-typed notify-owner bodies stay verbatim by default. The sender already
   * chose the language for a person they know; nothing on the request declares
   * that language, and exact wording ("tell him ₦40k, not ₦45k") is worse after
   * a machine rewrite. Opt in with localizeFromEnglish only when the body is
   * known-English and should go through relayFreeFormEnglish.
   */
  it('sends the typed body verbatim to every owner by default', async () => {
    const typed = 'Tell am say ₦40k, not ₦45k — e go pay today'
    const { status, json } = await notifyOwner({ message: typed })

    expect(status).toBe(200)
    expect(json.notified).toBe(2)
    expect(sentBodies()).toEqual([typed, typed])
    expect(toViewerLocale).not.toHaveBeenCalled()
  })

  it('does not rewrite a French body when localizeFromEnglish is off', async () => {
    const french = 'Dis-lui ₦40k, pas ₦45k'
    await notifyOwner({ message: french })

    expect(sentBodies()).toEqual([french, french])
    expect(toViewerLocale).not.toHaveBeenCalled()
  })

  it('relays known-English through relayFreeFormEnglish when opted in', async () => {
    const english = 'Low stock on layer feed — reorder today'
    const { json } = await notifyOwner({
      message: english,
      localizeFromEnglish: true,
    })

    expect(json.notified).toBe(2)
    expect(sentBodies()).toEqual([english, `[fr] ${english}`])
    expect(toViewerLocale).toHaveBeenCalledTimes(1)
    expect(toViewerLocale).toHaveBeenCalledWith(
      expect.objectContaining({ english, targetLocale: 'fr', farmId: 'farm-1' }),
    )
  })

  it('keeps the English source when a relay translation fails', async () => {
    toViewerLocale.mockRejectedValueOnce(new Error('llm down'))
    const english = 'Pen B flooded this morning'

    await notifyOwner({ message: english, localizeFromEnglish: true })

    expect(sentBodies()).toEqual([english, english])
  })

  it('returns 501 when WhatsApp is not configured', async () => {
    isWhatsAppConfigured.mockReturnValue(false)
    const { status } = await notifyOwner({ message: 'Hello owner' })
    expect(status).toBe(501)
  })

  it('returns 403 for field workers', async () => {
    sessionUser = { ...sessionUser, role: 'field_worker' }
    const { status } = await notifyOwner({ message: 'Hello owner' })
    expect(status).toBe(403)
  })
})
