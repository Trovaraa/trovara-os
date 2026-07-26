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

  const insert = (table: unknown) => ({
    values: (values: Row) => {
      inserted.push({ table: nameOf(table), values })
      return {
        returning: async () => [{ id: 'survey-new', ...values }],
        onConflictDoNothing: async () => undefined,
      }
    },
  })

  const update = (table: unknown) => ({
    set: (patch: Row) => {
      updates.push({ table: nameOf(table), patch })
      return { where: () => ({ returning: async () => [{ ...surveyRow(), ...patch }] }) }
    },
  })

  return {
    db: {
      select: selectChain,
      insert,
      update,
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ insert, update }),
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
 * The real viewer-locale service runs with only the LLM and db faked, so the
 * tests see its real short-circuits; the spy counts how often the routes batch.
 */
const viewerBatchCalls = vi.fn()

vi.mock('../lib/content-locale.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/content-locale.js')>()
  return {
    ...actual,
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
vi.mock('../lib/evidence-store.js', () => ({
  processEvidenceValue: vi.fn(async (_farmId: string, value: string | null) => value ?? null),
  validateEvidenceRef: vi.fn(() => true),
}))

const ENGLISH_TO_FRENCH: Record<string, string> = {
  'Leaves are yellowing on the east rows': 'Les feuilles jaunissent sur les rangs est',
  'Three seedlings died after the storm': 'Trois plants sont morts après la tempête',
  'Blurred photo, recount the block': 'Photo floue, recomptez le bloc',
}

/** The same pairs read the other way, for the canonical-English write path. */
const FRENCH_TO_ENGLISH: Record<string, string> = Object.fromEntries(
  Object.entries(ENGLISH_TO_FRENCH).map(([english, french]) => [french, english]),
)

function surveyRow(overrides: Row = {}): Row {
  return {
    id: 'survey-1',
    plotId: 'plot-1',
    taskId: null,
    cropType: 'coconut',
    cropVariety: 'Malayan Dwarf',
    plantCount: 120,
    minHeight: '40',
    maxHeight: '90',
    avgHeight: '65',
    heightUnit: 'cm',
    sampleSize: 20,
    countingMethod: 'full count',
    conditionNotes: 'Leaves are yellowing on the east rows',
    mortalityNotes: null,
    surveyedAt: new Date('2026-07-01T08:00:00Z'),
    latitude: '6.5244',
    longitude: '3.3792',
    recordedById: 'user-worker',
    recordedByName: 'Awa Diallo',
    verificationStatus: 'reported',
    verifiedById: null,
    verifiedAt: null,
    rejectionReason: null,
    sourceLocale: null,
    translationStatus: 'done',
    createdAt: new Date('2026-07-01T08:00:00Z'),
    ...overrides,
  }
}

function taskRow(overrides: Row = {}): Row {
  return {
    id: 'task-1',
    farmId: 'farm-1',
    plotId: 'plot-1',
    title: 'Count the coconut palms in Block A',
    status: 'in_progress',
    assignedToId: 'user-worker',
    completionNote: null,
    photoUrl: null,
    voiceUrl: null,
    latitude: null,
    longitude: null,
    sourceLocale: null,
    translationStatus: 'done',
    ...overrides,
  }
}

const PLOT_ID = '11111111-1111-4111-8111-111111111111'

async function app() {
  const { censusRoutes } = await import('./census.js')
  const instance = new Hono()
  instance.route('/census', censusRoutes)
  return instance
}

async function taskApp() {
  const { taskCensusRoutes } = await import('./census.js')
  const instance = new Hono()
  instance.route('/tasks', taskCensusRoutes)
  return instance
}

async function postCensus(body: unknown) {
  return (await app()).request('/census', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function insertedSurvey(): Row {
  const row = inserted.find((entry) => entry.table === 'crop_census_surveys')
  expect(row).toBeDefined()
  return row!.values
}

function patchFor(table: string): Row {
  const row = updates.find((entry) => entry.table === table)
  expect(row).toBeDefined()
  return row!.patch
}

beforeEach(() => {
  vi.clearAllMocks()
  selectQueue.clear()
  selectLog.length = 0
  inserted.length = 0
  updates.length = 0
  isLlmConfigured.mockReturnValue(true)
  completeChat.mockImplementation(async (_system: string, text: string) => ({
    text: ENGLISH_TO_FRENCH[text] ?? FRENCH_TO_ENGLISH[text] ?? `[${text}]`,
    model: 'test',
  }))
  sessionUser = {
    id: 'user-sup',
    farmId: 'farm-1',
    role: 'supervisor',
    name: 'Sup',
    email: 'sup@trovara.farm',
  }
})

describe('POST /census - canonical crop type on write', () => {
  it('stores a French crop name under its English lookup key', async () => {
    queueSelect('plots', [{ id: 'plot-1' }])

    const res = await postCensus({
      plotId: '11111111-1111-4111-8111-111111111111',
      cropType: 'noix de coco',
      plantCount: 120,
    })

    expect(res.status).toBe(201)
    expect(insertedSurvey().cropType).toBe('coconut')
  })

  it('stores a crop we have no playbook for exactly as typed', async () => {
    queueSelect('plots', [{ id: 'plot-1' }])

    const res = await postCensus({
      plotId: '11111111-1111-4111-8111-111111111111',
      cropType: 'maïs',
      plantCount: 900,
    })

    expect(res.status).toBe(201)
    expect(insertedSurvey().cropType).toBe('maïs')
  })
})

/**
 * The service is forbidden from calling an LLM, so the route is the only place
 * worker prose can be turned into English. A row holding another language while
 * claiming 'done' is unrecoverable: the retry sweep filters on status.
 */
describe('POST /census - canonical English on write', () => {
  it('stores a French note as English with the locale detected from the text', async () => {
    queueSelect('plots', [{ id: 'plot-1' }])
    // Everyone starts on the 'en' default, so it is not trusted as a hint.
    queueSelect('users', [{ preferredLocale: 'en' }])

    const res = await postCensus({
      plotId: PLOT_ID,
      cropType: 'coconut',
      plantCount: 120,
      mortalityNotes: 'Trois plants sont morts après la tempête',
    })
    const body = (await res.json()) as { survey: Row }

    expect(res.status).toBe(201)
    expect(insertedSurvey()).toMatchObject({
      mortalityNotes: 'Three seedlings died after the storm',
      sourceLocale: 'fr',
      translationStatus: 'done',
    })
    // The author reads back their own words.
    expect(body.survey.mortalityNotes).toBe('Trois plants sont morts après la tempête')
  })

  it('trusts an explicitly non-English preference as the source locale', async () => {
    queueSelect('plots', [{ id: 'plot-1' }])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    // Nothing in this sentence gives the language away, so only the hint can.
    const res = await postCensus({
      plotId: PLOT_ID,
      cropType: 'coconut',
      plantCount: 120,
      conditionNotes: 'Les feuilles jaunissent sur les rangs est',
    })

    expect(res.status).toBe(201)
    expect(insertedSurvey()).toMatchObject({
      conditionNotes: 'Leaves are yellowing on the east rows',
      sourceLocale: 'fr',
      translationStatus: 'done',
    })
  })

  it('stores the original as pending when translation fails, and still succeeds', async () => {
    isLlmConfigured.mockReturnValue(false)
    queueSelect('plots', [{ id: 'plot-1' }])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await postCensus({
      plotId: PLOT_ID,
      cropType: 'coconut',
      plantCount: 120,
      conditionNotes: 'Les feuilles jaunissent sur les rangs est',
    })

    expect(res.status).toBe(201)
    expect(completeChat).not.toHaveBeenCalled()
    expect(insertedSurvey()).toMatchObject({
      conditionNotes: 'Les feuilles jaunissent sur les rangs est',
      sourceLocale: 'fr',
      translationStatus: 'pending',
    })
  })

  it('leaves one field pending without losing the other', async () => {
    queueSelect('plots', [{ id: 'plot-1' }])
    queueSelect('users', [{ preferredLocale: 'fr' }])
    completeChat.mockImplementation(async (_system: string, text: string) => {
      if (text === 'Les feuilles jaunissent sur les rangs est') throw new Error('llm down')
      return { text: FRENCH_TO_ENGLISH[text] ?? `[${text}]`, model: 'test' }
    })

    const res = await postCensus({
      plotId: PLOT_ID,
      cropType: 'coconut',
      plantCount: 120,
      conditionNotes: 'Les feuilles jaunissent sur les rangs est',
      mortalityNotes: 'Trois plants sont morts après la tempête',
    })

    expect(res.status).toBe(201)
    expect(insertedSurvey()).toMatchObject({
      conditionNotes: 'Les feuilles jaunissent sur les rangs est',
      mortalityNotes: 'Three seedlings died after the storm',
      // One pair of columns for the row, so a single failure keeps it pending.
      translationStatus: 'pending',
    })
  })

  it('sends neither the crop type nor the counting method to the translator', async () => {
    queueSelect('plots', [{ id: 'plot-1' }])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await postCensus({
      plotId: PLOT_ID,
      cropType: 'noix de coco',
      plantCount: 120,
      countingMethod: 'comptage complet',
    })

    expect(res.status).toBe(201)
    expect(completeChat).not.toHaveBeenCalled()
    // The crop type is a lookup key with its own lexicon; the counting method is
    // a short descriptor the retry job does not sweep, so it stays verbatim.
    expect(insertedSurvey()).toMatchObject({
      cropType: 'coconut',
      countingMethod: 'comptage complet',
    })
    expect(insertedSurvey()).not.toHaveProperty('sourceLocale')
    expect(insertedSurvey()).not.toHaveProperty('translationStatus')
  })

  it('leaves an English note and the schema defaults alone', async () => {
    queueSelect('plots', [{ id: 'plot-1' }])
    queueSelect('users', [{ preferredLocale: 'en' }])

    const res = await postCensus({
      plotId: PLOT_ID,
      cropType: 'coconut',
      plantCount: 120,
      conditionNotes: 'Leaves are yellowing on the east rows',
    })

    expect(res.status).toBe(201)
    expect(completeChat).not.toHaveBeenCalled()
    expect(insertedSurvey()).toMatchObject({
      conditionNotes: 'Leaves are yellowing on the east rows',
      translationStatus: 'done',
    })
  })
})

describe('POST /census/:id/verify - canonical English on write', () => {
  async function verify(body: unknown) {
    return (await app()).request('/census/survey-1/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('stores a French rejection reason as English and echoes what was typed', async () => {
    queueSelect('crop_census_surveys', [surveyRow({ recordedById: 'user-worker' })])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await verify({
      status: 'rejected',
      rejectionReason: 'Photo floue, recomptez le bloc',
    })
    const body = (await res.json()) as { survey: Row }

    expect(res.status).toBe(200)
    expect(patchFor('crop_census_surveys')).toMatchObject({
      rejectionReason: 'Blurred photo, recount the block',
      sourceLocale: 'fr',
      translationStatus: 'done',
    })
    expect(body.survey.rejectionReason).toBe('Photo floue, recomptez le bloc')
  })

  it('escalates the row to pending when the reason cannot be translated', async () => {
    isLlmConfigured.mockReturnValue(false)
    queueSelect('crop_census_surveys', [surveyRow({ recordedById: 'user-worker' })])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await verify({
      status: 'rejected',
      rejectionReason: 'Photo floue, recomptez le bloc',
    })

    expect(res.status).toBe(200)
    expect(patchFor('crop_census_surveys')).toMatchObject({
      rejectionReason: 'Photo floue, recomptez le bloc',
      sourceLocale: 'fr',
      translationStatus: 'pending',
    })
  })

  it('leaves the locale pair of an approval alone, since it writes no text', async () => {
    queueSelect('crop_census_surveys', [surveyRow({ recordedById: 'user-worker' })])
    // An English verifier, so the response needs no rendering either and the
    // only LLM call this could produce would be a spurious canonicalization.
    queueSelect('users', [{ preferredLocale: 'en' }])

    const res = await verify({ status: 'verified' })

    expect(res.status).toBe(200)
    expect(completeChat).not.toHaveBeenCalled()
    const patch = patchFor('crop_census_surveys')
    expect(patch).not.toHaveProperty('sourceLocale')
    expect(patch).not.toHaveProperty('translationStatus')
  })
})

describe('POST /tasks/:id/census-submission - canonical English on write', () => {
  it('stores the survey notes and the task note as English under one locale pair', async () => {
    queueSelect('tasks', [taskRow()])
    queueSelect('tasks', [taskRow()])
    queueSelect('plots', [{ id: 'plot-1' }])
    queueSelect('crop_census_evidence', [])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await (await taskApp()).request('/tasks/task-1/census-submission', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        plotId: PLOT_ID,
        cropType: 'noix de coco',
        plantCount: 120,
        conditionNotes: 'Les feuilles jaunissent sur les rangs est',
        completionNote: 'Photo floue, recomptez le bloc',
      }),
    })
    const body = (await res.json()) as { survey: Row }

    expect(res.status).toBe(201)
    expect(insertedSurvey()).toMatchObject({
      cropType: 'coconut',
      conditionNotes: 'Leaves are yellowing on the east rows',
      sourceLocale: 'fr',
      translationStatus: 'done',
    })
    // The completion note is the task's prose and the retry job sweeps it there.
    expect(patchFor('tasks')).toMatchObject({
      completionNote: 'Blurred photo, recount the block',
      sourceLocale: 'fr',
      translationStatus: 'done',
    })
    expect(body.survey.conditionNotes).toBe('Les feuilles jaunissent sur les rangs est')
  })

  it('marks both rows pending when the LLM is unavailable', async () => {
    isLlmConfigured.mockReturnValue(false)
    queueSelect('tasks', [taskRow()])
    queueSelect('tasks', [taskRow()])
    queueSelect('plots', [{ id: 'plot-1' }])
    queueSelect('crop_census_evidence', [])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await (await taskApp()).request('/tasks/task-1/census-submission', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        plotId: PLOT_ID,
        cropType: 'coconut',
        plantCount: 120,
        conditionNotes: 'Les feuilles jaunissent sur les rangs est',
        completionNote: 'Photo floue, recomptez le bloc',
      }),
    })

    expect(res.status).toBe(201)
    expect(insertedSurvey()).toMatchObject({
      conditionNotes: 'Les feuilles jaunissent sur les rangs est',
      translationStatus: 'pending',
    })
    expect(patchFor('tasks')).toMatchObject({
      completionNote: 'Photo floue, recomptez le bloc',
      translationStatus: 'pending',
    })
  })
})

