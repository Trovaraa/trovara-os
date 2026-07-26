import { Hono } from 'hono'
import { getTableName } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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
const updates: { table: string; patch: Row }[] = []

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
      update: (table: unknown) => ({
        set: (patch: Row) => {
          const name = nameOf(table)
          updates.push({ table: name, patch })
          return { where: () => ({ returning: async () => [{ id: `${name}-1`, ...patch }] }) }
        },
      }),
      delete: () => ({ where: async () => undefined }),
    },
  }
})

const completeChat = vi.fn()
const isLlmConfigured = vi.fn(() => true)
/** Highest number of translation calls in flight at once. */
let maxInFlight = 0
let inFlight = 0

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
 * the tests see its real short-circuits. The spies count how often the routes
 * enter the service at all.
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

const FRENCH_TO_ENGLISH: Record<string, string> = {
  'Contrôle hebdomadaire du bloc': 'Weekly block inspection',
  'Faire le tour du bloc et noter les dégâts': 'Walk the block and note any damage',
  'Vérifier le goutte-à-goutte': 'Check the drip line',
  'Compter les plants malades': 'Count the sick plants',
  'Photographier les feuilles jaunes': 'Photograph the yellow leaves',
  'Noter la hauteur moyenne': 'Note the average height',
  'Ramasser les fruits tombés': 'Collect the fallen fruit',
  'Nettoyer les outils': 'Clean the tools',
}

const ENGLISH_TO_FRENCH: Record<string, string> = {
  'Weekly block inspection': 'Contrôle hebdomadaire du bloc',
  'Walk the block and note any damage': 'Faire le tour du bloc et noter les dégâts',
  'Check the drip line': 'Vérifier le goutte-à-goutte',
  'Count the sick plants': 'Compter les plants malades',
  'Harvest ripe bunches': 'Récolter les régimes mûrs',
}

function templateRow(overrides: Row = {}): Row {
  return {
    id: 'tpl-1',
    farmId: 'farm-1',
    name: 'Weekly block inspection',
    description: 'Walk the block and note any damage',
    cropType: 'plantain',
    checklist: ['Check the drip line', 'Count the sick plants'],
    defaultDurationHours: 2,
    actionType: null,
    systemTemplateKey: null,
    defaultPayload: null,
    sourceLocale: 'en',
    translationStatus: 'done',
    createdAt: new Date('2026-07-01T08:00:00Z'),
    ...overrides,
  }
}

function scheduleRow(overrides: Row = {}): Row {
  return {
    id: 'sched-1',
    farmId: 'farm-1',
    templateId: 'tpl-1',
    recurrence: 'weekly',
    assignedToId: 'user-worker',
    plotId: 'plot-1',
    active: true,
    nextRunAt: new Date('2026-07-01T06:00:00Z'),
    createdAt: new Date('2026-07-01T06:00:00Z'),
    ...overrides,
  }
}

async function app() {
  const { templateRoutes } = await import('./templates.js')
  const instance = new Hono()
  instance.route('/', templateRoutes)
  return instance
}

