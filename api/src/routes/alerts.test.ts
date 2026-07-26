import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProactiveAlert } from '../lib/proactive-alerts.js'

type Row = Record<string, unknown>

/** The id owners used to receive in place of the name, verbatim from the bug report. */
const FARM_ID = '3f7c1e8a-9b2d-4c6f-8a10-5e7d2b4c9f01'
const FARM_NAME = 'Ola Poultry'

let farmRows: Row[] = []
let farmLookupError: Error | null = null
let notifyRecipientRows: Row[] = []
let criticalRecipientRows: Row[] = []
let telegramLinkRows: Row[] = []

/**
 * Route the fake query by the columns it selects: `{ name }` is the farms
 * lookup, anything with `email` is the critical-alert owner list, anything with
 * `id` is a notify fan-out, and a bare `select()` reads telegram_link rows.
 */
function rowsFor(columns?: Record<string, unknown>): Row[] {
  const keys = Object.keys(columns ?? {})
  if (keys.length === 0) return telegramLinkRows
  if (keys.includes('name')) {
    if (farmLookupError) throw farmLookupError
    return farmRows
  }
  if (keys.includes('email')) return criticalRecipientRows
  return notifyRecipientRows
}

type Rows = Promise<Row[]>
type Builder = {
  from: () => Builder
  leftJoin: () => Builder
  where: () => Rows & { limit: () => Rows; orderBy: () => Rows }
  limit: () => Rows
  orderBy: () => Rows
}

vi.mock('../db/index.js', () => ({
  db: {
    select: (columns?: Record<string, unknown>) => {
      const load = async () => rowsFor(columns)
      // where() must be thenable (notify fan-out awaits it) and also expose
      // .limit() (farm-name lookup). Do not call load() until something awaits
      // or calls .limit — otherwise a throw becomes an orphan rejection.
      const afterWhere = () =>
        ({
          then: (resolve: (rows: Row[]) => unknown, reject?: (err: unknown) => unknown) =>
            load().then(resolve, reject),
          catch: (reject: (err: unknown) => unknown) => load().catch(reject),
          limit: load,
          orderBy: load,
        }) as Rows & { limit: () => Rows; orderBy: () => Rows }
      const builder: Builder = {
        from: () => builder,
        leftJoin: () => builder,
        where: afterWhere,
        limit: load,
        orderBy: load,
      }
      return builder
    },
  },
}))

let sessionUser: Row = { id: 'user-owner', farmId: FARM_ID, role: 'owner', email: 'o@t.farm' }

vi.mock('../middleware/auth.js', () => ({
  authMiddleware: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set('user', sessionUser)
    await next()
  },
}))

// Only the DB-backed scan is faked; renderProactiveAlertPush stays real, since
// the language an owner reads is exactly what these tests are about.
vi.mock('../lib/proactive-alerts.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/proactive-alerts.js')>()),
  checkProactiveAlerts: vi.fn(async () => [] as ProactiveAlert[]),
}))

vi.mock('../lib/advisory-engine.js', () => ({
  runAdvisoryEngine: vi.fn(async () => ({ created: 0 })),
}))

vi.mock('../lib/exceptions.js', () => ({
  gatherExceptions: vi.fn(),
}))

vi.mock('../lib/notifications.js', () => ({
  deliverCriticalAlert: vi.fn(async () => [
    { channel: 'email', status: 'delivered', required: false },
    { channel: 'sms', status: 'delivered', required: false },
  ]),
}))

const sendWhatsAppText = vi.fn(async (to: string, _body: string) => ({ messageId: `wa-${to}` }))
const sendTelegramMessage = vi.fn(async (_chatId: number, _text: string, _opts?: unknown) => undefined)
const toViewerLocale = vi.fn(async (args: { english: string }) => args.english)

vi.mock('../lib/whatsapp-meta.js', () => ({
  isWhatsAppConfigured: () => true,
  sendWhatsAppText: (to: string, body: string) => sendWhatsAppText(to, body),
}))

vi.mock('../lib/telegram.js', () => ({
  sendTelegramMessage: (chatId: number, text: string, opts?: unknown) =>
    sendTelegramMessage(chatId, text, opts),
}))

