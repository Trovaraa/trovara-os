import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReplyLocale } from './reply-locale.js'

type UserRow = { id: string; phone: string | null; preferredLocale: string }
type LinkRow = { afterValue: { userId: string; chatId: number } }

/** Rows the fake recipient query returns, and the telegram_link rows after it. */
let userRows: UserRow[] = []
let linkRows: LinkRow[] = []
let selectCalls = 0

vi.mock('../db/index.js', () => ({
  db: {
    select: () => {
      selectCalls++
      return {
        from: () => ({
          // Awaiting the builder yields recipients; .orderBy() yields the
          // telegram_link rows, which is the only query that sorts.
          where: () =>
            Object.assign(Promise.resolve(userRows), {
              orderBy: async () => linkRows,
            }),
        }),
      }
    },
  },
}))

const sendWhatsAppText = vi.fn(async (to: string, _body: string) => ({ messageId: `wa-${to}` }))
const sendTelegramMessage = vi.fn(async (_chatId: number, _text: string, _opts?: unknown) => undefined)
const isWhatsAppConfigured = vi.fn(() => true)
const toViewerLocale = vi.fn(
  async (args: { english: string; targetLocale?: string | null; farmId: string }) => args.english,
)

vi.mock('./whatsapp-meta.js', () => ({
  isWhatsAppConfigured: () => isWhatsAppConfigured(),
  sendWhatsAppText: (to: string, body: string) => sendWhatsAppText(to, body),
}))

vi.mock('./telegram.js', () => ({
  sendTelegramMessage: (chatId: number, text: string, opts?: unknown) =>
    sendTelegramMessage(chatId, text, opts),
}))

vi.mock('./farm-events.js', () => ({
  recordFarmEvent: vi.fn(async () => undefined),
}))

vi.mock('./content-locale.js', () => ({
  toViewerLocale: (args: { english: string; targetLocale?: string | null; farmId: string }) =>
    toViewerLocale(args),
}))

const {
  notifyOwner,
  notifyRoles,
  notifyRolesTelegram,
  notifyTaskRejected,
  notifyTaskSubmittedForApproval,
  notifyWorkerClockIn,
  relayFreeFormEnglish,
} = await import('./farm-notify.js')

const FARM = 'farm-1'

const GREETINGS: Record<ReplyLocale, string> = {
  en: 'Good morning',
  fr: 'Bonjour',
  yo: 'Ẹ kú àárọ̀',
  pcm: 'Good morning o',
}

function recipients(...locales: string[]): UserRow[] {
  return locales.map((preferredLocale, i) => ({
    id: `u${i + 1}`,
    phone: `+23480000000${i + 1}`,
    preferredLocale,
  }))
}

/** Text bodies handed to WhatsApp, in send order. */
function sentBodies(): string[] {
  return sendWhatsAppText.mock.calls.map(([, body]) => body)
}

beforeEach(() => {
  vi.clearAllMocks()
  isWhatsAppConfigured.mockReturnValue(true)
  toViewerLocale.mockImplementation(async (args) =>
    args.targetLocale && args.targetLocale !== 'en'
      ? `[${args.targetLocale}] ${args.english}`
      : args.english,
  )
  userRows = []
  linkRows = []
  selectCalls = 0
})