describe('GET /census/plots/:plotId - viewer locale on read', () => {
  it('renders survey prose for a French viewer in one batched call', async () => {
    queueSelect('crop_census_surveys', [
      surveyRow(),
      surveyRow({
        id: 'survey-2',
        conditionNotes: null,
        mortalityNotes: 'Three seedlings died after the storm',
      }),
    ])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await (await app()).request('/census/plots/plot-1')
    const body = (await res.json()) as { surveys: Row[] }

    expect(res.status).toBe(200)
    expect(viewerBatchCalls).toHaveBeenCalledTimes(1)
    expect(selectLog.filter((table) => table === 'content_translations')).toHaveLength(1)
    expect(body.surveys[0].conditionNotes).toBe('Les feuilles jaunissent sur les rangs est')
    expect(body.surveys[1].mortalityNotes).toBe('Trois plants sont morts après la tempête')
  })

  it('leaves crop names, varieties, counts, units, coordinates and status untouched', async () => {
    queueSelect('crop_census_surveys', [surveyRow()])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await (await app()).request('/census/plots/plot-1')
    const body = (await res.json()) as { surveys: Row[] }

    expect(body.surveys[0]).toMatchObject({
      cropType: 'coconut',
      cropVariety: 'Malayan Dwarf',
      plantCount: 120,
      heightUnit: 'cm',
      sampleSize: 20,
      countingMethod: 'full count',
      latitude: '6.5244',
      longitude: '3.3792',
      recordedByName: 'Awa Diallo',
      verificationStatus: 'reported',
    })
    // Heights still come back as numbers, not translated strings.
    expect(body.surveys[0].avgHeight).toBe(65)
    expect(viewerBatchCalls).toHaveBeenCalledWith(
      expect.objectContaining({ texts: ['Leaves are yellowing on the east rows'] }),
    )
  })

  it('does no translation work at all for an English viewer', async () => {
    queueSelect('crop_census_surveys', [surveyRow(), surveyRow({ id: 'survey-2' })])
    queueSelect('users', [{ preferredLocale: 'en' }])

    const res = await (await app()).request('/census/plots/plot-1')
    const body = (await res.json()) as { surveys: Row[] }

    expect(viewerBatchCalls).not.toHaveBeenCalled()
    expect(completeChat).not.toHaveBeenCalled()
    expect(selectLog).not.toContain('content_translations')
    expect(body.surveys[0].conditionNotes).toBe('Leaves are yellowing on the east rows')
  })

  it('spends one batched call and one LLM call per distinct note across many rows', async () => {
    queueSelect(
      'crop_census_surveys',
      Array.from({ length: 25 }, (_, index) => surveyRow({ id: `survey-${index}` })),
    )
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await (await app()).request('/census/plots/plot-1')
    const body = (await res.json()) as { surveys: Row[] }

    expect(body.surveys).toHaveLength(25)
    expect(viewerBatchCalls).toHaveBeenCalledTimes(1)
    expect(completeChat).toHaveBeenCalledTimes(1)
  })
})