vi.mock('../lib/farm-events.js', () => ({
  recordFarmEvent: vi.fn(async () => undefined),
}))

vi.mock('../lib/content-locale.js', () => ({
  toViewerLocale: (args: { english: string }) => toViewerLocale(args),
}))

const { checkProactiveAlerts } = await import('../lib/proactive-alerts.js')
const { deliverCriticalAlert } = await import('../lib/notifications.js')
const { gatherExceptions } = await import('../lib/exceptions.js')

const mockCheckAlerts = vi.mocked(checkProactiveAlerts)
const mockDeliverCritical = vi.mocked(deliverCriticalAlert)
const mockGatherExceptions = vi.mocked(gatherExceptions)

const EMPTY_SUMMARY = {
  overdueTasks: 0,
  lowStock: 0,
  pendingApprovals: 0,
  mortalityToday: 0,
  ordersPending: 0,
  rejectedTasks: 0,
  assetLogsMissing: 0,
  assetVerificationPending: 0,
  censusMissing: 0,
  censusRejected: 0,
  censusStale: 0,
  weatherAlerts: 0,
  total: 0,
}

const LOW_STOCK: ProactiveAlert = {
  type: 'low_stock',
  severity: 'high',
  title: 'Low stock items',
  message: '3 inventory item(s) are at or below reorder level.',
  count: 3,
}

const OVERDUE: ProactiveAlert = {
  type: 'overdue_tasks',
  severity: 'medium',
  title: 'Overdue tasks',
  message: '2 task(s) are overdue and not completed.',
  count: 2,
}

function owners(...locales: string[]): Row[] {
  return locales.map((preferredLocale, i) => ({
    id: `u${i + 1}`,
    phone: `+23480000000${i + 1}`,
    preferredLocale,
  }))
}

function criticalOwners(...locales: string[]): Row[] {
  return locales.map((preferredLocale, i) => ({
    email: `owner${i + 1}@trovara.farm`,
    phone: `+23480000000${i + 1}`,
    preferredLocale,
  }))
}

/** WhatsApp bodies pushed to owners, in send order. */
function sentBodies(): string[] {
  return sendWhatsAppText.mock.calls.map(([, body]) => body)
}

function criticalSubjects(): string[] {
  return mockDeliverCritical.mock.calls.map(([, subject]) => subject)
}

function criticalMessages(): string[] {
  return mockDeliverCritical.mock.calls.map(([, , message]) => message)
}

type ProactiveBody = {
  ok?: boolean
  notified?: { owner: { telegram: number; whatsapp: number; email: number; sms: number } }
}

async function runProactive(): Promise<{ status: number; body: ProactiveBody }> {
  const { alertsRoutes } = await import('./alerts.js')
  const app = new Hono()
  app.route('/alerts', alertsRoutes)
  const res = await app.request('/alerts/run-proactive', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
  return { status: res.status, body: (await res.json()) as ProactiveBody }
}

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env.CRON_SECRET
  sessionUser = { id: 'user-owner', farmId: FARM_ID, role: 'owner', email: 'o@t.farm' }
  farmRows = [{ name: FARM_NAME }]
  farmLookupError = null
  notifyRecipientRows = owners('en')
  criticalRecipientRows = []
  telegramLinkRows = []
  mockCheckAlerts.mockResolvedValue([])
  mockGatherExceptions.mockResolvedValue({
    summary: EMPTY_SUMMARY,
    exceptions: [],
    actionList: [],
  })
  mockDeliverCritical.mockResolvedValue([
    { channel: 'email', status: 'delivered', required: false },
    { channel: 'sms', status: 'delivered', required: false },
  ])
})

