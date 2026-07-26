import { beforeEach, describe, expect, it, vi } from 'vitest'

const logAudit = vi.fn(async () => undefined)
const resolvePlotByName = vi.fn()

/** Values passed to every insert the executors run. */
const inserted: Record<string, unknown>[] = []

/** Rows every select returns; the asset lookups are the only reads here. */
const DEFAULT_ASSET = { id: 'asset-1', name: 'Wheelbarrow', assetTag: null }
let selectRows: Record<string, unknown>[] = [DEFAULT_ASSET]

vi.mock('../db/index.js', () => {
  const insert = () => ({
    values: (values: Record<string, unknown>) => {
      inserted.push(values)
      return {
        returning: async () => [{ id: 'row-1', title: values.title }],
      }
    },
  })

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
      insert,
      select: selectChain,
      // The census service writes its row inside a transaction.
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ insert }),
    },
  }
})

vi.mock('./audit.js', () => ({ logAudit }))
vi.mock('./evidence-store.js', () => ({
  processEvidenceValue: vi.fn(async (_farmId: string, value: string | null) => value ?? null),
  validateEvidenceRef: vi.fn(() => true),
}))

// `census-service.js` is deliberately not mocked: it runs for real against the
// fake db so a confirmed census draft is followed all the way to the row it
// writes, which is the only place the locale metadata can be lost.
vi.mock('./action-draft-farm.js', () => ({ resolvePlotByName }))

const canonicalizeDraftPayload = vi.fn(
  async ({ payload }: { payload: Record<string, unknown> }) => ({ payload, locale: {} }),
)
vi.mock('./draft-canonical.js', () => ({ canonicalizeDraftPayload }))

const user = {
  id: 'user-1',
  farmId: 'farm-1',
  email: 'sup@farm.test',
  name: 'Supervisor',
  role: 'supervisor' as const,
  mustChangePassword: false,
}

beforeEach(() => {
  vi.clearAllMocks()
  inserted.length = 0
  selectRows = [DEFAULT_ASSET]
})

describe('executeConfirmedCreateTask', () => {
  it('carries a pending draft through to the task row', async () => {
    const { executeConfirmedCreateTask } = await import('./action-draft-ops.js')

    await executeConfirmedCreateTask(
      user,
      { title: 'Désherber Bloc 2', description: 'avant midi' },
      'butler',
      { sourceLocale: 'fr', translationStatus: 'pending' },
    )

    expect(inserted[0]).toMatchObject({
      title: 'Désherber Bloc 2',
      description: 'avant midi',
      sourceLocale: 'fr',
      translationStatus: 'pending',
    })
  })

  it('records the author locale of a draft that translated cleanly', async () => {
    const { executeConfirmedCreateTask } = await import('./action-draft-ops.js')

    await executeConfirmedCreateTask(user, { title: 'Weed Block 2' }, 'butler', {
      sourceLocale: 'fr',
      translationStatus: 'done',
    })

    expect(inserted[0]).toMatchObject({ sourceLocale: 'fr', translationStatus: 'done' })
  })

  it('leaves the schema defaults alone for an English draft', async () => {
    const { executeConfirmedCreateTask } = await import('./action-draft-ops.js')

    await executeConfirmedCreateTask(user, { title: 'Weed Block 2' }, 'butler', {
      sourceLocale: null,
      translationStatus: 'done',
    })

    expect(inserted[0]).not.toHaveProperty('sourceLocale')
    expect(inserted[0]).not.toHaveProperty('translationStatus')
  })

  it('leaves the schema defaults alone for callers that pass no metadata', async () => {
    const { executeConfirmedCreateTask } = await import('./action-draft-ops.js')

    const reply = await executeConfirmedCreateTask(user, { title: 'Weed Block 2' })

    expect(reply).toBe('✅ Task created: Weed Block 2')
    expect(inserted[0]).not.toHaveProperty('sourceLocale')
    expect(inserted[0]).not.toHaveProperty('translationStatus')
  })

  it('writes a draft the retry job gave up on as pending, so the new row is swept', async () => {
    const { executeConfirmedCreateTask } = await import('./action-draft-ops.js')

    await executeConfirmedCreateTask(user, { title: 'Désherber Bloc 2' }, 'butler', {
      sourceLocale: 'fr',
      translationStatus: 'failed',
    })

    expect(inserted[0]).toMatchObject({ sourceLocale: 'fr', translationStatus: 'pending' })
  })
})

