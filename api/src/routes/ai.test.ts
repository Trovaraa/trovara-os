import { Hono } from 'hono'
import { getTableName } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { briefingDateLabel } from '../lib/briefing-messages.js'

type Row = Record<string, unknown>

const nameOf = (table: unknown) => getTableName(table as never)

let sessionUser: Row = {
  id: 'user-owner',
  farmId: 'farm-1',
  role: 'owner',
  name: 'Owner',
  email: 'owner@trovara.farm',
}

/** Rows the fake db returns, queued per table so query order does not matter. */
const selectQueue = new Map<string, Row[][]>()
const selectLog: string[] = []
const inserted: { table: string; values: Row }[] = []

function queueSelect(table: string, rows: Row[], times = 1) {
  const queued = selectQueue.get(table) ?? []
  for (let i = 0; i < times; i += 1) queued.push(rows)
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
      groupBy: same,
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
          const name = nameOf(table)
          inserted.push({ table: name, values })
          return {
            returning: async () => [{ id: `${name}-new`, ...values }],
            onConflictDoNothing: async () => undefined,
          }
        },
      }),
    },
  }
})

const completeChat = vi.fn()
const completeChatVision = vi.fn()
const isLlmConfigured = vi.fn(() => true)

vi.mock('../lib/llm.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/llm.js')>()
  return {
    ...actual,
    completeChat: (...args: unknown[]) => completeChat(...args),
    completeChatVision: (...args: unknown[]) => completeChatVision(...args),
    completeChatHistory: vi.fn(async () => ({ text: 'answer', model: 'test' })),
    isLlmConfigured: () => isLlmConfigured(),
  }
})

vi.mock('../lib/llm-budget.js', () => ({
  checkLlmBudget: () => ({ allowed: true, used: 0, limit: 500 }),
  consumeLlmBudget: vi.fn(),
}))

vi.mock('../lib/rate-limit.js', () => ({
  checkRateLimit: () => ({ allowed: true, retryAfterSec: 0 }),
}))

/** The real content-locale service runs; the spies count entries into it. */
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

/** Draft storage is exercised through its own suite; here only the values matter. */
const storedDrafts: Row[] = []
let pendingDraft: Row | null = null

vi.mock('../lib/task-drafts.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/task-drafts.js')>()
  return {
    ...actual,
    storeActionDraft: async (input: Row) => {
      storedDrafts.push(input)
      return { id: 'draft-1', expiresAt: new Date(Date.now() + 600_000), ...input }
    },
    takeTaskDraft: async () => pendingDraft,
  }
})

const resolveMarketplaceProducts = vi.fn(async (_args: Row) => [{ title: 'Agrovet supplies' }])

vi.mock('../lib/marketplace-search.js', () => ({
  resolveMarketplaceProducts: (args: Row) => resolveMarketplaceProducts(args),
}))

vi.mock('../middleware/auth.js', () => ({
  authMiddleware: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set('user', sessionUser)
    await next()
  },
}))

vi.mock('../lib/audit.js', () => ({ logAudit: vi.fn() }))

const FRENCH_TO_ENGLISH: Record<string, string> = {
  'Arroser les bananiers du bloc A': 'Water the plantains in block A',
  'Réparer la clôture du poulailler': 'Repair the poultry house fence',
  'Trois poules sont mortes cette nuit': 'Three hens died last night',
}

const ENGLISH_TO_FRENCH: Record<string, string> = {
  'Water the plantains in block A': 'Arroser les bananiers du bloc A',
  'Three birds died in pen B after two days of lethargy.':
    'Trois oiseaux sont morts dans l’enclos B après deux jours de léthargie.',
  'Isolate the pen and disinfect the drinkers': 'Isolez l’enclos et désinfectez les abreuvoirs',
  'Call the vet today': 'Appelez le vétérinaire aujourd’hui',
  'Three birds show bloody droppings and will not eat.':
    'Trois oiseaux ont des fientes sanglantes et refusent de manger.',
  Coccidiosis: 'Coccidiose',
  'Bloody droppings in young birds point to it':
    'Les fientes sanglantes chez les jeunes oiseaux y renvoient',
  'Isolate the affected birds today': 'Isolez les oiseaux atteints aujourd’hui',
  'Amprolium in drinking water': 'Amprolium dans l’eau de boisson',
  'Mix for five days': 'Mélanger pendant cinq jours',
  'Confirm the dose with your agrovet': 'Confirmez la dose avec votre agrovet',
  'Keep the litter dry': 'Gardez la litière sèche',
}