describe('POST /alerts/run-proactive - farm name, not farm id', () => {
  it('names the farm in the all-clear push', async () => {
    const { status } = await runProactive()

    expect(status).toBe(200)
    expect(sentBodies()).toEqual([`✅ Proactive check (${FARM_NAME}): no urgent issues detected.`])
    expect(sentBodies()[0]).not.toContain(FARM_ID)
  })

  it('names the farm in the alert push', async () => {
    mockCheckAlerts.mockResolvedValue([LOW_STOCK, OVERDUE])

    await runProactive()

    expect(sentBodies()[0]).toContain(`⚠️ Proactive alerts for ${FARM_NAME}:`)
    expect(sentBodies()[0]).not.toContain(FARM_ID)
  })

  it('names the farm in the critical message and the critical subject line', async () => {
    mockCheckAlerts.mockResolvedValue([LOW_STOCK, OVERDUE])
    criticalRecipientRows = criticalOwners('en')

    await runProactive()

    expect(criticalSubjects()).toEqual([`Critical Trovara alert (${FARM_NAME})`])
    expect(criticalMessages()[0]).toContain(`⚠️ Proactive alerts for ${FARM_NAME}:`)
    expect(criticalSubjects()[0]).not.toContain(FARM_ID)
    expect(criticalMessages()[0]).not.toContain(FARM_ID)
  })

  it('sends only the high-severity alerts on the critical path', async () => {
    mockCheckAlerts.mockResolvedValue([LOW_STOCK, OVERDUE])
    criticalRecipientRows = criticalOwners('en')

    await runProactive()

    expect(criticalMessages()[0]).toContain('Low stock items')
    expect(criticalMessages()[0]).not.toContain('Overdue tasks')
  })

  it('names the farm on the Telegram channel too', async () => {
    telegramLinkRows = [{ afterValue: { userId: 'u1', chatId: 501 } }]

    await runProactive()

    expect(sendTelegramMessage.mock.calls.map(([chatId, text]) => [chatId, text])).toEqual([
      [501, `✅ Proactive check (${FARM_NAME}): no urgent issues detected.`],
    ])
  })
})

describe('POST /alerts/run-proactive - per-recipient localization', () => {
  it('gives owners with different preferred_locale each their own language from one call', async () => {
    mockCheckAlerts.mockResolvedValue([LOW_STOCK])
    notifyRecipientRows = owners('en', 'fr', 'yo')

    const { body } = await runProactive()

    expect(body.notified?.owner.whatsapp).toBe(3)
    const [en, fr, yo] = sentBodies()
    expect(en).toContain(`⚠️ Proactive alerts for ${FARM_NAME}:`)
    expect(en).toContain('Low stock items')
    expect(fr).toContain(`⚠️ Alertes proactives pour ${FARM_NAME} :`)
    expect(fr).toContain('Articles en stock faible')
    expect(yo).toContain(`⚠️ Ìkìlọ̀ ìṣáájú fún ${FARM_NAME}:`)
    expect(yo).toContain('Ọjà tó ń tán')
  })

  it('never translates the farm name itself', async () => {
    mockCheckAlerts.mockResolvedValue([LOW_STOCK])
    notifyRecipientRows = owners('fr', 'yo', 'pcm')

    await runProactive()

    for (const body of sentBodies()) expect(body).toContain(FARM_NAME)
  })

  it('gives each critical-alert owner their own language', async () => {
    mockCheckAlerts.mockResolvedValue([LOW_STOCK])
    criticalRecipientRows = criticalOwners('fr', 'en')

    await runProactive()

    expect(mockDeliverCritical).toHaveBeenCalledTimes(2)
    expect(criticalMessages()[0]).toContain(`⚠️ Alertes proactives pour ${FARM_NAME} :`)
    expect(criticalMessages()[1]).toContain(`⚠️ Proactive alerts for ${FARM_NAME}:`)
  })

  it('counts every owner delivery across the per-owner sends', async () => {
    mockCheckAlerts.mockResolvedValue([LOW_STOCK])
    criticalRecipientRows = criticalOwners('fr', 'en')

    const { body } = await runProactive()

    expect(body.notified?.owner).toMatchObject({ email: 2, sms: 2 })
  })

  it('does no translation work for an all-English owner set', async () => {
    mockCheckAlerts.mockResolvedValue([LOW_STOCK])
    notifyRecipientRows = owners('en', 'en')
    criticalRecipientRows = criticalOwners('en')

    await runProactive()

    expect(toViewerLocale).not.toHaveBeenCalled()
    expect(sentBodies()).toHaveLength(2)
  })

  it('does no translation work for a francophone owner either - the copy is a table', async () => {
    mockCheckAlerts.mockResolvedValue([LOW_STOCK])
    notifyRecipientRows = owners('fr')

    await runProactive()

    expect(toViewerLocale).not.toHaveBeenCalled()
  })

  it('reads an unknown preferred_locale as English rather than sending nothing', async () => {
    mockCheckAlerts.mockResolvedValue([LOW_STOCK])
    notifyRecipientRows = owners('de')

    const { body } = await runProactive()

    expect(body.notified?.owner.whatsapp).toBe(1)
    expect(sentBodies()[0]).toContain(`⚠️ Proactive alerts for ${FARM_NAME}:`)
  })
})

