import { beforeEach, describe, expect, it, vi } from 'vitest'

const toCanonicalEnglish = vi.fn()

vi.mock('../db/index.js', () => ({ db: {} }))
vi.mock('./content-locale.js', () => ({ toCanonicalEnglish }))

async function canonicalize(params: {
  payload: Record<string, unknown>
  verbatim: readonly string[]
  authorLocale?: string | null
}) {
  const { canonicalizeDraftPayload } = await import('./draft-canonical.js')
  return canonicalizeDraftPayload({ farmId: 'farm-1', ...params })
}

/** French in, English out; anything else is already English. */
const FRENCH_TO_ENGLISH: Record<string, string> = {
  'feuilles jaunes': 'yellow leaves',
  'après la pluie': 'after the rain',
}

beforeEach(() => {
  vi.clearAllMocks()
  toCanonicalEnglish.mockImplementation(async ({ text }: { text: string }) => {
    const english = FRENCH_TO_ENGLISH[text]
    return english
      ? { english, sourceLocale: 'fr', status: 'done' }
      : { english: text, sourceLocale: 'en', status: 'done' }
  })
})

describe('canonicalizeDraftPayload', () => {
  // The point of the inverted default: a field nobody thought about is prose.
  it('normalizes a field it was never told about', async () => {
    const { payload, locale } = await canonicalize({
      payload: { plotId: 'plot-1', plantCount: 120, notes: 'feuilles jaunes' },
      verbatim: ['plotId'],
    })

    expect(payload).toEqual({ plotId: 'plot-1', plantCount: 120, notes: 'yellow leaves' })
    expect(locale).toEqual({ sourceLocale: 'fr', translationStatus: 'done' })
  })

  it('leaves ids, keys and entity names exactly as they were', async () => {
    const { payload, locale } = await canonicalize({
      payload: {
        plotId: 'plot-1',
        plotName: 'Bloc Nord',
        cropType: 'coconut',
        heightUnit: 'cm',
        plantCount: 120,
      },
      verbatim: ['plotId', 'plotName', 'cropType', 'heightUnit'],
    })

    expect(toCanonicalEnglish).not.toHaveBeenCalled()
    expect(payload).toEqual({
      plotId: 'plot-1',
      plotName: 'Bloc Nord',
      cropType: 'coconut',
      heightUnit: 'cm',
      plantCount: 120,
    })
    expect(locale).toEqual({})
  })

  // One pair of columns describes the whole row, so it can only be as good as
  // the weakest field on it.
  it('reports the draft pending when any one field is still the author\u2019s words', async () => {
    toCanonicalEnglish.mockImplementation(async ({ text }: { text: string }) =>
      text === 'après la pluie'
        ? { english: text, sourceLocale: 'fr', status: 'pending' }
        : { english: text, sourceLocale: 'en', status: 'done' },
    )

    const { locale } = await canonicalize({
      payload: { notes: 'morning count', reason: 'après la pluie' },
      verbatim: [],
    })

    expect(locale).toEqual({ sourceLocale: 'fr', translationStatus: 'pending' })
  })

  it('names the author language even when an English field came first', async () => {
    const { locale } = await canonicalize({
      payload: { notes: 'morning count', reason: 'feuilles jaunes' },
      verbatim: [],
    })

    expect(locale).toEqual({ sourceLocale: 'fr', translationStatus: 'done' })
  })

  it('spends nothing on numbers, nulls and blank strings', async () => {
    const { locale } = await canonicalize({
      payload: { plantCount: 120, minHeight: null, notes: '   ' },
      verbatim: [],
    })

    expect(toCanonicalEnglish).not.toHaveBeenCalled()
    expect(locale).toEqual({})
  })

  it('passes the author language on as the hint rather than detecting it again', async () => {
    await canonicalize({
      payload: { notes: 'feuilles jaunes' },
      verbatim: [],
      authorLocale: 'fr',
    })

    expect(toCanonicalEnglish).toHaveBeenCalledWith({
      text: 'feuilles jaunes',
      farmId: 'farm-1',
      sourceLocale: 'fr',
    })
  })
})
