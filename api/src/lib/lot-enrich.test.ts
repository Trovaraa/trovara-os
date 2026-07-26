import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, unknown>

/** Locale columns written onto the draft row, in call order. */
const draftLocaleUpdates: Row[] = []
/** Payload patches merged into the draft, in call order. */
const payloadPatches: Row[] = []

let draft: Row | null = null

vi.mock('../db/index.js', () => ({
  db: {
    select: () => {
      const rows = [{ id: 'plot-1', name: 'Block A' }]
      // Thenable at every step: the plot lookup awaits `.where(...)` directly
      // (it folds names in JS over the farm's plots) while other callers still
      // end the chain at `.limit(...)`.
      const self = {
        from: () => self,
        where: () => self,
        limit: async () => rows,
        then: (resolve: (value: typeof rows) => unknown) => Promise.resolve(rows).then(resolve),
      }
      return self
    },
    update: () => ({
      set: (values: Row) => ({
        where: async () => {
          draftLocaleUpdates.push(values)
        },
      }),
    }),
  },
}))

const getLatestPendingDraft = vi.fn(async () => draft)
const mergeActionDraftPayload = vi.fn(async (_id: string, _userId: string, patch: Row) => {
  payloadPatches.push(patch)
  return draft
})

vi.mock('./task-drafts.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./task-drafts.js')>()),
  getLatestPendingDraft,
  mergeActionDraftPayload,
  storeActionDraft: vi.fn(async () => ({ id: 'draft-1' })),
}))

const enrichHarvestLot = vi.fn(async () => ({
  lot: { lotCode: 'TRV-LOT-2026-014', quantityKg: 24, unit: 'crates', plotId: 'plot-1', photoUrl: null },
}))
const verifyHarvestLot = vi.fn(async () => ({ lot: { lotCode: 'TRV-LOT-2026-014' } }))
const authorLocaleForUser = vi.fn(async () => 'fr' as string | null)

vi.mock('./harvest-lots.js', () => ({
  enrichHarvestLot,
  verifyHarvestLot,
  authorLocaleForUser,
  findLotByCode: vi.fn(),
  listIncompleteLots: vi.fn(async () => []),
}))

type CanonicalArgs = { text: string; farmId: string; sourceLocale?: string | null }
type CanonicalLocale = 'en' | 'fr' | 'yo' | 'pcm'

/** The locale the service would resolve: the hint when set, else detected 'en'. */
function resolvedLocale(hint?: string | null): CanonicalLocale {
  return (hint ?? 'en') as CanonicalLocale
}

vi.mock('./content-locale.js', () => ({
  toCanonicalEnglish: vi.fn(async ({ text, sourceLocale }: CanonicalArgs) => ({
    english: text,
    sourceLocale: resolvedLocale(sourceLocale),
    status: 'done' as const,
  })),
}))

const { toCanonicalEnglish } = await import('./content-locale.js')
const { applyLotEnrichText, applyConfirmedLotDraft } = await import('./lot-enrich.js')

const mockCanonical = vi.mocked(toCanonicalEnglish)

const user = {
  id: 'user-1',
  farmId: 'farm-1',
  role: 'field_worker' as const,
  name: 'Ade',
  email: 'ade@trovara.farm',
}

const supervisor = { ...user, id: 'user-2', role: 'supervisor' as const }

function pendingDraft(overrides: Row = {}): Row {
  return {
    id: 'draft-1',
    farmId: 'farm-1',
    userId: 'user-1',
    channel: 'telegram',
    externalChatId: '42',
    actionType: 'enrich_lot',
    payload: { lotId: 'lot-1', lotCode: 'TRV-LOT-2026-014', unit: 'crates' },
    expiresAt: new Date(Date.now() + 60_000),
    sourceLocale: null,
    translationStatus: 'done',
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  draftLocaleUpdates.length = 0
  payloadPatches.length = 0
  draft = pendingDraft()
  authorLocaleForUser.mockResolvedValue('fr')
  mockCanonical.mockImplementation(async ({ text, sourceLocale }: CanonicalArgs) => ({
    english: text,
    sourceLocale: resolvedLocale(sourceLocale),
    status: 'done' as const,
  }))
})