describe('GET /census/plots/:plotId/current - viewer locale on read', () => {
  it('renders the latest verified survey per crop for a French viewer', async () => {
    queueSelect('crop_census_surveys', [
      surveyRow({ verificationStatus: 'verified' }),
      surveyRow({ id: 'survey-legacy', cropType: 'Noix de coco', verificationStatus: 'verified' }),
    ])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await (await app()).request('/census/plots/plot-1/current')
    const body = (await res.json()) as { surveys: Row[] }

    // Both rows are the same crop, so the summary carries one entry.
    expect(body.surveys).toHaveLength(1)
    expect(viewerBatchCalls).toHaveBeenCalledTimes(1)
    expect(body.surveys[0].conditionNotes).toBe('Les feuilles jaunissent sur les rangs est')
    expect(body.surveys[0].cropType).toBe('coconut')
  })

  it('does no translation work at all for an English viewer', async () => {
    queueSelect('crop_census_surveys', [surveyRow({ verificationStatus: 'verified' })])
    queueSelect('users', [{ preferredLocale: 'en' }])

    await (await app()).request('/census/plots/plot-1/current')

    expect(viewerBatchCalls).not.toHaveBeenCalled()
    expect(selectLog).not.toContain('content_translations')
  })
})

describe('POST /census/:id/verify - viewer locale on read', () => {
  it('echoes the rejection reason the verifier typed and renders the worker notes', async () => {
    queueSelect('crop_census_surveys', [surveyRow({ recordedById: 'user-worker' })])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await (await app()).request('/census/survey-1/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'rejected', rejectionReason: 'Photo floue, recomptez' }),
    })
    const body = (await res.json()) as { survey: Row }

    expect(res.status).toBe(200)
    expect(viewerBatchCalls).toHaveBeenCalledTimes(1)
    expect(body.survey.rejectionReason).toBe('Photo floue, recomptez')
    expect(body.survey.conditionNotes).toBe('Les feuilles jaunissent sur les rangs est')
    expect(viewerBatchCalls).toHaveBeenCalledWith(
      expect.objectContaining({ texts: ['Leaves are yellowing on the east rows'] }),
    )
  })

  it('does no translation work at all for an English viewer', async () => {
    queueSelect('crop_census_surveys', [surveyRow({ recordedById: 'user-worker' })])
    queueSelect('users', [{ preferredLocale: 'en' }])

    const res = await (await app()).request('/census/survey-1/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'verified' }),
    })

    expect(res.status).toBe(200)
    expect(viewerBatchCalls).not.toHaveBeenCalled()
    expect(selectLog).not.toContain('content_translations')
  })
})