describe('notifyRoles per-recipient rendering', () => {
  it('sends each recipient their own language from one call', async () => {
    userRows = recipients('en', 'fr', 'yo')

    const res = await notifyRoles(FARM, ['supervisor'], ({ locale }) => GREETINGS[locale])

    expect(res.notified).toBe(3)
    expect(sentBodies()).toEqual(['Good morning', 'Bonjour', 'Ẹ kú àárọ̀'])
  })

  it('resolves recipient locales in a single query', async () => {
    userRows = recipients('en', 'fr', 'yo', 'pcm')

    await notifyRoles(FARM, ['supervisor'], ({ locale }) => GREETINGS[locale])

    expect(selectCalls).toBe(1)
  })

  it('renders once per language, not once per recipient', async () => {
    userRows = recipients('fr', 'fr', 'fr')
    const render = vi.fn(({ locale }: { locale: ReplyLocale }) => GREETINGS[locale])

    const res = await notifyRoles(FARM, ['field_worker'], render)

    expect(res.notified).toBe(3)
    expect(render).toHaveBeenCalledTimes(1)
    expect(sentBodies()).toEqual(['Bonjour', 'Bonjour', 'Bonjour'])
  })

  it('treats an unknown or empty preferred_locale as English', async () => {
    userRows = recipients('de', '')

    await notifyRoles(FARM, ['supervisor'], ({ locale }) => GREETINGS[locale])

    expect(sentBodies()).toEqual(['Good morning', 'Good morning'])
  })

  it('skips recipients without a phone', async () => {
    userRows = [
      { id: 'u1', phone: null, preferredLocale: 'fr' },
      { id: 'u2', phone: '+2348000000002', preferredLocale: 'fr' },
    ]

    const res = await notifyRoles(FARM, ['supervisor'], ({ locale }) => GREETINGS[locale])

    expect(res.notified).toBe(1)
    expect(sentBodies()).toEqual(['Bonjour'])
  })
})

describe('legacy plain-string callers', () => {
  it('sends the same string to every recipient unchanged', async () => {
    userRows = recipients('en', 'fr', 'yo')

    const res = await notifyRoles(FARM, ['supervisor'], '⚠️ Pump failure in Zone C')

    expect(res.notified).toBe(3)
    expect(sentBodies()).toEqual([
      '⚠️ Pump failure in Zone C',
      '⚠️ Pump failure in Zone C',
      '⚠️ Pump failure in Zone C',
    ])
  })

  it('never translates a plain string, so already-localized text is safe', async () => {
    userRows = recipients('fr')

    await notifyRoles(FARM, ['supervisor'], 'Alerte météo : fortes pluies demain')

    expect(toViewerLocale).not.toHaveBeenCalled()
    expect(sentBodies()).toEqual(['Alerte météo : fortes pluies demain'])
  })

  it('still accepts a string on notifyOwner, and now a renderer too', async () => {
    userRows = recipients('fr')
    await notifyOwner(FARM, 'Plain owner alert')
    expect(sentBodies()).toEqual(['Plain owner alert'])

    sendWhatsAppText.mockClear()
    await notifyOwner(FARM, ({ locale }) => GREETINGS[locale])
    expect(sentBodies()).toEqual(['Bonjour'])
  })
})

describe('free-form relay', () => {
  it('does no translation work for an English-only recipient set', async () => {
    userRows = recipients('en', 'en')

    const res = await notifyRoles(
      FARM,
      ['supervisor'],
      relayFreeFormEnglish('Three noilers died in pen B', FARM),
    )

    expect(res.notified).toBe(2)
    expect(toViewerLocale).not.toHaveBeenCalled()
    expect(sentBodies()).toEqual([
      'Three noilers died in pen B',
      'Three noilers died in pen B',
    ])
  })

  it('translates once for three francophone recipients', async () => {
    userRows = recipients('fr', 'fr', 'fr')

    await notifyRoles(FARM, ['supervisor'], relayFreeFormEnglish('Pen B flooded', FARM))

    expect(toViewerLocale).toHaveBeenCalledTimes(1)
    expect(sentBodies()).toEqual([
      '[fr] Pen B flooded',
      '[fr] Pen B flooded',
      '[fr] Pen B flooded',
    ])
  })

  it('translates once per language for a mixed recipient set', async () => {
    userRows = recipients('en', 'fr', 'fr', 'yo')

    await notifyRoles(FARM, ['supervisor'], relayFreeFormEnglish('Pen B flooded', FARM))

    expect(toViewerLocale).toHaveBeenCalledTimes(2)
    expect(sentBodies()).toEqual([
      'Pen B flooded',
      '[fr] Pen B flooded',
      '[fr] Pen B flooded',
      '[yo] Pen B flooded',
    ])
  })
})

