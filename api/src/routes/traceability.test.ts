import { Hono } from 'hono'
import { getTableName } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, unknown>

const nameOf = (table: unknown) => getTableName(table as never)

let sessionUser: Row = {
  id: 'user-sup',
  farmId: 'farm-1',
  role: 'supervisor',
  name: 'Sup',
  email: 'sup@trovara.farm',
}

/** Rows the fake db returns, queued per table so query order does not matter. */
const selectQueue = new Map<string, Row[][]>()
const selectLog: string[] = []
const inserted: { table: string; values: Row }[] = []
const updates: { table: string; patch: Row }[] = []
let updatedRow: Row = {}

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
        const name = nameOf(table)
        selectLog.push(name)
        rows = selectQueue.get(name)?.shift() ?? []
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
      insert: (table: unknown) => ({
        values: (values: Row) => {
          inserted.push({ table: nameOf(table), values })
          return {
            returning: async () => [{ id: 'lot-new', publicToken: 'tok-new', ...values }],
            onConflictDoNothing: async () => undefined,
          }
        },
      }),
      update: (table: unknown) => ({
        set: (patch: Row) => {
          updates.push({ table: nameOf(table), patch })
          return { where: () => ({ returning: async () => [{ ...updatedRow, ...patch }] }) }
        },
      }),
      delete: () => ({ where: async () => undefined }),
    },
  }
})

const completeChat = vi.fn()
const isLlmConfigured = vi.fn(() => true)

vi.mock('../lib/llm.js', () => ({
  completeChat: (...args: unknown[]) => completeChat(...args),
  isLlmConfigured: () => isLlmConfigured(),
}))

vi.mock('../lib/llm-budget.js', () => ({
  checkLlmBudget: () => ({ allowed: true, used: 0, limit: 500 }),
  consumeLlmBudget: vi.fn(),
}))

/**
 * The real canonical-English service runs, with only the LLM and db faked, so
 * the tests see its real short-circuits. The spies count how often the route
 * enters the service at all.
 */
const canonicalCalls = vi.fn()
const viewerBatchCalls = vi.fn()

vi.mock('../lib/content-locale.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/content-locale.js')>()
  return {
    ...actual,
    toCanonicalEnglish: (args: Parameters<typeof actual.toCanonicalEnglish>[0]) => {
      canonicalCalls(args)
      return actual.toCanonicalEnglish(args)
    },
    toViewerLocaleMany: (args: Parameters<typeof actual.toViewerLocaleMany>[0]) => {
      viewerBatchCalls(args)
      return actual.toViewerLocaleMany(args)
    },
  }
})

vi.mock('../middleware/auth.js', () => ({
  authMiddleware: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set('user', sessionUser)
    await next()
  },
}))

vi.mock('../lib/audit.js', () => ({ logAudit: vi.fn() }))
vi.mock('../lib/farm-events.js', () => ({ recordFarmEvent: vi.fn() }))
vi.mock('../lib/evidence-url.js', () => ({ validateEvidenceDataUrl: vi.fn(() => true) }))

const FRENCH_TO_ENGLISH: Record<string, string> = {
  'Récolte fraîche du matin, bananes bien mûres': 'Fresh morning harvest, ripe bananas',
  'Trois cageots abîmés pendant le transport': 'Three crates damaged in transit',
}

const ENGLISH_TO_FRENCH: Record<string, string> = {
  'Fresh morning harvest, ripe bananas': 'Récolte fraîche du matin, bananes bien mûres',
  'Three crates damaged in transit': 'Trois cageots abîmés pendant le transport',
}

/** A create body whose identifiers must survive a translated write untouched. */
const FRENCH_LOT = {
  productName: 'Plantain',
  quantityKg: 24,
  unit: 'crates' as const,
  harvestedAt: '2026-07-20T08:00:00Z',
  publicNotes: 'Récolte fraîche du matin, bananes bien mûres',
  internalNotes: 'Trois cageots abîmés pendant le transport',
}

function lotRow(overrides: Row = {}): Row {
  return {
    id: 'lot-1',
    lotCode: 'LOT-20260720-001',
    publicToken: 'tok-1',
    plotId: 'plot-1',
    plotName: 'Block A',
    zoneName: 'North Zone',
    cropCycleId: null,
    orderId: null,
    orderSource: null,
    productName: 'Plantain',
    quantityKg: 24,
    unit: 'crates',
    publicNotes: 'Fresh morning harvest, ripe bananas',
    internalNotes: 'Three crates damaged in transit',
    photoUrl: null,
    harvestedAt: new Date('2026-07-20T08:00:00Z'),
    createdAt: new Date('2026-07-20T08:05:00Z'),
    farmSlug: 'trovara',
    verificationStatus: 'verified',
    reportedById: 'user-sup',
    reportedByName: 'Sup',
    verifiedById: 'user-sup',
    verifiedByName: 'Sup',
    verifiedAt: new Date('2026-07-20T08:10:00Z'),
    sourceLocale: null,
    translationStatus: 'done',
    ...overrides,
  }
}

