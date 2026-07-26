import { getTableName } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, unknown>

const nameOf = (table: unknown) => getTableName(table as never)

/** Rows the fake db returns, queued per table so query order does not matter. */
const selectQueue = new Map<string, Row[][]>()
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

  const insert = (table: unknown) => ({
    values: (values: Row) => {
      inserted.push({ table: nameOf(table), values })
      return { returning: async () => [{ id: 'survey-new', ...values }] }
    },
  })

  const update = (table: unknown) => ({
    set: (patch: Row) => {
      updates.push({ table: nameOf(table), patch })
      return { where: () => ({ returning: async () => [{ id: 'survey-1', ...patch }] }) }
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

vi.mock('./audit.js', () => ({ logAudit: vi.fn() }))
vi.mock('./evidence-store.js', () => ({
  processEvidenceValue: vi.fn(async (_farmId: string, value: string | null) => value ?? null),
  validateEvidenceRef: vi.fn(() => true),
}))

const worker = {
  id: 'user-worker',
  farmId: 'farm-1',
  email: 'awa@trovara.farm',
  name: 'Awa Diallo',
  role: 'field_worker' as const,
  mustChangePassword: false,
}

const supervisor = {
  id: 'user-sup',
  farmId: 'farm-1',
  email: 'sup@trovara.farm',
  name: 'Sup',
  role: 'supervisor' as const,
  mustChangePassword: false,
}

function surveyRow(overrides: Row = {}): Row {
  return {
    id: 'survey-1',
    farmId: 'farm-1',
    plotId: 'plot-1',
    cropType: 'coconut',
    plantCount: 120,
    conditionNotes: 'Leaves are yellowing on the east rows',
    mortalityNotes: null,
    rejectionReason: null,
    sourceLocale: null,
    translationStatus: 'done',
    verificationStatus: 'reported',
    recordedById: 'user-worker',
    surveyedAt: new Date('2026-07-01T08:00:00Z'),
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
  inserted.length = 0
  updates.length = 0
})

describe('createCensusSurvey - locale metadata carried onto the survey row', () => {
  it('lands a pending draft as a pending row keeping the author locale', async () => {
    const { createCensusSurvey } = await import('./census-service.js')
    queueSelect('plots', [{ id: 'plot-1' }])

    await createCensusSurvey(worker, {
      plotId: 'plot-1',
      cropType: 'coconut',
      plantCount: 120,
      conditionNotes: 'Les feuilles jaunissent sur les rangs est',
      sourceLocale: 'fr',
      translationStatus: 'pending',
    })

    expect(insertedSurvey()).toMatchObject({
      conditionNotes: 'Les feuilles jaunissent sur les rangs est',
      sourceLocale: 'fr',
      translationStatus: 'pending',
    })
  })

  it('records the author locale of a draft that translated cleanly', async () => {
    const { createCensusSurvey } = await import('./census-service.js')
    queueSelect('plots', [{ id: 'plot-1' }])

    await createCensusSurvey(worker, {
      plotId: 'plot-1',
      cropType: 'coconut',
      plantCount: 120,
      mortalityNotes: 'Three seedlings died after the storm',
      sourceLocale: 'fr',
      translationStatus: 'done',
    })

    expect(insertedSurvey()).toMatchObject({
      mortalityNotes: 'Three seedlings died after the storm',
      sourceLocale: 'fr',
      translationStatus: 'done',
    })
  })

  it('never writes a row that claims done while the draft gave up', async () => {
    const { createCensusSurvey } = await import('./census-service.js')
    queueSelect('plots', [{ id: 'plot-1' }])

    await createCensusSurvey(worker, {
      plotId: 'plot-1',
      cropType: 'coconut',
      plantCount: 120,
      conditionNotes: 'Les feuilles jaunissent',
      sourceLocale: 'fr',
      translationStatus: 'failed',
    })

    // A fresh row gets a fresh attempt; 'failed' would be invisible to the sweep.
    expect(insertedSurvey().translationStatus).toBe('pending')
  })

  it('leaves the schema defaults alone for a caller that passes nothing', async () => {
    const { createCensusSurvey } = await import('./census-service.js')
    queueSelect('plots', [{ id: 'plot-1' }])

    await createCensusSurvey(worker, {
      plotId: 'plot-1',
      cropType: 'coconut',
      plantCount: 120,
      conditionNotes: 'Leaves are yellowing on the east rows',
      heightUnit: 'cm',
    })

    const values = insertedSurvey()
    expect(values).not.toHaveProperty('sourceLocale')
    expect(values).not.toHaveProperty('translationStatus')
    expect(values).toMatchObject({
      plotId: 'plot-1',
      cropType: 'coconut',
      plantCount: 120,
      conditionNotes: 'Leaves are yellowing on the east rows',
      heightUnit: 'cm',
      verificationStatus: 'reported',
      recordedById: 'user-worker',
    })
  })

  it('leaves the schema defaults alone for an English draft', async () => {
    const { createCensusSurvey } = await import('./census-service.js')
    queueSelect('plots', [{ id: 'plot-1' }])

    await createCensusSurvey(worker, {
      plotId: 'plot-1',
      cropType: 'coconut',
      plantCount: 120,
      sourceLocale: null,
      translationStatus: 'done',
    })

    expect(insertedSurvey()).not.toHaveProperty('translationStatus')
  })
})

describe('createCensusSurvey - canonical crop type on write', () => {
  it('stores a French crop name under its English lookup key', async () => {
    const { createCensusSurvey } = await import('./census-service.js')
    queueSelect('plots', [{ id: 'plot-1' }])

    await createCensusSurvey(worker, {
      plotId: 'plot-1',
      cropType: 'noix de coco',
      plantCount: 120,
    })

    expect(insertedSurvey().cropType).toBe('coconut')
  })

  it('stores Yoruba and Pidgin crop names under the same key', async () => {
    const { createCensusSurvey } = await import('./census-service.js')
    queueSelect('plots', [{ id: 'plot-1' }])
    queueSelect('plots', [{ id: 'plot-1' }])

    await createCensusSurvey(worker, {
      plotId: 'plot-1',
      cropType: 'ọgẹdẹ àgbagbà',
      plantCount: 40,
    })
    await createCensusSurvey(worker, { plotId: 'plot-1', cropType: 'plantin', plantCount: 41 })

    const [first, second] = inserted.filter((e) => e.table === 'crop_census_surveys')
    expect(first.values.cropType).toBe('plantain')
    expect(second.values.cropType).toBe('plantain')
  })

  it('stores a crop we have no playbook for exactly as the worker typed it', async () => {
    const { createCensusSurvey } = await import('./census-service.js')
    queueSelect('plots', [{ id: 'plot-1' }])

    await createCensusSurvey(worker, { plotId: 'plot-1', cropType: '  maïs ', plantCount: 900 })

    expect(insertedSurvey().cropType).toBe('maïs')
  })
})

describe('currentVerifiedCensus - grouping legacy crop names', () => {
  it('treats a French and an English spelling of one crop as one crop', async () => {
    const { currentVerifiedCensus } = await import('./census-service.js')
    queueSelect('crop_census_surveys', [
      surveyRow({ id: 'survey-newest', cropType: 'coconut', plantCount: 120 }),
      surveyRow({ id: 'survey-legacy', cropType: 'Noix de coco', plantCount: 118 }),
      surveyRow({ id: 'survey-plantain', cropType: 'plantain', plantCount: 40 }),
    ])

    const rows = await currentVerifiedCensus('farm-1', 'plot-1')

    expect(rows.map((r) => r.id)).toEqual(['survey-newest', 'survey-plantain'])
  })

  it('collapses case and accent variants of a crop with no playbook', async () => {
    const { currentVerifiedCensus } = await import('./census-service.js')
    queueSelect('crop_census_surveys', [
      surveyRow({ id: 'survey-a', cropType: 'Maïs' }),
      surveyRow({ id: 'survey-b', cropType: 'mais' }),
      surveyRow({ id: 'survey-c', cropType: ' MAIS ' }),
    ])

    const rows = await currentVerifiedCensus('farm-1', 'plot-1')

    expect(rows.map((r) => r.id)).toEqual(['survey-a'])
  })

  it('keeps the stored spelling on the row it returns', async () => {
    const { currentVerifiedCensus } = await import('./census-service.js')
    queueSelect('crop_census_surveys', [surveyRow({ cropType: 'Noix de coco' })])

    const rows = await currentVerifiedCensus('farm-1', 'plot-1')

    expect(rows[0].cropType).toBe('Noix de coco')
  })

  it('cannot merge crop names the lexicon has no entry for', async () => {
    const { currentVerifiedCensus } = await import('./census-service.js')
    queueSelect('crop_census_surveys', [
      surveyRow({ id: 'survey-fr', cropType: 'maïs' }),
      surveyRow({ id: 'survey-en', cropType: 'maize' }),
    ])

    const rows = await currentVerifiedCensus('farm-1', 'plot-1')

    // Neither spelling is a canonical key (there is no maize playbook), so they
    // are two different words to a deterministic lexicon. Merging them needs an
    // alias in crop-normalize.ts, not a looser key here.
    expect(rows.map((r) => r.id)).toEqual(['survey-fr', 'survey-en'])
  })
})

describe('verifyCensusSurvey - locale metadata on update', () => {
  it('escalates a done row to pending for a French rejection reason', async () => {
    const { verifyCensusSurvey } = await import('./census-service.js')
    queueSelect('crop_census_surveys', [surveyRow()])

    await verifyCensusSurvey(supervisor, 'survey-1', 'rejected', 'Photo floue, recomptez le bloc', {
      sourceLocale: 'fr',
      translationStatus: 'pending',
    })

    expect(patchFor('crop_census_surveys')).toMatchObject({
      verificationStatus: 'rejected',
      rejectionReason: 'Photo floue, recomptez le bloc',
      sourceLocale: 'fr',
      translationStatus: 'pending',
    })
  })

  it('does not downgrade an already pending row when a later English write lands', async () => {
    const { verifyCensusSurvey } = await import('./census-service.js')
    queueSelect('crop_census_surveys', [
      surveyRow({ translationStatus: 'pending', sourceLocale: 'fr' }),
    ])

    await verifyCensusSurvey(supervisor, 'survey-1', 'rejected', 'Blurred photo, recount the block', {
      sourceLocale: 'en',
      translationStatus: 'done',
    })

    const patch = patchFor('crop_census_surveys')
    expect(patch.rejectionReason).toBe('Blurred photo, recount the block')
    expect(patch.translationStatus).toBeUndefined()
    expect(patch.sourceLocale).toBeUndefined()
  })

  it('does not downgrade a row the retry job gave up on', async () => {
    const { verifyCensusSurvey } = await import('./census-service.js')
    queueSelect('crop_census_surveys', [
      surveyRow({ translationStatus: 'failed', sourceLocale: 'fr' }),
    ])

    await verifyCensusSurvey(supervisor, 'survey-1', 'rejected', 'Blurred photo, recount', {
      sourceLocale: 'en',
      translationStatus: 'done',
    })

    expect(patchFor('crop_census_surveys').translationStatus).toBeUndefined()
  })

  it('leaves the locale pair alone when a verifier approves', async () => {
    const { verifyCensusSurvey } = await import('./census-service.js')
    queueSelect('crop_census_surveys', [surveyRow()])

    await verifyCensusSurvey(supervisor, 'survey-1', 'verified')

    const patch = patchFor('crop_census_surveys')
    expect(patch).toMatchObject({ verificationStatus: 'verified', rejectionReason: null })
    expect(patch).not.toHaveProperty('translationStatus')
    expect(patch).not.toHaveProperty('sourceLocale')
  })

  it('behaves exactly as before for a caller that passes no metadata', async () => {
    const { verifyCensusSurvey } = await import('./census-service.js')
    queueSelect('crop_census_surveys', [surveyRow()])

    await verifyCensusSurvey(supervisor, 'survey-1', 'rejected', 'Blurred photo, recount')

    const patch = patchFor('crop_census_surveys')
    expect(patch.rejectionReason).toBe('Blurred photo, recount')
    expect(patch).not.toHaveProperty('translationStatus')
    expect(patch).not.toHaveProperty('sourceLocale')
  })
})

// The task is read twice: once here and once by createCensusSurvey validating
// the task the survey is attached to.
describe('submitCensusForTask - locale metadata on the task it completes', () => {
  it('carries the draft locale onto both the survey and the task note', async () => {
    const { submitCensusForTask } = await import('./census-service.js')
    queueSelect('tasks', [taskRow()])
    queueSelect('tasks', [taskRow()])
    queueSelect('plots', [{ id: 'plot-1' }])
    queueSelect('crop_census_evidence', [])

    await submitCensusForTask(worker, 'task-1', {
      plotId: 'plot-1',
      cropType: 'noix de coco',
      plantCount: 120,
      conditionNotes: 'Les feuilles jaunissent',
      completionNote: 'Comptage termine, bloc A',
      sourceLocale: 'fr',
      translationStatus: 'pending',
    })

    expect(insertedSurvey()).toMatchObject({
      cropType: 'coconut',
      sourceLocale: 'fr',
      translationStatus: 'pending',
    })
    expect(patchFor('tasks')).toMatchObject({
      completionNote: 'Comptage termine, bloc A',
      status: 'awaiting_approval',
      sourceLocale: 'fr',
      translationStatus: 'pending',
    })
  })

  it('leaves the task locale pair alone when no new note is written', async () => {
    const { submitCensusForTask } = await import('./census-service.js')
    queueSelect('tasks', [taskRow()])
    queueSelect('tasks', [taskRow()])
    queueSelect('plots', [{ id: 'plot-1' }])
    queueSelect('crop_census_evidence', [])

    await submitCensusForTask(worker, 'task-1', {
      plotId: 'plot-1',
      cropType: 'coconut',
      plantCount: 120,
      sourceLocale: 'fr',
      translationStatus: 'pending',
    })

    const patch = patchFor('tasks')
    expect(patch).not.toHaveProperty('sourceLocale')
    expect(patch).not.toHaveProperty('translationStatus')
  })

  it('does not downgrade a task that already owes a translation', async () => {
    const { submitCensusForTask } = await import('./census-service.js')
    queueSelect('tasks', [taskRow({ translationStatus: 'pending', sourceLocale: 'fr' })])
    queueSelect('tasks', [taskRow()])
    queueSelect('plots', [{ id: 'plot-1' }])
    queueSelect('crop_census_evidence', [])

    await submitCensusForTask(worker, 'task-1', {
      plotId: 'plot-1',
      cropType: 'coconut',
      plantCount: 120,
      completionNote: 'Count finished on block A',
      sourceLocale: 'en',
      translationStatus: 'done',
    })

    const patch = patchFor('tasks')
    expect(patch.completionNote).toBe('Count finished on block A')
    expect(patch.translationStatus).toBeUndefined()
  })
})