async function post(path: string, body?: unknown) {
  return (await app()).request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function patch(path: string, body: unknown) {
  return (await app()).request(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function insertedRow(table: string): Row {
  const row = inserted.find((entry) => entry.table === table)
  expect(row).toBeDefined()
  return row!.values
}

function templatePatch(): Row {
  const row = updates.find((entry) => entry.table === 'task_templates')
  expect(row).toBeDefined()
  return row!.patch
}

beforeEach(() => {
  vi.clearAllMocks()
  selectQueue.clear()
  selectLog.length = 0
  inserted.length = 0
  updates.length = 0
  maxInFlight = 0
  inFlight = 0
  isLlmConfigured.mockReturnValue(true)
  completeChat.mockImplementation(async (system: string, text: string) => {
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    await new Promise((resolve) => setImmediate(resolve))
    inFlight -= 1
    const table = /into English/i.test(system) ? FRENCH_TO_ENGLISH : ENGLISH_TO_FRENCH
    return { text: table[text] ?? `[${text}]`, model: 'test' }
  })
  sessionUser = {
    id: 'user-owner',
    farmId: 'farm-1',
    role: 'owner',
    name: 'Owner',
    email: 'owner@trovara.farm',
  }
})

describe('POST /templates - canonical English on write', () => {
  it('stores English and the author locale for a French template', async () => {
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await post('/templates', {
      name: 'Contrôle hebdomadaire du bloc',
      description: 'Faire le tour du bloc et noter les dégâts',
      checklist: ['Vérifier le goutte-à-goutte', 'Compter les plants malades'],
    })

    expect(res.status).toBe(201)
    expect(insertedRow('task_templates')).toMatchObject({
      name: 'Weekly block inspection',
      description: 'Walk the block and note any damage',
      checklist: ['Check the drip line', 'Count the sick plants'],
      sourceLocale: 'fr',
      translationStatus: 'done',
    })
  })

  it('stores an English template unchanged without any translation call', async () => {
    queueSelect('users', [{ preferredLocale: 'en' }])

    const res = await post('/templates', {
      name: 'Weekly inspection of the block',
      description: 'Walk the block and note any damage',
      checklist: ['Check the drip line'],
    })

    expect(res.status).toBe(201)
    expect(insertedRow('task_templates')).toMatchObject({
      name: 'Weekly inspection of the block',
      description: 'Walk the block and note any damage',
      checklist: ['Check the drip line'],
      sourceLocale: 'en',
      translationStatus: 'done',
    })
    expect(completeChat).not.toHaveBeenCalled()
  })

  // 'Weekly block inspection' is three nouns, two of which are spelled the same
  // in French. Nothing in it says which language it is, so the row says so and
  // the retry job settles it later. Claiming 'en' is the mistake that used to
  // strand French in English columns, and a label is cheaper to fix than text.
  it('defers a terse name it cannot place instead of claiming English', async () => {
    queueSelect('users', [{ preferredLocale: 'en' }])

    const res = await post('/templates', {
      name: 'Weekly block inspection',
      description: 'Irrigation pump repair',
      checklist: [],
    })

    expect(res.status).toBe(201)
    expect(insertedRow('task_templates')).toMatchObject({
      name: 'Weekly block inspection',
      description: 'Irrigation pump repair',
      sourceLocale: null,
      translationStatus: 'pending',
    })
    // Deferring is free: the model is the retry job's problem, not the author's.
    expect(completeChat).not.toHaveBeenCalled()
  })

  it('succeeds with the original text marked pending when the LLM is unavailable', async () => {
    isLlmConfigured.mockReturnValue(false)
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await post('/templates', {
      name: 'Contrôle hebdomadaire du bloc',
      description: 'Faire le tour du bloc et noter les dégâts',
    })

    expect(res.status).toBe(201)
    expect(insertedRow('task_templates')).toMatchObject({
      name: 'Contrôle hebdomadaire du bloc',
      description: 'Faire le tour du bloc et noter les dégâts',
      sourceLocale: 'fr',
      translationStatus: 'pending',
    })
  })

  it('marks the row pending when only one checklist item fails', async () => {
    queueSelect('users', [{ preferredLocale: 'fr' }])
    completeChat.mockImplementation(async (_system: string, text: string) => {
      if (text === 'Compter les plants malades') throw new Error('upstream 503')
      return { text: FRENCH_TO_ENGLISH[text], model: 'test' }
    })

    const res = await post('/templates', {
      name: 'Contrôle hebdomadaire du bloc',
      checklist: ['Vérifier le goutte-à-goutte', 'Compter les plants malades'],
    })

    expect(res.status).toBe(201)
    expect(insertedRow('task_templates')).toMatchObject({
      name: 'Weekly block inspection',
      checklist: ['Check the drip line', 'Compter les plants malades'],
      translationStatus: 'pending',
    })
  })

  it('returns the author their own words while storing the English', async () => {
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await post('/templates', {
      name: 'Contrôle hebdomadaire du bloc',
      checklist: ['Vérifier le goutte-à-goutte'],
    })
    const body = (await res.json()) as { template: Row }

    expect(body.template.name).toBe('Contrôle hebdomadaire du bloc')
    expect(body.template.checklist).toEqual(['Vérifier le goutte-à-goutte'])
    expect(insertedRow('task_templates').name).toBe('Weekly block inspection')
  })

  it('caps how many checklist translations run at once', async () => {
    queueSelect('users', [{ preferredLocale: 'fr' }])

    await post('/templates', {
      name: 'Contrôle hebdomadaire du bloc',
      description: 'Faire le tour du bloc et noter les dégâts',
      checklist: [
        'Vérifier le goutte-à-goutte',
        'Compter les plants malades',
        'Photographier les feuilles jaunes',
        'Noter la hauteur moyenne',
        'Ramasser les fruits tombés',
        'Nettoyer les outils',
      ],
    })

    expect(completeChat).toHaveBeenCalledTimes(8)
    expect(maxInFlight).toBeLessThanOrEqual(4)
  })

  it('resolves a French crop name to its lookup key without an LLM', async () => {
    queueSelect('users', [{ preferredLocale: 'fr' }])

    await post('/templates', {
      name: 'Weekly block inspection',
      cropType: 'noix de coco',
    })

    expect(insertedRow('task_templates').cropType).toBe('coconut')
    // The lexicon is deterministic: the crop name never reaches the translator.
    expect(canonicalCalls).not.toHaveBeenCalledWith(
      expect.objectContaining({ text: 'noix de coco' }),
    )
    expect(completeChat).not.toHaveBeenCalledWith(expect.anything(), 'noix de coco')
  })

  it('stores a crop it has no playbook for exactly as typed', async () => {
    queueSelect('users', [{ preferredLocale: 'en' }])

    await post('/templates', { name: 'Weekly block inspection', cropType: 'Tomate' })

    expect(insertedRow('task_templates').cropType).toBe('Tomate')
  })

  it('leaves the structured columns alone', async () => {
    queueSelect('users', [{ preferredLocale: 'fr' }])

    await post('/templates', {
      name: 'Contrôle hebdomadaire du bloc',
      defaultDurationHours: 3,
    })

    expect(insertedRow('task_templates')).toMatchObject({ defaultDurationHours: 3 })
  })
})

describe('PATCH /templates/:id - canonical English on write', () => {
  it('stores a French edit in English with the author locale', async () => {
    queueSelect('task_templates', [templateRow()])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await patch('/templates/tpl-1', {
      description: 'Faire le tour du bloc et noter les dégâts',
    })

    expect(res.status).toBe(200)
    expect(templatePatch()).toMatchObject({
      description: 'Walk the block and note any damage',
      sourceLocale: 'fr',
      translationStatus: 'done',
    })
  })

  it('persists a failed edit as the original text marked pending and still succeeds', async () => {
    isLlmConfigured.mockReturnValue(false)
    queueSelect('task_templates', [templateRow()])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await patch('/templates/tpl-1', {
      name: 'Contrôle hebdomadaire du bloc',
    })

    expect(res.status).toBe(200)
    expect(templatePatch()).toMatchObject({
      name: 'Contrôle hebdomadaire du bloc',
      sourceLocale: 'fr',
      translationStatus: 'pending',
    })
  })

  it('does not clear a pending row when a later English edit succeeds', async () => {
    queueSelect('task_templates', [templateRow({ translationStatus: 'pending', sourceLocale: 'fr' })])
    queueSelect('users', [{ preferredLocale: 'en' }])

    await patch('/templates/tpl-1', { name: 'Weekly block inspection' })

    const applied = templatePatch()
    expect(applied.translationStatus).toBeUndefined()
    expect(applied.sourceLocale).toBeUndefined()
    expect(applied.name).toBe('Weekly block inspection')
  })

  it('does not relabel the row when no prose changes', async () => {
    queueSelect('task_templates', [templateRow()])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    await patch('/templates/tpl-1', { defaultDurationHours: 5 })

    const applied = templatePatch()
    expect(applied).toEqual({ defaultDurationHours: 5 })
    expect(completeChat).not.toHaveBeenCalled()
  })

  it('canonicalizes an edited crop name and never translates it', async () => {
    queueSelect('task_templates', [templateRow()])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    await patch('/templates/tpl-1', { cropType: 'cocotier' })

    expect(templatePatch()).toEqual({ cropType: 'coconut' })
    expect(completeChat).not.toHaveBeenCalled()
  })
})

describe('GET /templates - viewer locale on read', () => {
  it('translates names, descriptions and checklists in one batched call', async () => {
    queueSelect('task_templates', [
      templateRow(),
      templateRow({ id: 'tpl-2', name: 'Harvest ripe bunches', description: null, checklist: null }),
    ])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await (await app()).request('/templates')
    const body = (await res.json()) as { templates: Row[] }

    expect(res.status).toBe(200)
    expect(viewerBatchCalls).toHaveBeenCalledTimes(1)
    expect(selectLog.filter((table) => table === 'content_translations')).toHaveLength(1)
    expect(body.templates[0]).toMatchObject({
      name: 'Contrôle hebdomadaire du bloc',
      description: 'Faire le tour du bloc et noter les dégâts',
      checklist: ['Vérifier le goutte-à-goutte', 'Compter les plants malades'],
    })
    expect(body.templates[1].name).toBe('Récolter les régimes mûrs')
  })

  it('leaves ids, crop keys and structured columns untouched', async () => {
    queueSelect('task_templates', [templateRow()])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const body = (await (await app()).request('/templates')).json() as Promise<{ templates: Row[] }>
    const template = (await body).templates[0]

    expect(template).toMatchObject({
      id: 'tpl-1',
      cropType: 'plantain',
      defaultDurationHours: 2,
    })
    expect(viewerBatchCalls).toHaveBeenCalledWith(
      expect.objectContaining({
        texts: [
          'Weekly block inspection',
          'Walk the block and note any damage',
          'Check the drip line',
          'Count the sick plants',
        ],
      }),
    )
  })

  it('does no translation work at all for an English viewer', async () => {
    queueSelect('task_templates', [templateRow(), templateRow({ id: 'tpl-2' })])
    queueSelect('users', [{ preferredLocale: 'en' }])

    const res = await (await app()).request('/templates')
    const body = (await res.json()) as { templates: Row[] }

    expect(viewerBatchCalls).not.toHaveBeenCalled()
    expect(completeChat).not.toHaveBeenCalled()
    expect(selectLog).not.toContain('content_translations')
    expect(body.templates[0].name).toBe('Weekly block inspection')
  })

  it('translates a single template for a French viewer', async () => {
    queueSelect('task_templates', [templateRow()])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await (await app()).request('/templates/tpl-1')
    const body = (await res.json()) as { template: Row }

    expect(res.status).toBe(200)
    expect(viewerBatchCalls).toHaveBeenCalledTimes(1)
    expect(body.template.name).toBe('Contrôle hebdomadaire du bloc')
  })
})

describe('GET /schedules - viewer locale on read', () => {
  it('translates the template name only, in one batched call', async () => {
    queueSelect('recurring_schedules', [
      {
        id: 'sched-1',
        templateId: 'tpl-1',
        templateName: 'Weekly block inspection',
        recurrence: 'weekly',
        assignedToId: 'user-worker',
        assignedToName: 'Awa Diallo',
        plotId: 'plot-1',
        plotName: 'Block A',
        active: true,
        nextRunAt: new Date('2026-07-08T06:00:00Z'),
        createdAt: new Date('2026-07-01T06:00:00Z'),
      },
    ])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await (await app()).request('/schedules')
    const body = (await res.json()) as { schedules: Row[] }

    expect(res.status).toBe(200)
    expect(viewerBatchCalls).toHaveBeenCalledTimes(1)
    expect(viewerBatchCalls).toHaveBeenCalledWith(
      expect.objectContaining({ texts: ['Weekly block inspection'] }),
    )
    expect(body.schedules[0]).toMatchObject({
      templateName: 'Contrôle hebdomadaire du bloc',
      recurrence: 'weekly',
      assignedToName: 'Awa Diallo',
      plotName: 'Block A',
    })
  })
})

describe('POST /generate-tasks - copying template prose into tasks', () => {
  it('copies the English through with the template labels and no translation call', async () => {
    queueSelect('recurring_schedules', [{ schedule: scheduleRow(), template: templateRow() }])
    queueSelect('users', [{ preferredLocale: 'en' }])

    const res = await post('/generate-tasks')
    const body = (await res.json()) as { tasks: Row[]; count: number }

    expect(res.status).toBe(200)
    expect(body.count).toBe(1)
    expect(insertedRow('tasks')).toMatchObject({
      title: 'Weekly block inspection',
      description: 'Walk the block and note any damage',
      sourceLocale: 'en',
      translationStatus: 'done',
      templateId: 'tpl-1',
    })
    expect(canonicalCalls).not.toHaveBeenCalled()
    expect(completeChat).not.toHaveBeenCalled()
  })

  it('inherits a pending template label so the retry job picks the task up', async () => {
    queueSelect('recurring_schedules', [
      {
        schedule: scheduleRow(),
        template: templateRow({
          name: 'Contrôle hebdomadaire du bloc',
          description: null,
          checklist: null,
          sourceLocale: 'fr',
          translationStatus: 'pending',
        }),
      },
    ])
    queueSelect('users', [{ preferredLocale: 'en' }])

    await post('/generate-tasks')

    expect(insertedRow('tasks')).toMatchObject({
      title: 'Contrôle hebdomadaire du bloc',
      sourceLocale: 'fr',
      translationStatus: 'pending',
    })
    expect(canonicalCalls).not.toHaveBeenCalled()
  })

  it('marks the task pending when a template claiming done still holds French', async () => {
    queueSelect('recurring_schedules', [
      {
        schedule: scheduleRow(),
        template: templateRow({
          name: 'Contrôle hebdomadaire du bloc',
          description: null,
          checklist: null,
          sourceLocale: null,
          translationStatus: 'done',
        }),
      },
    ])
    queueSelect('users', [{ preferredLocale: 'en' }])

    await post('/generate-tasks')

    expect(insertedRow('tasks')).toMatchObject({
      title: 'Contrôle hebdomadaire du bloc',
      sourceLocale: 'fr',
      translationStatus: 'pending',
    })
    expect(completeChat).not.toHaveBeenCalled()
  })

  it('advances the schedule and returns generated titles in the caller language', async () => {
    queueSelect('recurring_schedules', [{ schedule: scheduleRow(), template: templateRow() }])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await post('/generate-tasks')
    const body = (await res.json()) as { tasks: Row[] }

    expect(body.tasks[0].title).toBe('Contrôle hebdomadaire du bloc')
    expect(insertedRow('tasks').title).toBe('Weekly block inspection')
    expect(viewerBatchCalls).toHaveBeenCalledTimes(1)
    expect(updates.some((entry) => entry.table === 'recurring_schedules')).toBe(true)
  })
})

describe('GET /lifecycles', () => {
  /** Stage rows as the join hands them over: one row per stage, cycles adjacent. */
  function stageRow(cropCycleId: string, stage: string, durationDays: number, over: Row = {}): Row {
    return {
      cropCycleId,
      cropType: 'yam',
      plantedAt: new Date('2026-02-01T08:00:00Z'),
      plotName: 'Block A',
      stage,
      durationDays,
      source: 'generated',
      ...over,
    }
  }

  it('serves the lifecycles this farm own cycles are running on', async () => {
    queueSelect('crop_cycle_stages', [
      stageRow('cycle-1', 'planted', 14),
      stageRow('cycle-1', 'vegetative', 90, { source: 'manual' }),
      stageRow('cycle-2', 'planted', 30, { cropType: 'coconut' }),
    ])

    const res = await (await app()).request('/lifecycles')
    const body = (await res.json()) as { lifecycles: Row[] }

    expect(res.status).toBe(200)
    expect(body.lifecycles).toEqual([
      expect.objectContaining({
        cropCycleId: 'cycle-1',
        cropType: 'yam',
        plotName: 'Block A',
        totalDays: 104,
        stages: [
          { stage: 'planted', durationDays: 14, source: 'generated' },
          { stage: 'vegetative', durationDays: 90, source: 'manual' },
        ],
      }),
      expect.objectContaining({ cropCycleId: 'cycle-2', cropType: 'coconut', totalDays: 30 }),
    ])
  })

  it('no longer hands back the generic outlines as if they were the farm agronomy', async () => {
    const res = await (await app()).request('/lifecycles')
    const body = (await res.json()) as { lifecycles: Row[] }

    // A farm that has established no lifecycle yet has none, and saying so is
    // the whole point: the two constants this used to serve were somebody
    // else's plantain and coconut.
    expect(body.lifecycles).toEqual([])
    expect(JSON.stringify(body)).not.toMatch(/plantain/i)
  })
})
