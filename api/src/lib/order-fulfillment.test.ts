import { getTableName } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, unknown>

const nameOf = (table: unknown) => getTableName(table as never)

/** Rows the fake db returns, queued per table so query order does not matter. */
const selectQueue = new Map<string, Row[][]>()
const updates: { table: string; patch: Row }[] = []

function queueSelect(table: string, rows: Row[]) {
  const queued = selectQueue.get(table) ?? []
  queued.push(rows)
  selectQueue.set(table, queued)
}

vi.mock('../db/index.js', () => {
  const selectChain = () => {
    let rows: Row[] = []
    const self: Record<string, unknown> = {}
    const same = () => self
    Object.assign(self, {
      from: (table: unknown) => {
        rows = selectQueue.get(nameOf(table))?.shift() ?? []
        return self
      },
      leftJoin: same,
      innerJoin: same,
      where: same,
      orderBy: same,
      limit: same,
      then: (resolve: (value: Row[]) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(rows).then(resolve, reject),
    })
    return self
  }

  return {
    db: {
      select: selectChain,
      insert: () => ({
        values: () => ({
          returning: async () => [],
          onConflictDoNothing: async () => undefined,
        }),
      }),
      update: (table: unknown) => ({
        set: (patch: Row) => {
          updates.push({ table: nameOf(table), patch })
          return {
            where: () =>
              Object.assign(Promise.resolve([patch]), { returning: async () => [patch] }),
          }
        },
      }),
    },
  }
})

const completeChat = vi.fn()
const isLlmConfigured = vi.fn(() => true)

vi.mock('./llm.js', () => ({
  completeChat: (...args: unknown[]) => completeChat(...args),
  isLlmConfigured: () => isLlmConfigured(),
}))

vi.mock('./llm-budget.js', () => ({
  checkLlmBudget: () => ({ allowed: true, used: 0, limit: 500 }),
  consumeLlmBudget: vi.fn(),
}))

/**
 * The real canonical-English service runs, with only the LLM and db faked, so
 * the tests see its real short-circuits. The spy counts how often the feedback
 * path enters the service at all, and `canonicalThrows` covers the one failure
 * the service cannot report through its own status: an exception.
 */
const canonicalCalls = vi.fn()
let canonicalThrows = false

vi.mock('./content-locale.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./content-locale.js')>()
  return {
    ...actual,
    toCanonicalEnglish: (args: Parameters<typeof actual.toCanonicalEnglish>[0]) => {
      canonicalCalls(args)
      if (canonicalThrows) throw new Error('translation service down')
      return actual.toCanonicalEnglish(args)
    },
  }
})

const farmEvents: Row[] = []
vi.mock('./farm-events.js', () => ({
  recordFarmEvent: async (event: Row) => {
    farmEvents.push(event)
  },
}))

const staffAlerts: unknown[] = []
vi.mock('./farm-notify.js', () => ({
  notifyOrderAlertStaff: async (_farmId: string, message: unknown) => {
    staffAlerts.push(message)
  },
  notifyOrderAlertStaffTelegram: async (_farmId: string, message: unknown) => {
    staffAlerts.push(message)
  },
}))

vi.mock('./audit.js', () => ({ logAudit: vi.fn() }))

const { recordCustomerFeedback } = await import('./order-fulfillment.js')

const FRENCH_FEEDBACK = 'Merci, les bananes sont arrivées bien fraîches'
const ENGLISH_FEEDBACK = 'Thanks, the bananas arrived nice and fresh'
const YORUBA_FEEDBACK = 'Ẹ ṣé, ọjà náà dára gan'

const TO_ENGLISH: Record<string, string> = {
  [FRENCH_FEEDBACK]: ENGLISH_FEEDBACK,
  [YORUBA_FEEDBACK]: 'Thank you, the goods were very good',
}

function orderRow(overrides: Row = {}): Row {
  return {
    id: 'a1b2c3d4-1111-2222-3333-444455556666',
    farmId: 'farm-1',
    customerName: 'Adaeze Nwosu',
    customerContactId: 'contact-1',
    status: 'delivered',
    notes: null,
    customerFeedback: null,
    customerFeedbackAt: null,
    sourceLocale: null,
    translationStatus: 'done',
    feedbackRequestedAt: new Date('2026-07-20T10:00:00Z'),
    ...overrides,
  }
}

/** The order row the delivered-order lookup finds, before feedback lands. */
let pendingFeedbackOrder: Row = {}

function queueOrder(overrides: Row = {}) {
  pendingFeedbackOrder = orderRow(overrides)
  queueSelect('orders', [pendingFeedbackOrder])
}

/** The patch the feedback write applied to `orders`. */
function orderPatch(): Row {
  const patch = updates.find((entry) => entry.table === 'orders')
  expect(patch).toBeDefined()
  return patch!.patch
}

