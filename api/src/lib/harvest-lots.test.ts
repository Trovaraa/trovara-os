import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, unknown>

/** The single lot the mocked db knows about, and every `set(...)` applied to it. */
const lotRows: Row[] = []
const lotUpdates: Row[] = []

/** `preferred_locale` of the staff member performing the write. */
let preferredLocale: string | null = null

/**
 * `db.select()` with no projection reads the lot. The author's locale lookup
 * moved behind `authorLocaleForUserId`, so a projected select is now only an
 * existence check, which needs nothing but a row.
 */
vi.mock('../db/index.js', () => ({
  db: {
    select: (columns?: unknown) => {
      const rows: Row[] = columns ? [{ id: 'present' }] : lotRows
      const self = {
        from: () => self,
        where: () => self,
        orderBy: () => self,
        limit: async () => rows,
        then: (resolve: (rows: Row[]) => unknown, reject: (err: unknown) => unknown) =>
          Promise.resolve(rows).then(resolve, reject),
      }
      return self
    },
    update: () => ({
      set: (values: Row) => ({
        where: () => ({
          returning: async () => {
            lotUpdates.push(values)
            return [{ ...lotRows[0], ...values }]
          },
        }),
      }),
    }),
  },
}))

vi.mock('./audit.js', () => ({ logAudit: vi.fn(async () => undefined) }))
vi.mock('./farm-events.js', () => ({ recordFarmEvent: vi.fn(async () => undefined) }))

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
  // Real behaviour: a preference nobody chose is not a usable hint, and an
  // unset one reads back as the 'en' default, so it falls through to detection.
  authorLocaleForUserId: async () =>
    !preferredLocale || preferredLocale === 'en' ? null : preferredLocale,
}))

const { toCanonicalEnglish } = await import('./content-locale.js')
const { enrichHarvestLot, verifyHarvestLot } = await import('./harvest-lots.js')

const mockCanonical = vi.mocked(toCanonicalEnglish)

const LOT_ID = '22222222-2222-2222-2222-222222222222'

function lot(overrides: Row = {}): Row {
  return {
    id: LOT_ID,
    farmId: 'farm-1',
    lotCode: 'TRV-LOT-2026-014',
    publicToken: 'f1e2d3c4-0000-4000-8000-abcdefabcdef',
    productName: 'Plantain',
    quantityKg: 24,
    unit: 'crates',
    publicNotes: null,
    internalNotes: null,
    sourceLocale: null,
    translationStatus: 'done',
    plotId: null,
    photoUrl: null,
    verificationStatus: 'reported',
    ...overrides,
  }
}

/** Stand-in translator: French in, English out, so a stored note is unmistakable. */
function translatesFrenchTo(english: string) {
  mockCanonical.mockImplementation(async ({ text, sourceLocale }: CanonicalArgs) => ({
    english: sourceLocale === 'en' || sourceLocale == null ? text : english,
    sourceLocale: resolvedLocale(sourceLocale),
    status: 'done' as const,
  }))
}

/** Every string the write path handed to the translator. */
function translatedTexts(): string[] {
  return mockCanonical.mock.calls.map((call) => call[0].text)
}

beforeEach(() => {
  vi.clearAllMocks()
  lotRows.length = 0
  lotUpdates.length = 0
  preferredLocale = null
  mockCanonical.mockImplementation(async ({ text, sourceLocale }: CanonicalArgs) => ({
    english: text,
    sourceLocale: resolvedLocale(sourceLocale),
    status: 'done' as const,
  }))
})