const INCIDENT_TEXT =
  'Three birds died in pen B last night after two days of lethargy and refusing feed.'

const INCIDENT_JSON = {
  summaryText: 'Three birds died in pen B after two days of lethargy.',
  severity: 'high',
  category: 'livestock_mortality',
  recommendedActions: ['Isolate the pen and disinfect the drinkers', 'Call the vet today'],
}

const LIVESTOCK_JSON = {
  likelyCauses: [
    { name: 'Coccidiosis', likelihood: 'high', why: 'Bloody droppings in young birds point to it' },
  ],
  immediateActions: ['Isolate the affected birds today'],
  treatments: [
    {
      name: 'Amprolium in drinking water',
      usage: 'Mix for five days',
      note: 'Confirm the dose with your agrovet',
    },
  ],
  prevention: ['Keep the litter dry'],
  urgency: 'high',
  callVet: true,
  summary: 'Three birds show bloody droppings and will not eat.',
}

async function app() {
  const { aiRoutes } = await import('./ai.js')
  const instance = new Hono()
  instance.route('/ai', aiRoutes)
  return instance
}

async function post(path: string, body: unknown) {
  return (await app()).request(`/ai${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function get(path: string) {
  return (await app()).request(`/ai${path}`)
}

function insertedTask(): Row {
  const row = inserted.find((entry) => entry.table === 'tasks')
  expect(row).toBeDefined()
  return row!.values
}

function translate(system: string, text: string): string {
  const table = /into English/i.test(system) ? FRENCH_TO_ENGLISH : ENGLISH_TO_FRENCH
  return table[text] ?? `[${text}]`
}

beforeEach(() => {
  vi.clearAllMocks()
  selectQueue.clear()
  selectLog.length = 0
  inserted.length = 0
  storedDrafts.length = 0
  pendingDraft = null
  isLlmConfigured.mockReturnValue(true)
  completeChat.mockImplementation(async (system: string, text: string) => {
    if (/translation engine/i.test(system)) {
      return { text: translate(system, text), model: 'test' }
    }
    if (/Diagnose the animal health problem/i.test(system)) {
      return { text: JSON.stringify(LIVESTOCK_JSON), model: 'gpt-test' }
    }
    return { text: JSON.stringify(INCIDENT_JSON), model: 'gpt-test' }
  })
  completeChatVision.mockImplementation(async () => ({
    text: JSON.stringify(LIVESTOCK_JSON),
    model: 'gpt-test',
  }))
  sessionUser = {
    id: 'user-owner',
    farmId: 'farm-1',
    role: 'owner',
    name: 'Owner',
    email: 'owner@trovara.farm',
  }
})

describe('GET /ai/briefing - deterministic labels in the owner locale', () => {
  type Briefing = {
    locale: string
    farmName: string
    dateLabel: string
    priorities: { label: string; detail: string; urgency: string }[]
    allClear: boolean
  }

  /** A farm with one approval, one low-stock item, and three unstarted tasks. */
  function queueBusyFarm(preferredLocale: string | null) {
    queueSelect('farms', [{ id: 'farm-1', name: 'Ferme Adéọlá', location: 'Ibadan' }])
    queueSelect('tasks', [
      { status: 'awaiting_approval', total: 2 },
      { status: 'pending', total: 3 },
      { status: 'in_progress', total: 1 },
    ])
    queueSelect('plots', [{ total: 4 }])
    queueSelect('inventory_items', [
      { name: 'Engrais NPK', quantity: 12, reorderLevel: 50, unit: 'kg' },
    ])
    queueSelect('users', [{ preferredLocale }])
  }

  async function briefingFor(preferredLocale: string | null): Promise<Briefing> {
    queueBusyFarm(preferredLocale)
    const res = await get('/briefing')
    expect(res.status).toBe(200)
    return (await res.json()) as Briefing
  }

  it('renders every priority in English for an English owner', async () => {
    const body = await briefingFor('en')

    expect(body.locale).toBe('en')
    expect(body.allClear).toBe(false)
    expect(body.priorities.map((p) => p.label)).toEqual([
      'Approve worker submissions',
      'Restock Engrais NPK',
      'Assign or follow up pending tasks',
      'Check in on field work',
    ])
    expect(body.priorities.map((p) => p.detail)).toEqual([
      '2 task(s) waiting for your review',
      '12 kg left - reorder at 50',
      '3 task(s) not started',
      '1 task(s) in progress today',
    ])
  })

  it('renders the same priorities in French for a French owner', async () => {
    const body = await briefingFor('fr')

    expect(body.locale).toBe('fr')
    expect(body.priorities[0].label).toBe('Approuver les soumissions des ouvriers')
    expect(body.priorities[0].detail).toBe('2 tâche(s) en attente de votre examen')
    expect(body.priorities[1].detail).toBe('12 kg restants - réappro. à 50')
    expect(body.priorities[2].detail).toBe('3 tâche(s) non commencée(s)')
    expect(body.dateLabel).toBe(briefingDateLabel('fr'))
  })

  it('renders the same priorities in Yoruba and Pidgin', async () => {
    const yoruba = await briefingFor('yo')
    const pidgin = await briefingFor('pcm')

    expect(yoruba.locale).toBe('yo')
    expect(yoruba.priorities[0].detail).toBe('Iṣẹ́ 2 ń dúró de àyẹ̀wò rẹ')
    expect(yoruba.priorities[1].label).toBe('Tún Engrais NPK kún')
    expect(pidgin.locale).toBe('pcm')
    expect(pidgin.priorities[0].detail).toBe('2 work dey wait make you check am')
    expect(pidgin.priorities[3].detail).toBe('1 work dey go on today')
  })

  it('gives a non-English owner text that is not the English text', async () => {
    const english = await briefingFor('en')

    for (const locale of ['fr', 'yo', 'pcm']) {
      const translated = await briefingFor(locale)
      expect(translated.priorities.map((p) => p.label), locale).not.toEqual(
        english.priorities.map((p) => p.label),
      )
      expect(translated.priorities.map((p) => p.detail), locale).not.toEqual(
        english.priorities.map((p) => p.detail),
      )
    }
  })

  it('interpolates counts and units identically in every locale', async () => {
    for (const locale of ['en', 'fr', 'yo', 'pcm']) {
      const body = await briefingFor(locale)
      const restock = body.priorities[1]

      // Numbers, units, and the farm's own item name are parameters, never words
      // to translate.
      expect(restock.label, locale).toContain('Engrais NPK')
      expect(restock.detail, locale).toContain('12 kg')
      expect(restock.detail, locale).toContain('50')
      expect(body.priorities[2].detail, locale).toContain('3')
      expect(body.farmName, locale).toBe('Ferme Adéọlá')
    }
  })

  it('costs nothing and works with the LLM switched off', async () => {
    isLlmConfigured.mockReturnValue(false)

    const body = await briefingFor('fr')

    expect(completeChat).not.toHaveBeenCalled()
    expect(viewerBatchCalls).not.toHaveBeenCalled()
    expect(body.priorities[0].label).toBe('Approuver les soumissions des ouvriers')
  })

  it('falls back to a translated farm label when the farm row has no name', async () => {
    queueSelect('farms', [])
    queueSelect('tasks', [])
    queueSelect('plots', [{ total: 0 }])
    queueSelect('inventory_items', [])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await get('/briefing')
    const body = (await res.json()) as Briefing

    expect(body.farmName).toBe('Ferme')
    expect(body.allClear).toBe(true)
    expect(body.priorities).toEqual([])
  })
})

describe('POST /ai/draft-task - canonical English on write', () => {
  it('stores a French draft in English with the author locale', async () => {
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await post('/draft-task', { question: 'Arroser les bananiers du bloc A' })

    expect(res.status).toBe(200)
    expect(storedDrafts[0]).toMatchObject({
      actionType: 'create_task',
      payload: { title: 'Water the plantains in block A' },
      sourceLocale: 'fr',
      translationStatus: 'done',
    })
  })

  it('stores an English draft unchanged without any translation call', async () => {
    queueSelect('users', [{ preferredLocale: 'en' }])

    const res = await post('/draft-task', { question: 'create task water the plantains in block A' })

    expect(res.status).toBe(200)
    expect(storedDrafts[0]).toMatchObject({
      payload: { title: 'water the plantains in block A' },
      sourceLocale: 'en',
      translationStatus: 'done',
    })
    expect(completeChat).not.toHaveBeenCalled()
  })

  it('keeps the original text marked pending when the LLM is unavailable', async () => {
    isLlmConfigured.mockReturnValue(false)
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await post('/draft-task', { question: 'Arroser les bananiers du bloc A' })

    expect(res.status).toBe(200)
    expect(storedDrafts[0]).toMatchObject({
      payload: { title: 'Arroser les bananiers du bloc A' },
      sourceLocale: 'fr',
      translationStatus: 'pending',
    })
  })

  it('returns the user their own words to confirm', async () => {
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await post('/draft-task', { question: 'Arroser les bananiers du bloc A' })
    const body = (await res.json()) as { draftId: string; draft: Row; needsConfirm: boolean }

    expect(body.draft.title).toBe('Arroser les bananiers du bloc A')
    expect(body.draftId).toBe('draft-1')
    expect(body.needsConfirm).toBe(true)
  })
})

describe('POST /ai/confirm-task - canonical English on write', () => {
  const confirm = (body: Row) =>
    post('/confirm-task', { draftId: 'draft-1-draft-1-draft-1', ...body })

  it('copies the draft English through with its labels and no translation call', async () => {
    pendingDraft = {
      title: 'Water the plantains in block A',
      farmId: 'farm-1',
      userId: 'user-owner',
      expiresAt: Date.now() + 600_000,
      sourceLocale: 'fr',
      translationStatus: 'done',
    }

    const res = await confirm({ title: 'Water the plantains in block A' })

    expect(res.status).toBe(201)
    expect(insertedTask()).toMatchObject({
      title: 'Water the plantains in block A',
      sourceLocale: 'fr',
      translationStatus: 'done',
    })
    expect(canonicalCalls).not.toHaveBeenCalled()
    expect(completeChat).not.toHaveBeenCalled()
  })

  it('inherits a pending draft label instead of claiming the row is English', async () => {
    pendingDraft = {
      title: 'Arroser les bananiers du bloc A',
      farmId: 'farm-1',
      userId: 'user-owner',
      expiresAt: Date.now() + 600_000,
      sourceLocale: 'fr',
      translationStatus: 'pending',
    }

    const res = await confirm({ title: 'Arroser les bananiers du bloc A' })

    expect(res.status).toBe(201)
    expect(insertedTask()).toMatchObject({
      title: 'Arroser les bananiers du bloc A',
      sourceLocale: 'fr',
      translationStatus: 'pending',
    })
    expect(canonicalCalls).not.toHaveBeenCalled()
  })

  it('normalizes text the user rewrote in the confirmation form', async () => {
    pendingDraft = {
      title: 'Water the plantains in block A',
      farmId: 'farm-1',
      userId: 'user-owner',
      expiresAt: Date.now() + 600_000,
      sourceLocale: 'en',
      translationStatus: 'done',
    }
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await confirm({
      title: 'Réparer la clôture du poulailler',
      description: 'Trois poules sont mortes cette nuit',
    })

    expect(res.status).toBe(201)
    expect(insertedTask()).toMatchObject({
      title: 'Repair the poultry house fence',
      description: 'Three hens died last night',
      sourceLocale: 'fr',
      translationStatus: 'done',
    })
  })

  it('stores rewritten text as typed and marked pending when translation fails', async () => {
    isLlmConfigured.mockReturnValue(false)
    pendingDraft = {
      title: 'Water the plantains in block A',
      farmId: 'farm-1',
      userId: 'user-owner',
      expiresAt: Date.now() + 600_000,
      sourceLocale: 'en',
      translationStatus: 'done',
    }
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await confirm({ title: 'Réparer la clôture du poulailler' })
    const body = (await res.json()) as { task: Row }

    expect(res.status).toBe(201)
    expect(insertedTask()).toMatchObject({
      title: 'Réparer la clôture du poulailler',
      sourceLocale: 'fr',
      translationStatus: 'pending',
    })
    // The author reads back their own words either way.
    expect(body.task.title).toBe('Réparer la clôture du poulailler')
  })

  it('leaves a rejected draft alone', async () => {
    pendingDraft = null

    const res = await confirm({ title: 'Water the plantains in block A' })

    expect(res.status).toBe(400)
    expect(inserted).toHaveLength(0)
  })
})

describe('POST /ai/summarize-incident - viewer locale on read', () => {
  it('renders the English summary for a French reader in one batched call', async () => {
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await post('/summarize-incident', { incidentText: INCIDENT_TEXT })
    const body = (await res.json()) as { summary: Row; incidentText: string }

    expect(res.status).toBe(200)
    expect(viewerBatchCalls).toHaveBeenCalledTimes(1)
    expect(body.summary.summaryText).toBe(
      'Trois oiseaux sont morts dans l’enclos B après deux jours de léthargie.',
    )
    expect(body.summary.recommendedActions).toEqual([
      'Isolez l’enclos et désinfectez les abreuvoirs',
      'Appelez le vétérinaire aujourd’hui',
    ])
  })

  it('leaves the severity and category keys the UI switches on alone', async () => {
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await post('/summarize-incident', { incidentText: INCIDENT_TEXT })
    const body = (await res.json()) as { summary: Row; incidentText: string }

    expect(body.summary).toMatchObject({ severity: 'high', category: 'livestock_mortality' })
    // The reporter's own words are echoed exactly as written.
    expect(body.incidentText).toBe(INCIDENT_TEXT)
  })

  it('does no translation work at all for an English reader', async () => {
    queueSelect('users', [{ preferredLocale: 'en' }])

    const res = await post('/summarize-incident', { incidentText: INCIDENT_TEXT })
    const body = (await res.json()) as { summary: Row }

    expect(viewerBatchCalls).not.toHaveBeenCalled()
    expect(completeChat).toHaveBeenCalledTimes(1)
    expect(selectLog).not.toContain('content_translations')
    expect(body.summary.summaryText).toBe(INCIDENT_JSON.summaryText)
  })

  it('never normalizes the model output on the way in', async () => {
    queueSelect('users', [{ preferredLocale: 'fr' }])

    await post('/summarize-incident', { incidentText: INCIDENT_TEXT })

    expect(canonicalCalls).not.toHaveBeenCalled()
  })
})

describe('POST /ai/diagnose-livestock - English generation, viewer locale on read', () => {
  const symptoms = { species: 'noilers', symptoms: 'Bloody droppings and the birds will not eat' }

  it('pins generation to English instead of the language of the request', async () => {
    queueSelect('farms', [{ location: 'Ibadan' }])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    await post('/diagnose-livestock', symptoms)

    const [systemPrompt] = completeChat.mock.calls[0] as [string]
    expect(systemPrompt).toContain('write every string in the JSON in English')
  })

  it('renders the whole diagnosis for a French reader in one batched call', async () => {
    queueSelect('farms', [{ location: 'Ibadan' }])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await post('/diagnose-livestock', symptoms)
    const body = (await res.json()) as { diagnosis: Row }
    const diagnosis = body.diagnosis as unknown as {
      likelyCauses: Row[]
      immediateActions: string[]
      treatments: Row[]
      prevention: string[]
      urgency: string
      callVet: boolean
      summary: string
    }

    expect(res.status).toBe(200)
    expect(viewerBatchCalls).toHaveBeenCalledTimes(1)
    expect(diagnosis.likelyCauses[0]).toMatchObject({
      name: 'Coccidiose',
      why: 'Les fientes sanglantes chez les jeunes oiseaux y renvoient',
      likelihood: 'high',
    })
    expect(diagnosis.immediateActions).toEqual(['Isolez les oiseaux atteints aujourd’hui'])
    expect(diagnosis.treatments[0]).toMatchObject({
      name: 'Amprolium dans l’eau de boisson',
      usage: 'Mélanger pendant cinq jours',
      note: 'Confirmez la dose avec votre agrovet',
    })
    expect(diagnosis.prevention).toEqual(['Gardez la litière sèche'])
    expect(diagnosis.urgency).toBe('high')
    expect(diagnosis.callVet).toBe(true)
    expect(diagnosis.summary).toContain(
      'Trois oiseaux ont des fientes sanglantes et refusent de manger.',
    )
  })

  it('appends the close line from the table rather than translating it', async () => {
    queueSelect('farms', [{ location: 'Ibadan' }])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await post('/diagnose-livestock', symptoms)
    const body = (await res.json()) as { diagnosis: { summary: string }; closeLine: string }

    expect(body.diagnosis.summary).toContain('Si les symptômes persistent, consultez un vétérinaire.')
    expect(body.closeLine).toBe('Si les symptômes persistent, consultez un vétérinaire.')
    expect(viewerBatchCalls).toHaveBeenCalledWith(
      expect.objectContaining({
        texts: expect.not.arrayContaining(['If the symptoms persist, see a vet.']),
      }),
    )
  })

  it('searches the marketplace with the English treatment name', async () => {
    queueSelect('farms', [{ location: 'Ibadan' }])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    await post('/diagnose-livestock', symptoms)

    expect(resolveMarketplaceProducts).toHaveBeenCalledWith(
      expect.objectContaining({ needQuery: 'Amprolium in drinking water', locale: 'fr' }),
    )
  })

  it('does no translation work at all for an English reader', async () => {
    queueSelect('farms', [{ location: 'Ibadan' }])
    queueSelect('users', [{ preferredLocale: 'en' }])

    const res = await post('/diagnose-livestock', symptoms)
    const body = (await res.json()) as { diagnosis: { summary: string; treatments: Row[] } }

    expect(viewerBatchCalls).not.toHaveBeenCalled()
    expect(completeChat).toHaveBeenCalledTimes(1)
    expect(selectLog).not.toContain('content_translations')
    expect(body.diagnosis.treatments[0]).toMatchObject({ name: 'Amprolium in drinking water' })
    expect(body.diagnosis.summary).toContain('If the symptoms persist, see a vet.')
  })
})

describe('POST /ai/diagnose-crop - English generation, viewer locale on read', () => {
  const request = {
    cropType: 'plantain',
    notes: 'Yellow leaves on the youngest plants',
    imageUrl: 'https://example.test/leaf.jpg',
  }

  it('pins generation to English and renders the result for a French reader', async () => {
    queueSelect('farms', [{ location: 'Ibadan' }])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await post('/diagnose-crop', request)
    const body = (await res.json()) as { diagnosis: { summary: string; likelyCauses: Row[] } }

    const [systemPrompt] = completeChatVision.mock.calls[0] as [string]
    expect(systemPrompt).toContain('write every string in the JSON in English')
    expect(res.status).toBe(200)
    expect(viewerBatchCalls).toHaveBeenCalledTimes(1)
    expect(body.diagnosis.likelyCauses[0]).toMatchObject({ name: 'Coccidiose' })
    expect(body.diagnosis.summary).toContain(
      'Si les symptômes persistent, consultez un vétérinaire ou un agent de vulgarisation.',
    )
  })

  it('does no translation work at all for an English reader', async () => {
    queueSelect('farms', [{ location: 'Ibadan' }])
    queueSelect('users', [{ preferredLocale: 'en' }])

    await post('/diagnose-crop', request)

    expect(viewerBatchCalls).not.toHaveBeenCalled()
    expect(selectLog).not.toContain('content_translations')
  })
})