/** A stored `create_census` payload, as `prepareCensusDraft` writes it. */
const censusPayload = {
  plotId: 'plot-1',
  plotName: 'Block 2',
  cropType: 'coconut',
  plantCount: 120,
  minHeight: 40,
  maxHeight: 90,
  heightUnit: 'cm',
}

describe('executeConfirmedCensus', () => {
  it('carries a pending draft through to the survey row', async () => {
    const { executeConfirmedCensus } = await import('./action-draft-ops.js')

    await executeConfirmedCensus(user, censusPayload, {
      sourceLocale: 'fr',
      translationStatus: 'pending',
    })

    expect(inserted[0]).toMatchObject({ sourceLocale: 'fr', translationStatus: 'pending' })
  })

  it('leaves the schema defaults alone for callers that pass no locale', async () => {
    const { executeConfirmedCensus } = await import('./action-draft-ops.js')

    const reply = await executeConfirmedCensus(user, censusPayload)

    expect(reply).toContain('Census saved for Block 2')
    expect(inserted[0]).toMatchObject({ plotId: 'plot-1', plantCount: 120 })
    expect(inserted[0]).not.toHaveProperty('sourceLocale')
    expect(inserted[0]).not.toHaveProperty('translationStatus')
  })
})

describe('applyConfirmedOpsDraft', () => {
  it('threads the draft locale into the task write', async () => {
    const { applyConfirmedOpsDraft } = await import('./action-draft-ops.js')

    await applyConfirmedOpsDraft(
      user,
      'create_task',
      { title: 'Désherber Bloc 2' },
      'telegram_confirm',
      { sourceLocale: 'fr', translationStatus: 'pending' },
    )

    expect(inserted[0]).toMatchObject({ sourceLocale: 'fr', translationStatus: 'pending' })
  })

  /**
   * The regression that mattered: a French census confirmed from the butler used
   * to reach `crop_census_surveys` claiming 'done', and the retry sweep filters
   * on status, so the row was unrecoverable.
   */
  it('threads a pending census draft locale all the way into the survey row', async () => {
    const { applyConfirmedOpsDraft } = await import('./action-draft-ops.js')

    const reply = await applyConfirmedOpsDraft(
      user,
      'create_census',
      censusPayload,
      'telegram_confirm',
      { sourceLocale: 'fr', translationStatus: 'pending' },
    )

    expect(reply).toContain('Census saved')
    expect(inserted[0]).toMatchObject({
      farmId: 'farm-1',
      plotId: 'plot-1',
      cropType: 'coconut',
      sourceLocale: 'fr',
      translationStatus: 'pending',
    })
  })

  it('writes a census draft the retry job gave up on as pending, so it is swept again', async () => {
    const { applyConfirmedOpsDraft } = await import('./action-draft-ops.js')

    await applyConfirmedOpsDraft(user, 'create_census', censusPayload, 'telegram_confirm', {
      sourceLocale: 'fr',
      translationStatus: 'failed',
    })

    expect(inserted[0]).toMatchObject({ sourceLocale: 'fr', translationStatus: 'pending' })
  })

  it('leaves the census schema defaults alone for a draft with no locale', async () => {
    const { applyConfirmedOpsDraft } = await import('./action-draft-ops.js')

    await applyConfirmedOpsDraft(user, 'create_census', censusPayload, 'telegram_confirm')

    expect(inserted[0]).not.toHaveProperty('sourceLocale')
    expect(inserted[0]).not.toHaveProperty('translationStatus')
  })

  it('does not put locale columns on asset logs, which have none', async () => {
    const { applyConfirmedOpsDraft } = await import('./action-draft-ops.js')

    await applyConfirmedOpsDraft(
      user,
      'asset_count',
      { assetId: 'asset-1', countAvailable: 4 },
      'telegram_confirm',
      { sourceLocale: 'fr', translationStatus: 'pending' },
    )

    expect(inserted[0]).not.toHaveProperty('sourceLocale')
    expect(inserted[0]).not.toHaveProperty('translationStatus')
  })
})