describe('POST /alerts/run-proactive - a failed farm-name lookup still sends', () => {
  it('pushes under the fallback name when the farms query throws', async () => {
    mockCheckAlerts.mockResolvedValue([LOW_STOCK])
    farmLookupError = new Error('connection terminated')

    const { status, body } = await runProactive()

    expect(status).toBe(200)
    expect(body.notified?.owner.whatsapp).toBe(1)
    expect(sentBodies()[0]).toContain('⚠️ Proactive alerts for Trovara:')
    expect(sentBodies()[0]).not.toContain(FARM_ID)
  })

  it('still delivers the critical alert when the farms query throws', async () => {
    mockCheckAlerts.mockResolvedValue([LOW_STOCK])
    criticalRecipientRows = criticalOwners('en')
    farmLookupError = new Error('connection terminated')

    const { body } = await runProactive()

    expect(criticalSubjects()).toEqual(['Critical Trovara alert (Trovara)'])
    expect(body.notified?.owner).toMatchObject({ email: 1, sms: 1 })
  })

  it('pushes under the fallback name when the farm row is missing', async () => {
    farmRows = []

    await runProactive()

    expect(sentBodies()).toEqual(['✅ Proactive check (Trovara): no urgent issues detected.'])
  })
})

type DigestBody = {
  ok?: boolean
  notified?: { telegram: number; whatsapp: number }
}

async function runEveningDigest(): Promise<{ status: number; body: DigestBody }> {
  const { alertsRoutes } = await import('./alerts.js')
  const app = new Hono()
  app.route('/alerts', alertsRoutes)
  const res = await app.request('/alerts/evening-digest', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
  return { status: res.status, body: (await res.json()) as DigestBody }
}

describe('POST /alerts/evening-digest - farm name and per-recipient locale', () => {
  it('names the farm and never the farm id', async () => {
    const { status } = await runEveningDigest()

    expect(status).toBe(200)
    expect(sentBodies()).toEqual([
      `🌙 Trovara evening digest — ${FARM_NAME}\n✅ All clear - nothing needs your attention tonight.`,
    ])
    expect(sentBodies()[0]).not.toContain(FARM_ID)
  })

  it('gives owners with different preferred_locale each their own language', async () => {
    mockGatherExceptions.mockResolvedValue({
      summary: { ...EMPTY_SUMMARY, overdueTasks: 2, total: 2 },
      exceptions: [],
      actionList: [],
    })
    notifyRecipientRows = owners('en', 'fr')

    const { body } = await runEveningDigest()

    expect(body.notified?.whatsapp).toBe(2)
    const [en, fr] = sentBodies()
    expect(en).toContain(`🌙 Trovara evening digest — ${FARM_NAME}`)
    expect(en).toContain('- Overdue tasks: 2')
    expect(fr).toContain(`🌙 Résumé du soir Trovara — ${FARM_NAME}`)
    expect(fr).toContain('- Tâches en retard: 2')
    expect(en).not.toContain(FARM_ID)
    expect(fr).not.toContain(FARM_ID)
  })

  it('still sends under the fallback name when the farms query throws', async () => {
    farmLookupError = new Error('connection terminated')

    const { status, body } = await runEveningDigest()

    expect(status).toBe(200)
    expect(body.notified?.whatsapp).toBe(1)
    expect(sentBodies()[0]).toContain('🌙 Trovara evening digest — Trovara')
    expect(sentBodies()[0]).not.toContain(FARM_ID)
  })
})
