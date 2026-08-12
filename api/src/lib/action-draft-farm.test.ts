import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseCropCycleIntent, parseLivestockBatchIntent } from './action-draft-farm-parse.js'
import type { SessionUser } from './session.js'

/** Rows handed to the fake db, so the stored species can be asserted. */
const inserted: Record<string, unknown>[] = []
/** Rows the fake db returns from any select, set per test. */
let selectRows: Record<string, unknown>[] = []

vi.mock('../db/index.js', () => {
  const selectChain = () => {
    const self: Record<string, unknown> = {}
    const same = () => self
    Object.assign(self, {
      from: same,
      where: same,
      limit: same,
      then: (resolve: (rows: Record<string, unknown>[]) => unknown, reject?: unknown) =>
        Promise.resolve(selectRows).then(resolve, reject as never),
    })
    return self
  }

  return {
    db: {
      select: selectChain,
      insert: () => ({
        values: (values: Record<string, unknown>) => {
          inserted.push(values)
          return { returning: async () => [{ id: 'batch-new', ...values }] }
        },
      }),
    },
  }
})

vi.mock('./rbac.js', () => ({ hasPermission: () => true }))
vi.mock('./audit.js', () => ({ logAudit: vi.fn() }))
vi.mock('./farm-events.js', () => ({ recordFarmEvent: vi.fn() }))

/** The batch draft waiting for an answer, or null when none is pending. */
let pendingDraft: { id: string; payload: Record<string, unknown> } | null = null
const mergeActionDraftPayload = vi.fn(async () => null)

vi.mock('./task-drafts.js', () => ({
  getLatestPendingDraft: async () => pendingDraft,
  mergeActionDraftPayload,
}))

const user = {
  id: 'user-1',
  farmId: 'farm-1',
  email: 'a@b.com',
  name: 'Ada',
  role: 'supervisor',
  mustChangePassword: false,
} as SessionUser

describe('parseCropCycleIntent', () => {
  it('parses crop draft lines', () => {
    expect(parseCropCycleIntent('Crop: Block 2 type=plantain planted=2026-07-19')).toEqual({
      plotName: 'Block 2',
      cropType: 'plantain',
      plantedAt: '2026-07-19',
      expectedHarvestAt: undefined,
      expectedYieldKg: undefined,
    })
    expect(
      parseCropCycleIntent(
        'Create crop: North Field type=tomato planted=2026-01-01 harvest=2026-04-01 yield=800',
      ),
    ).toMatchObject({
      plotName: 'North Field',
      cropType: 'tomato',
      expectedYieldKg: 800,
    })
  })
})

describe('parseLivestockBatchIntent', () => {
  it('parses livestock draft lines', () => {
    expect(
      parseLivestockBatchIntent('Livestock: Noiler A species=noiler heads=200'),
    ).toMatchObject({
      name: 'Noiler A',
      species: 'noiler',
      headCount: 200,
    })
    expect(
      parseLivestockBatchIntent(
        'Batch: Goats species=goat heads=12 plot=Block 1 acquired=2026-06-01',
      ),
    ).toMatchObject({
      name: 'Goats',
      plotName: 'Block 1',
      acquiredAt: '2026-06-01',
    })
  })
})

describe('executeConfirmedLivestockBatch', () => {
  beforeEach(() => {
    inserted.length = 0
  })

  async function execute(payload: Record<string, unknown>) {
    const { executeConfirmedLivestockBatch } = await import('./action-draft-farm.js')
    return executeConfirmedLivestockBatch(user, {
      name: 'Shed A',
      headCount: 200,
      acquiredAt: '2026-02-01T00:00:00.000Z',
      ...payload,
    })
  }

  it('records the batch type the species implies', async () => {
    const reply = await execute({ species: 'noiler', speciesTyped: 'poulet noiler' })

    expect(inserted[0]).toMatchObject({ species: 'noiler', batchType: 'noiler' })
    // The worker reads back their own words, not the lookup key.
    expect(reply).toContain('poulet noiler')
  })

  it('normalizes a draft stored before the lexicon existed', async () => {
    const reply = await execute({ species: 'Poulet noiler' })

    expect(inserted[0]).toMatchObject({ species: 'noiler', batchType: 'noiler' })
    expect(reply).toContain('Poulet noiler')
  })

  it('classifies descriptive text without rewriting it', async () => {
    await execute({ species: 'Noiler (day old)' })

    expect(inserted[0]).toMatchObject({ species: 'Noiler (day old)', batchType: 'noiler' })
  })

  it('leaves a species the enum cannot express alone', async () => {
    await execute({ species: 'Goats' })

    expect(inserted[0]).toMatchObject({ species: 'Goats', batchType: null })
  })

  // The species text still says nothing about the type, so re-deriving it here
  // would throw the farmer's answer away and file the batch unclassified.
  it('keeps the type the worker answered for a species that names none', async () => {
    await execute({ species: 'chickens', batchType: 'layer' })

    expect(inserted[0]).toMatchObject({ species: 'chickens', batchType: 'layer' })
  })
})