describe('resolveAssetByQuery', () => {
  async function resolve(query: string) {
    const { resolveAssetByQuery } = await import('./action-draft-ops.js')
    return resolveAssetByQuery('farm-1', query)
  }

  beforeEach(() => {
    selectRows = [
      { id: 'asset-1', name: 'Motopompe', assetTag: 'PMP-01' },
      { id: 'asset-2', name: 'Brouette', assetTag: null },
    ]
  })

  it('matches the asset name however it was punctuated or accented', async () => {
    await expect(resolve('motopompe')).resolves.toMatchObject({ id: 'asset-1' })
    await expect(resolve('  BROUETTE ')).resolves.toMatchObject({ id: 'asset-2' })
  })

  it('matches the asset tag through its separator', async () => {
    await expect(resolve('PMP-01')).resolves.toMatchObject({ id: 'asset-1' })
    await expect(resolve('pmp 01')).resolves.toMatchObject({ id: 'asset-1' })
  })

  it('hands back the stored name, not the query', async () => {
    await expect(resolve('pmp 01')).resolves.toEqual({ id: 'asset-1', name: 'Motopompe' })
  })

  it('refuses to guess between two assets that fold together', async () => {
    selectRows = [
      { id: 'asset-1', name: 'Motopompe 1', assetTag: null },
      { id: 'asset-2', name: 'Motopompe-1', assetTag: null },
    ]

    await expect(resolve('motopompe 1')).resolves.toBeNull()
    await expect(resolve('Motopompe-1')).resolves.toMatchObject({ id: 'asset-2' })
  })
})

/**
 * The census parser captures no prose today, and the hole this closes is what
 * happens the day it does: the draft would carry the worker's own words with
 * the row's locale columns left at their 'done' default, which the retry sweep
 * filters out. The producer therefore hands its whole payload to the shared
 * canonicalizer and forwards whatever it reports, rather than listing the prose
 * fields it happens to know about.
 */
describe('prepareCensusDraft', () => {
  async function prepare(authorLocale?: string | null) {
    const { prepareCensusDraft } = await import('./action-draft-ops.js')
    return prepareCensusDraft({
      user,
      blockName: 'Block 2',
      cropType: 'coconut',
      plantCount: 120,
      channel: 'telegram',
      externalChatId: '42',
      authorLocale,
    })
  }

  beforeEach(() => {
    resolvePlotByName.mockResolvedValue({ id: 'plot-1', name: 'Block 2' })
    canonicalizeDraftPayload.mockImplementation(async ({ payload }) => ({ payload, locale: {} }))
  })

  it('sends the payload through the canonicalizer with only the keys named verbatim', async () => {
    await prepare('fr')

    expect(canonicalizeDraftPayload).toHaveBeenCalledWith({
      farmId: 'farm-1',
      authorLocale: 'fr',
      verbatim: ['plotId', 'plotName', 'cropType', 'heightUnit'],
      payload: expect.objectContaining({ plotId: 'plot-1', cropType: 'coconut', plantCount: 120 }),
    })
  })

  it('stores the payload it came back with, and the locale that came with it', async () => {
    canonicalizeDraftPayload.mockResolvedValue({
      payload: { plotId: 'plot-1', notes: 'yellow leaves' },
      locale: { sourceLocale: 'fr', translationStatus: 'pending' },
    })

    await prepare('fr')

    expect(inserted[0]).toMatchObject({
      actionType: 'create_census',
      payload: { plotId: 'plot-1', notes: 'yellow leaves' },
      sourceLocale: 'fr',
      translationStatus: 'pending',
    })
  })

  it('leaves the draft locale columns at their defaults when nothing was translated', async () => {
    await prepare()

    expect(inserted[0]).not.toHaveProperty('sourceLocale')
    expect(inserted[0]).not.toHaveProperty('translationStatus')
  })
})

describe('parseCensusIntent', () => {
  it('parses a single-token crop', async () => {
    const { parseCensusIntent } = await import('./action-draft-ops-parse.js')
    expect(parseCensusIntent('Census: Block 2 crop=plantain count=120')).toEqual({
      blockName: 'Block 2',
      cropType: 'plantain',
      plantCount: 120,
      minHeight: undefined,
      maxHeight: undefined,
    })
  })

  // A multi-word crop matched nothing, so the butler offered no draft at all.
  // Every multi-word alias in the crop lexicon reaches this parser.
  it('parses a multi-word crop without swallowing the next key', async () => {
    const { parseCensusIntent } = await import('./action-draft-ops-parse.js')
    expect(
      parseCensusIntent('Census: Block 2 crop=noix de coco count=120 min=1.2 max=2.4'),
    ).toEqual({
      blockName: 'Block 2',
      cropType: 'noix de coco',
      plantCount: 120,
      minHeight: 1.2,
      maxHeight: 2.4,
    })
  })
})