async function app() {
  const { traceabilityRoutes } = await import('./traceability.js')
  const instance = new Hono()
  instance.route('/traceability', traceabilityRoutes)
  return instance
}

/** Everything a create reads before it inserts: farm timezone and existing codes. */
function queueCreateReads(preferredLocale: string) {
  queueSelect('farms', [{ timezone: 'Africa/Lagos' }])
  queueSelect('harvest_lots', [])
  queueSelect('users', [{ preferredLocale }])
}

async function createLot(body: unknown) {
  return (await app()).request('/traceability', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function insertedLot(): Row {
  const row = inserted.find((entry) => entry.table === 'harvest_lots')
  expect(row).toBeDefined()
  return row!.values
}

/** Every string the translator was actually handed, in call order. */
function translatedTexts(): string[] {
  return completeChat.mock.calls.map((call) => call[1] as string)
}

beforeEach(() => {
  vi.clearAllMocks()
  selectQueue.clear()
  selectLog.length = 0
  inserted.length = 0
  updates.length = 0
  updatedRow = lotRow()
  isLlmConfigured.mockReturnValue(true)
  completeChat.mockImplementation(async (system: string, text: string) => {
    const table = /into English/i.test(system) ? FRENCH_TO_ENGLISH : ENGLISH_TO_FRENCH
    return { text: table[text] ?? `[${text}]`, model: 'test' }
  })
  sessionUser = {
    id: 'user-sup',
    farmId: 'farm-1',
    role: 'supervisor',
    name: 'Sup',
    email: 'sup@trovara.farm',
  }
})

describe('POST /traceability - canonical English on write', () => {
  it('stores both notes in English with the author locale for a French create', async () => {
    queueCreateReads('fr')

    const res = await createLot(FRENCH_LOT)

    expect(res.status).toBe(201)
    expect(insertedLot()).toMatchObject({
      publicNotes: 'Fresh morning harvest, ripe bananas',
      internalNotes: 'Three crates damaged in transit',
      sourceLocale: 'fr',
      translationStatus: 'done',
    })
  })

  it('leaves identifiers, quantities and the verification enum verbatim', async () => {
    queueCreateReads('fr')

    await createLot(FRENCH_LOT)

    expect(insertedLot()).toMatchObject({
      lotCode: 'LOT-20260720-001',
      productName: 'Plantain',
      quantityKg: 24,
      unit: 'crates',
      verificationStatus: 'verified',
    })
    // The two notes are the only prose; nothing else reaches the translator.
    expect(translatedTexts().sort()).toEqual([
      'Récolte fraîche du matin, bananes bien mûres',
      'Trois cageots abîmés pendant le transport',
    ])
  })

  it('returns the author their own words while storing the English', async () => {
    queueCreateReads('fr')

    const res = await createLot(FRENCH_LOT)
    const body = (await res.json()) as { lot: Row }

    expect(body.lot.publicNotes).toBe('Récolte fraîche du matin, bananes bien mûres')
    expect(insertedLot().publicNotes).toBe('Fresh morning harvest, ripe bananas')
  })

  it('stores the original as pending and still succeeds when the LLM is unavailable', async () => {
    isLlmConfigured.mockReturnValue(false)
    queueCreateReads('fr')

    const res = await createLot(FRENCH_LOT)

    expect(res.status).toBe(201)
    expect(insertedLot()).toMatchObject({
      publicNotes: 'Récolte fraîche du matin, bananes bien mûres',
      internalNotes: 'Trois cageots abîmés pendant le transport',
      sourceLocale: 'fr',
      translationStatus: 'pending',
    })
  })

  it('still succeeds and stays pending when the translator throws', async () => {
    completeChat.mockRejectedValue(new Error('upstream 503'))
    queueCreateReads('fr')

    const res = await createLot(FRENCH_LOT)

    expect(res.status).toBe(201)
    expect(insertedLot()).toMatchObject({
      publicNotes: 'Récolte fraîche du matin, bananes bien mûres',
      translationStatus: 'pending',
    })
  })

  it('marks the row pending when only the public note fails', async () => {
    queueCreateReads('fr')
    completeChat.mockImplementation(async (_system: string, text: string) => {
      if (text === FRENCH_LOT.publicNotes) throw new Error('upstream 503')
      return { text: FRENCH_TO_ENGLISH[text], model: 'test' }
    })

    const res = await createLot(FRENCH_LOT)

    expect(res.status).toBe(201)
    // One column pair covers the row, so a single failure leaves it all pending.
    expect(insertedLot()).toMatchObject({
      publicNotes: 'Récolte fraîche du matin, bananes bien mûres',
      internalNotes: 'Three crates damaged in transit',
      translationStatus: 'pending',
    })
  })

  it('makes no translation call at all for an English create', async () => {
    queueCreateReads('en')

    const res = await createLot({
      ...FRENCH_LOT,
      publicNotes: 'Fresh morning harvest, ripe bananas',
      internalNotes: 'Three crates damaged in transit',
    })

    expect(res.status).toBe(201)
    expect(completeChat).not.toHaveBeenCalled()
    expect(insertedLot()).toMatchObject({
      publicNotes: 'Fresh morning harvest, ripe bananas',
      internalNotes: 'Three crates damaged in transit',
      sourceLocale: 'en',
      translationStatus: 'done',
    })
  })

  it('does not enter the translation service for a create with no notes', async () => {
    queueCreateReads('fr')

    const res = await createLot({ productName: 'Plantain', quantityKg: 10 })

    expect(res.status).toBe(201)
    expect(canonicalCalls).not.toHaveBeenCalled()
    expect(insertedLot()).toMatchObject({ publicNotes: null, internalNotes: null })
  })
})

describe('GET /traceability - viewer locale on read', () => {
  it('translates both note columns for a French viewer in one batched call', async () => {
    queueSelect('harvest_lots', [
      lotRow(),
      lotRow({ id: 'lot-2', internalNotes: null }),
    ])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await (await app()).request('/traceability')
    const body = (await res.json()) as { lots: Row[] }

    expect(res.status).toBe(200)
    expect(viewerBatchCalls).toHaveBeenCalledTimes(1)
    expect(selectLog.filter((table) => table === 'content_translations')).toHaveLength(1)
    expect(body.lots[0].publicNotes).toBe('Récolte fraîche du matin, bananes bien mûres')
    expect(body.lots[0].internalNotes).toBe('Trois cageots abîmés pendant le transport')
    expect(body.lots[1].internalNotes).toBeNull()
  })

  it('never sends identifiers or proper nouns to the translator', async () => {
    queueSelect('harvest_lots', [lotRow()])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await (await app()).request('/traceability')
    const lot = ((await res.json()) as { lots: Row[] }).lots[0]

    expect(lot).toMatchObject({
      lotCode: 'LOT-20260720-001',
      publicToken: 'tok-1',
      productName: 'Plantain',
      unit: 'crates',
      quantityKg: 24,
      verificationStatus: 'verified',
      plotName: 'Block A',
      reportedByName: 'Sup',
    })
    expect(viewerBatchCalls).toHaveBeenCalledWith(
      expect.objectContaining({
        texts: ['Fresh morning harvest, ripe bananas', 'Three crates damaged in transit'],
      }),
    )
  })

  it('does no translation work at all for an English viewer', async () => {
    queueSelect('harvest_lots', [lotRow(), lotRow({ id: 'lot-2' })])
    queueSelect('users', [{ preferredLocale: 'en' }])

    const res = await (await app()).request('/traceability')
    const body = (await res.json()) as { lots: Row[] }

    expect(viewerBatchCalls).not.toHaveBeenCalled()
    expect(completeChat).not.toHaveBeenCalled()
    expect(selectLog).not.toContain('content_translations')
    expect(body.lots[0].publicNotes).toBe('Fresh morning harvest, ripe bananas')
  })

  it('reads 40 lots with one batched call and one call per distinct string', async () => {
    queueSelect(
      'harvest_lots',
      Array.from({ length: 40 }, (_, index) =>
        lotRow({ id: `lot-${index}`, internalNotes: null }),
      ),
    )
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await (await app()).request('/traceability')
    const body = (await res.json()) as { lots: Row[] }

    expect(body.lots).toHaveLength(40)
    expect(viewerBatchCalls).toHaveBeenCalledTimes(1)
    expect(completeChat).toHaveBeenCalledTimes(1)
    expect(body.lots[39].publicNotes).toBe('Récolte fraîche du matin, bananes bien mûres')
  })
})