describe('translation failure never drops an alert', () => {
  it('sends the English source when the translator throws', async () => {
    userRows = recipients('fr', 'yo')
    toViewerLocale.mockRejectedValue(new Error('llm down'))

    const res = await notifyRoles(
      FARM,
      ['supervisor'],
      relayFreeFormEnglish('Many birds died this morning', FARM),
    )

    expect(res.notified).toBe(2)
    expect(sentBodies()).toEqual([
      'Many birds died this morning',
      'Many birds died this morning',
    ])
  })

  it('falls back to English when a renderer throws for one language', async () => {
    userRows = recipients('en', 'fr')
    const render = ({ locale }: { locale: ReplyLocale }) => {
      if (locale === 'fr') throw new Error('missing locale table')
      return GREETINGS[locale]
    }

    const res = await notifyRoles(FARM, ['supervisor'], render)

    expect(res.notified).toBe(2)
    expect(sentBodies()).toEqual(['Good morning', 'Good morning'])
  })

  it('falls back to English when a renderer returns blank text', async () => {
    userRows = recipients('fr')

    const res = await notifyRoles(FARM, ['supervisor'], ({ locale }) =>
      locale === 'fr' ? '   ' : 'Fallback alert',
    )

    expect(res.notified).toBe(1)
    expect(sentBodies()).toEqual(['Fallback alert'])
  })

  it('sends nothing only when no language produces text', async () => {
    userRows = recipients('fr')

    const res = await notifyRoles(FARM, ['supervisor'], () => '')

    expect(res.notified).toBe(0)
    expect(sendWhatsAppText).not.toHaveBeenCalled()
  })
})

describe('notifyRolesTelegram per-recipient rendering', () => {
  beforeEach(() => {
    userRows = recipients('en', 'fr', 'yo')
    linkRows = userRows.map((u, i) => ({ afterValue: { userId: u.id, chatId: 100 + i } }))
  })

  it('sends each linked recipient their own language', async () => {
    const res = await notifyRolesTelegram(FARM, ['supervisor'], ({ locale }) => GREETINGS[locale])

    expect(res.notified).toBe(3)
    expect(sendTelegramMessage.mock.calls.map(([chatId, text]) => [chatId, text])).toEqual([
      [100, 'Good morning'],
      [101, 'Bonjour'],
      [102, 'Ẹ kú àárọ̀'],
    ])
  })

  it('reads recipients and links without an N+1', async () => {
    await notifyRolesTelegram(FARM, ['supervisor'], ({ locale }) => GREETINGS[locale])

    // One query for the recipients, one for the telegram_link rows.
    expect(selectCalls).toBe(2)
  })
})

describe('notifyTaskSubmittedForApproval', () => {
  it('translates the stored title and note, leaving the ref and worker name verbatim', async () => {
    userRows = recipients('fr')
    linkRows = []

    await notifyTaskSubmittedForApproval({
      farmId: FARM,
      taskId: 'abc123de-0000-0000-0000-000000000000',
      taskTitle: 'Spray Zone C',
      workerName: 'Amina Bello',
      note: 'Sprayer leaking',
    })

    const [body] = sentBodies()
    expect(body).toContain('Tâche soumise pour approbation')
    expect(body).toContain('TSK-ABC123')
    // Title and note are worker prose held in English, so they translate.
    expect(body).toContain('[fr] Spray Zone C')
    expect(body).toContain('[fr] Sprayer leaking')
    // A person's name is not translated, and slash commands are data the bot
    // parses, so both stay verbatim.
    expect(body).toContain('Amina Bello')
    expect(body).toContain('/approve TSK-ABC123')
  })

  it('falls back to the English title and note when the translator is down', async () => {
    userRows = recipients('fr')
    linkRows = []
    toViewerLocale.mockRejectedValue(new Error('llm down'))

    await notifyTaskSubmittedForApproval({
      farmId: FARM,
      taskId: 'abc123de-0000-0000-0000-000000000000',
      taskTitle: 'Spray Zone C',
      workerName: 'Amina Bello',
      note: 'Sprayer leaking',
    })

    const [body] = sentBodies()
    expect(body).toContain('Tâche soumise pour approbation')
    expect(body).toContain('Spray Zone C')
    expect(body).toContain('Sprayer leaking')
  })

  it('does not call the translator for an English recipient', async () => {
    userRows = recipients('en')

    await notifyTaskSubmittedForApproval({
      farmId: FARM,
      taskId: 'abc123de-0000-0000-0000-000000000000',
      taskTitle: 'Spray Zone C',
      workerName: 'Amina Bello',
      note: 'Sprayer leaking',
    })

    expect(toViewerLocale).not.toHaveBeenCalled()
  })

  it('renders English for an English recipient', async () => {
    userRows = recipients('en')

    await notifyTaskSubmittedForApproval({
      farmId: FARM,
      taskId: 'abc123de-0000-0000-0000-000000000000',
      taskTitle: 'Spray Zone C',
      workerName: 'Amina Bello',
    })

    expect(sentBodies()[0]).toContain('Task submitted for approval')
  })
})