describe('enrichHarvestLot', () => {
  it('stores a French public note as English with the author locale', async () => {
    lotRows.push(lot())
    preferredLocale = 'fr'
    translatesFrenchTo('Harvested fresh this morning')

    const result = await enrichHarvestLot({
      farmId: 'farm-1',
      lotId: LOT_ID,
      userId: 'user-1',
      updates: { publicNotes: 'Récolté frais ce matin' },
    })

    expect('lot' in result).toBe(true)
    expect(mockCanonical).toHaveBeenCalledWith({
      text: 'Récolté frais ce matin',
      farmId: 'farm-1',
      sourceLocale: 'fr',
    })
    expect(lotUpdates[0]).toMatchObject({
      publicNotes: 'Harvested fresh this morning',
      sourceLocale: 'fr',
      translationStatus: 'done',
    })
  })

  it('normalizes the internal note too, in its own column', async () => {
    lotRows.push(lot())
    preferredLocale = 'fr'
    mockCanonical.mockImplementation(async ({ text }: CanonicalArgs) => ({
      english: text === 'Deux caisses abîmées' ? 'Two damaged crates' : 'Harvested this morning',
      sourceLocale: 'fr' as const,
      status: 'done' as const,
    }))

    await enrichHarvestLot({
      farmId: 'farm-1',
      lotId: LOT_ID,
      userId: 'user-1',
      updates: { publicNotes: 'Récolté ce matin', internalNotes: 'Deux caisses abîmées' },
    })

    expect(lotUpdates[0]).toMatchObject({
      publicNotes: 'Harvested this morning',
      internalNotes: 'Two damaged crates',
    })
  })

  it('never sends the lot code, product name or unit to the translator', async () => {
    lotRows.push(lot())
    preferredLocale = 'fr'
    translatesFrenchTo('Harvested this morning')

    await enrichHarvestLot({
      farmId: 'farm-1',
      lotId: LOT_ID,
      userId: 'user-1',
      updates: {
        productName: 'Plantain',
        quantityKg: 24,
        unit: 'crates',
        publicNotes: 'Récolté ce matin',
      },
    })

    expect(translatedTexts()).toEqual(['Récolté ce matin'])
    expect(lotUpdates[0]).toMatchObject({
      productName: 'Plantain',
      quantityKg: 24,
      unit: 'crates',
    })
  })

  it('stores the original as pending when the translation fails, and still writes', async () => {
    lotRows.push(lot())
    preferredLocale = 'fr'
    mockCanonical.mockResolvedValue({
      english: 'Récolté ce matin',
      sourceLocale: 'fr',
      status: 'pending',
    })

    const result = await enrichHarvestLot({
      farmId: 'farm-1',
      lotId: LOT_ID,
      userId: 'user-1',
      updates: { publicNotes: 'Récolté ce matin' },
    })

    expect('lot' in result).toBe(true)
    expect(lotUpdates[0]).toMatchObject({
      publicNotes: 'Récolté ce matin',
      sourceLocale: 'fr',
      translationStatus: 'pending',
    })
  })

  it('writes the note when the translator throws rather than failing the write', async () => {
    lotRows.push(lot())
    preferredLocale = 'fr'
    mockCanonical.mockRejectedValue(new Error('llm unavailable'))

    const result = await enrichHarvestLot({
      farmId: 'farm-1',
      lotId: LOT_ID,
      userId: 'user-1',
      updates: { publicNotes: 'Récolté ce matin' },
    })

    expect('lot' in result).toBe(true)
    expect(lotUpdates[0]).toMatchObject({
      publicNotes: 'Récolté ce matin',
      sourceLocale: 'fr',
      translationStatus: 'pending',
    })
  })

  it('detects the language from the text when the author is on the default locale', async () => {
    lotRows.push(lot())
    preferredLocale = null

    await enrichHarvestLot({
      farmId: 'farm-1',
      lotId: LOT_ID,
      userId: 'user-1',
      updates: { publicNotes: 'Harvested this morning' },
    })

    expect(mockCanonical).toHaveBeenCalledWith({
      text: 'Harvested this morning',
      farmId: 'farm-1',
      sourceLocale: null,
    })
  })

  it('trusts a caller that already normalized the notes', async () => {
    lotRows.push(lot())
    preferredLocale = 'fr'

    await enrichHarvestLot({
      farmId: 'farm-1',
      lotId: LOT_ID,
      userId: 'user-1',
      updates: { publicNotes: 'Harvested this morning' },
      contentLocale: { sourceLocale: 'fr', translationStatus: 'pending' },
    })

    expect(mockCanonical).not.toHaveBeenCalled()
    expect(lotUpdates[0]).toMatchObject({
      publicNotes: 'Harvested this morning',
      sourceLocale: 'fr',
      translationStatus: 'pending',
    })
  })

  it('leaves a row the retry job still owes work on alone', async () => {
    lotRows.push(lot({ sourceLocale: 'yo', translationStatus: 'pending' }))
    preferredLocale = null

    await enrichHarvestLot({
      farmId: 'farm-1',
      lotId: LOT_ID,
      userId: 'user-1',
      updates: { publicNotes: 'Harvested this morning' },
    })

    expect(lotUpdates[0]).not.toHaveProperty('translationStatus')
    expect(lotUpdates[0]).not.toHaveProperty('sourceLocale')
  })

  it('touches no locale column when the update carries no prose', async () => {
    lotRows.push(lot())

    await enrichHarvestLot({
      farmId: 'farm-1',
      lotId: LOT_ID,
      userId: 'user-1',
      updates: { quantityKg: 30, unit: 'kg' },
    })

    expect(mockCanonical).not.toHaveBeenCalled()
    expect(lotUpdates[0]).toEqual({ quantityKg: 30, unit: 'kg' })
  })
})

describe('verifyHarvestLot', () => {
  it('stores the verification note as English and keeps the status enum', async () => {
    lotRows.push(lot())
    preferredLocale = 'fr'
    translatesFrenchTo('Very good quality')

    const result = await verifyHarvestLot({
      farmId: 'farm-1',
      lotId: LOT_ID,
      userId: 'user-2',
      status: 'verified',
      note: 'Très bonne qualité',
    })

    expect('lot' in result).toBe(true)
    expect(translatedTexts()).toEqual(['Très bonne qualité'])
    expect(lotUpdates[0]).toMatchObject({
      verificationStatus: 'verified',
      internalNotes: 'Very good quality',
      sourceLocale: 'fr',
      translationStatus: 'done',
    })
  })

  it('leaves the existing note and locale columns alone when no note is sent', async () => {
    lotRows.push(lot({ internalNotes: 'Weighed twice' }))
    preferredLocale = 'fr'

    await verifyHarvestLot({
      farmId: 'farm-1',
      lotId: LOT_ID,
      userId: 'user-2',
      status: 'rejected',
    })

    expect(mockCanonical).not.toHaveBeenCalled()
    expect(lotUpdates[0]).toMatchObject({ internalNotes: 'Weighed twice' })
    expect(lotUpdates[0]).not.toHaveProperty('translationStatus')
  })
})