describe('applyLotEnrichText notes line', () => {
  it('stores a French note as English and tags the draft', async () => {
    mockCanonical.mockResolvedValue({
      english: 'Harvested fresh this morning',
      sourceLocale: 'fr',
      status: 'done',
    })

    const result = await applyLotEnrichText(user, 'notes Récolte fraîche du matin')

    expect(result).toMatchObject({ handled: true, draftId: 'draft-1' })
    expect(mockCanonical).toHaveBeenCalledWith({
      text: 'Récolte fraîche du matin',
      farmId: 'farm-1',
      sourceLocale: 'fr',
    })
    expect(payloadPatches).toEqual([{ publicNotes: 'Harvested fresh this morning' }])
    expect(draftLocaleUpdates).toEqual([{ sourceLocale: 'fr', translationStatus: 'done' }])
  })

  it('keeps the original words as pending when the translation fails', async () => {
    mockCanonical.mockResolvedValue({
      english: 'Récolte fraîche du matin',
      sourceLocale: 'fr',
      status: 'pending',
    })

    const result = await applyLotEnrichText(user, 'notes Récolte fraîche du matin')

    // The worker's message still succeeds; the retry job owns the repair.
    expect(result).toMatchObject({ handled: true })
    expect(payloadPatches).toEqual([{ publicNotes: 'Récolte fraîche du matin' }])
    expect(draftLocaleUpdates).toEqual([{ sourceLocale: 'fr', translationStatus: 'pending' }])
  })

  it('saves the note when the translator throws', async () => {
    mockCanonical.mockRejectedValue(new Error('llm unavailable'))

    const result = await applyLotEnrichText(user, 'notes Récolte fraîche du matin')

    expect(result).toMatchObject({ handled: true })
    expect(payloadPatches).toEqual([{ publicNotes: 'Récolte fraîche du matin' }])
    expect(draftLocaleUpdates).toEqual([{ sourceLocale: 'fr', translationStatus: 'pending' }])
  })

  it('uses an explicit author locale over the profile lookup', async () => {
    await applyLotEnrichText(user, 'notes morning harvest', { authorLocale: 'en' })

    expect(authorLocaleForUser).not.toHaveBeenCalled()
    expect(mockCanonical).toHaveBeenCalledWith({
      text: 'morning harvest',
      farmId: 'farm-1',
      sourceLocale: null,
    })
  })

  it('skips the translator for a caller that already normalized the line', async () => {
    const result = await applyLotEnrichText(user, 'notes Harvested this morning', {
      canonical: true,
    })

    expect(result).toMatchObject({ handled: true })
    expect(mockCanonical).not.toHaveBeenCalled()
    expect(payloadPatches).toEqual([{ publicNotes: 'Harvested this morning' }])
    expect(draftLocaleUpdates).toEqual([])
  })

  it('leaves a draft the retry job already owns tagged as it was', async () => {
    draft = pendingDraft({ sourceLocale: 'yo', translationStatus: 'pending' })

    await applyLotEnrichText(user, 'notes Harvested this morning')

    expect(draftLocaleUpdates).toEqual([])
  })
})

describe('applyLotEnrichText identifier lines', () => {
  it('never sends a qty line to the translator', async () => {
    const result = await applyLotEnrichText(user, 'qty 12 crates')

    expect(result).toMatchObject({ handled: true })
    expect(mockCanonical).not.toHaveBeenCalled()
    expect(payloadPatches).toEqual([{ quantityKg: 12, unit: 'crates' }])
  })

  it('never sends a plot name to the translator', async () => {
    const result = await applyLotEnrichText(user, 'plot Block A')

    expect(result).toMatchObject({ handled: true })
    expect(mockCanonical).not.toHaveBeenCalled()
    expect(payloadPatches).toEqual([{ plotId: 'plot-1' }])
  })

  it('resolves a plot the worker spelled with different case or separators', async () => {
    for (const typed of ['plot block a', 'plot BLOCK-A', 'plot  Block   A ']) {
      payloadPatches.length = 0
      const result = await applyLotEnrichText(user, typed)

      expect(result).toMatchObject({ handled: true })
      expect(payloadPatches).toEqual([{ plotId: 'plot-1' }])
      expect(mockCanonical).not.toHaveBeenCalled()
    }
  })

  it('reports an unknown plot instead of guessing', async () => {
    const result = await applyLotEnrichText(user, 'plot Block Z')

    expect(result).toMatchObject({ handled: true })
    expect(payloadPatches).toEqual([])
    expect((result as { reply: string }).reply).toContain('Block Z')
  })

  it('does not handle text with no pending draft', async () => {
    draft = null
    expect(await applyLotEnrichText(user, 'notes Récolte du matin')).toEqual({ handled: false })
    expect(mockCanonical).not.toHaveBeenCalled()
  })
})

describe('applyConfirmedLotDraft', () => {
  it('carries the draft locale onto the lot row, with identifiers verbatim', async () => {
    await applyConfirmedLotDraft(
      user,
      'enrich_lot',
      {
        lotId: 'lot-1',
        lotCode: 'TRV-LOT-2026-014',
        productName: 'Plantain',
        unit: 'crates',
        quantityKg: 24,
        publicNotes: 'Harvested this morning',
      },
      { sourceLocale: 'fr', translationStatus: 'pending' },
    )

    expect(enrichHarvestLot).toHaveBeenCalledWith(
      expect.objectContaining({
        contentLocale: { sourceLocale: 'fr', translationStatus: 'pending' },
        updates: expect.objectContaining({
          productName: 'Plantain',
          unit: 'crates',
          quantityKg: 24,
          publicNotes: 'Harvested this morning',
        }),
      }),
    )
  })

  it('lets the write path normalize when the caller sends no locale', async () => {
    await applyConfirmedLotDraft(user, 'enrich_lot', {
      lotId: 'lot-1',
      publicNotes: 'Récolte du matin',
    })

    expect(enrichHarvestLot).toHaveBeenCalledWith(
      expect.objectContaining({ contentLocale: undefined }),
    )
  })

  it('carries the draft locale onto a verify note', async () => {
    await applyConfirmedLotDraft(
      supervisor,
      'verify_lot',
      { lotId: 'lot-1', status: 'verified', note: 'Très bonne qualité' },
      { sourceLocale: 'fr', translationStatus: 'pending' },
    )

    expect(verifyHarvestLot).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'verified',
        note: 'Très bonne qualité',
        contentLocale: { sourceLocale: 'fr', translationStatus: 'pending' },
      }),
    )
  })
})