describe('applyPoultryTypeAnswer', () => {
  async function answer(text: string) {
    const { applyPoultryTypeAnswer } = await import('./action-draft-farm.js')
    return applyPoultryTypeAnswer(user, text)
  }

  beforeEach(() => {
    mergeActionDraftPayload.mockClear()
    pendingDraft = { id: 'draft-1', payload: { species: 'chickens', awaitingBatchType: true } }
  })

  it('puts the answer on the draft that is waiting for it', async () => {
    await expect(answer('layer')).resolves.toEqual({
      handled: true,
      draftId: 'draft-1',
      batchType: 'layer',
    })
    expect(mergeActionDraftPayload).toHaveBeenCalledWith('draft-1', 'user-1', {
      batchType: 'layer',
      awaitingBatchType: false,
    })
  })

  it('reads the answer in the language the worker replies in', async () => {
    await expect(answer('pondeuses')).resolves.toMatchObject({ batchType: 'layer' })
    await expect(answer('adìẹ ọdọ')).resolves.toMatchObject({ batchType: 'pullet' })
    await expect(answer('other')).resolves.toMatchObject({ batchType: 'other' })
  })

  // Falling through is what keeps the butler reachable while a draft is open.
  it('claims nothing else', async () => {
    await expect(answer('the layers are off feed')).resolves.toEqual({ handled: false })
    await expect(answer('brief')).resolves.toEqual({ handled: false })
    expect(mergeActionDraftPayload).not.toHaveBeenCalled()
  })

  it('claims nothing when no draft is waiting for a type', async () => {
    pendingDraft = { id: 'draft-2', payload: { species: 'noiler', awaitingBatchType: false } }
    await expect(answer('layer')).resolves.toEqual({ handled: false })

    pendingDraft = null
    await expect(answer('layer')).resolves.toEqual({ handled: false })
    expect(mergeActionDraftPayload).not.toHaveBeenCalled()
  })
})

describe('resolvePlotByName', () => {
  async function resolve(plotName: string) {
    const { resolvePlotByName } = await import('./action-draft-farm.js')
    return resolvePlotByName('farm-1', plotName)
  }

  beforeEach(() => {
    selectRows = [
      { id: 'plot-1', name: 'Bloc-Nord' },
      { id: 'plot-2', name: 'Pépinière' },
    ]
  })

  it('matches the plot however the worker punctuated or accented it', async () => {
    await expect(resolve('Bloc-Nord')).resolves.toMatchObject({ id: 'plot-1' })
    await expect(resolve('bloc nord')).resolves.toMatchObject({ id: 'plot-1' })
    await expect(resolve('pepiniere')).resolves.toMatchObject({ id: 'plot-2' })
    await expect(resolve('  PÉPINIÈRE ')).resolves.toMatchObject({ id: 'plot-2' })
  })

  it('returns the stored spelling, not the folded form', async () => {
    await expect(resolve('bloc nord')).resolves.toMatchObject({ name: 'Bloc-Nord' })
  })

  it('misses a plot the farm does not have', async () => {
    await expect(resolve('Bloc Sud')).resolves.toBeNull()
  })

  it('refuses to guess between two plots that fold together', async () => {
    selectRows = [
      { id: 'plot-1', name: 'Bloc-Nord' },
      { id: 'plot-2', name: 'Bloc Nord' },
    ]

    await expect(resolve('BLOC NORD')).resolves.toBeNull()
    // Either plot is still reachable by its own exact name.
    await expect(resolve('Bloc-Nord')).resolves.toMatchObject({ id: 'plot-1' })
    await expect(resolve('Bloc Nord')).resolves.toMatchObject({ id: 'plot-2' })
  })
})