/** The row as the database holds it once the patch has been applied. */
function storedOrder(): Row {
  return { ...pendingFeedbackOrder, ...orderPatch() }
}

/** Every string the translator was actually handed, in call order. */
function translatedTexts(): string[] {
  return completeChat.mock.calls.map((call) => call[1] as string)
}

async function sendFeedback(text: string) {
  return recordCustomerFeedback({ farmId: 'farm-1', contactId: 'contact-1', text })
}

beforeEach(() => {
  vi.clearAllMocks()
  selectQueue.clear()
  updates.length = 0
  pendingFeedbackOrder = {}
  farmEvents.length = 0
  staffAlerts.length = 0
  canonicalThrows = false
  isLlmConfigured.mockReturnValue(true)
  completeChat.mockImplementation(async (_system: string, text: string) => ({
    text: TO_ENGLISH[text] ?? `[${text}]`,
    model: 'test',
  }))
})

describe('recordCustomerFeedback - canonical English on write', () => {
  it('stores French feedback in English with the detected source locale', async () => {
    queueOrder()

    const result = await sendFeedback(FRENCH_FEEDBACK)

    expect(result.handled).toBe(true)
    expect(storedOrder()).toMatchObject({
      customerFeedback: ENGLISH_FEEDBACK,
      sourceLocale: 'fr',
      translationStatus: 'done',
    })
  })

  it('detects the language from the text because a customer has no preference to read', async () => {
    queueOrder()

    await sendFeedback(YORUBA_FEEDBACK)

    // A literal 'en' hint would short-circuit the service and store Yoruba
    // labelled 'done', which the retry job never sweeps again.
    expect(canonicalCalls).toHaveBeenCalledWith(expect.objectContaining({ sourceLocale: null }))
    expect(storedOrder()).toMatchObject({
      customerFeedback: 'Thank you, the goods were very good',
      sourceLocale: 'yo',
      translationStatus: 'done',
    })
  })

  it('never sends the customer name or the order to the translator', async () => {
    queueOrder()

    await sendFeedback(FRENCH_FEEDBACK)

    expect(translatedTexts()).toEqual([FRENCH_FEEDBACK])
  })

  it('stores the original as pending and still thanks the customer when the LLM is off', async () => {
    isLlmConfigured.mockReturnValue(false)
    queueOrder()

    const result = await sendFeedback(FRENCH_FEEDBACK)

    expect(result.handled).toBe(true)
    expect(result.message).toBeTruthy()
    expect(storedOrder()).toMatchObject({
      customerFeedback: FRENCH_FEEDBACK,
      // Detected rather than null: the retry job gets a usable hint, and a
      // pending row must never claim to be English.
      sourceLocale: 'fr',
      translationStatus: 'pending',
    })
  })

  it('stores the original at pending with a null locale when the translator throws', async () => {
    canonicalThrows = true
    queueOrder()

    const result = await sendFeedback(FRENCH_FEEDBACK)

    expect(result.handled).toBe(true)
    expect(storedOrder()).toMatchObject({
      customerFeedback: FRENCH_FEEDBACK,
      sourceLocale: null,
      translationStatus: 'pending',
    })
  })

  it('makes no translation call at all for English feedback', async () => {
    queueOrder()

    await sendFeedback(ENGLISH_FEEDBACK)

    expect(completeChat).not.toHaveBeenCalled()
    expect(storedOrder()).toMatchObject({
      customerFeedback: ENGLISH_FEEDBACK,
      sourceLocale: 'en',
      translationStatus: 'done',
    })
  })

  it('leaves the locale pair of an order the retry job still owes work on', async () => {
    queueOrder({ sourceLocale: 'yo', translationStatus: 'pending' })

    await sendFeedback(FRENCH_FEEDBACK)

    const patch = orderPatch()
    expect(patch.customerFeedback).toBe(ENGLISH_FEEDBACK)
    expect(patch).not.toHaveProperty('sourceLocale')
    expect(patch).not.toHaveProperty('translationStatus')
  })

  it('records the English in the farm event, not the customer language', async () => {
    queueOrder()

    await sendFeedback(FRENCH_FEEDBACK)

    expect(farmEvents[0]).toMatchObject({
      entityType: 'order',
      afterValue: { feedback: ENGLISH_FEEDBACK },
    })
  })

  it('does not touch the translator when no delivered order is awaiting feedback', async () => {
    queueSelect('orders', [])

    const result = await sendFeedback(FRENCH_FEEDBACK)

    expect(result.handled).toBe(false)
    expect(canonicalCalls).not.toHaveBeenCalled()
    expect(updates).toHaveLength(0)
  })
})