describe('notifyTaskRejected', () => {
  it('messages the assigned worker with localized rejection copy and reason', async () => {
    userRows = [{ id: 'u1', phone: '+234800000001', preferredLocale: 'fr' }]
    linkRows = [{ afterValue: { userId: 'u1', chatId: 42 } }]

    await notifyTaskRejected({
      farmId: FARM,
      assignedToId: 'u1',
      taskId: 'abc123de-0000-0000-0000-000000000000',
      taskTitle: 'Spray Zone C',
      reason: 'Missed the inner rows',
    })

    const [body] = sentBodies()
    expect(body).toContain('Tâche rejetée')
    expect(body).toContain('TSK-ABC123')
    expect(body).toContain('[fr] Spray Zone C')
    expect(body).toContain('[fr] Missed the inner rows')
    expect(body).toContain('Mes tâches')
    expect(sendTelegramMessage.mock.calls[0]?.[0]).toBe(42)
    expect(sendTelegramMessage.mock.calls[0]?.[1]).toContain('Tâche rejetée')
  })

  it('no-ops when there is no assignee', async () => {
    userRows = recipients('en')

    await notifyTaskRejected({
      farmId: FARM,
      assignedToId: null,
      taskId: 'abc123de-0000-0000-0000-000000000000',
      taskTitle: 'Spray Zone C',
      reason: 'Missed the inner rows',
    })

    expect(sendWhatsAppText).not.toHaveBeenCalled()
    expect(sendTelegramMessage).not.toHaveBeenCalled()
  })
})

describe('notifyWorkerClockIn', () => {
  const CLOCK_IN = {
    farmId: FARM,
    workerName: 'Amina Bello',
    clockInAt: new Date('2026-07-20T07:00:00Z'),
  }

  it('translates the clock-in note for the reader', async () => {
    userRows = recipients('fr')

    await notifyWorkerClockIn({ ...CLOCK_IN, notes: 'Borehole pump is leaking' })

    const [body] = sentBodies()
    expect(body).toContain('Ouvrier pointé à l’arrivée')
    expect(body).toContain('Remarque: [fr] Borehole pump is leaking')
    expect(body).toContain('Amina Bello')
  })

  it('sends the English note when the translator is down', async () => {
    userRows = recipients('fr')
    toViewerLocale.mockRejectedValue(new Error('llm down'))

    await notifyWorkerClockIn({ ...CLOCK_IN, notes: 'Borehole pump is leaking' })

    expect(sentBodies()[0]).toContain('Remarque: Borehole pump is leaking')
  })

  it('skips the translator when there is no note', async () => {
    userRows = recipients('fr')

    await notifyWorkerClockIn({ ...CLOCK_IN, notes: null })

    expect(sentBodies()[0]).not.toContain('Remarque')
    expect(toViewerLocale).not.toHaveBeenCalled()
  })
})
