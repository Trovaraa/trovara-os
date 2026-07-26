import { describe, expect, it } from 'vitest'
import {
  ADVISORY_REASON_CODES,
  ADVISORY_TABLES,
  FALLBACK_LOCALES,
  WEATHER_TABLES,
  WEATHER_THEME_IDS,
  isAdvisoryReasonCode,
  isWeatherThemeId,
  renderAdvisoryFallback,
  renderWeatherTheme,
  type AdvisoryReasonCode,
  type WeatherThemeId,
} from './advisory-fallback-messages.js'
import type { ReplyLocale } from './reply-locale.js'

const TRANSLATED_LOCALES = FALLBACK_LOCALES.filter((locale) => locale !== 'en')

const ADVISORY_FIELDS = ['happeningNow', 'whatNext'] as const
const WEATHER_FIELDS = ['title', 'detail'] as const

/**
 * Strings a non-English table is allowed to share byte-for-byte with English.
 * Pidgin legitimately reuses English wording, so a match is only a bug when it
 * is untranslated copy-paste rather than the natural way to write the line.
 * Empty today: every Pidgin entry currently differs from its English source.
 */
const SHARED_WITH_ENGLISH: ReadonlySet<string> = new Set([])

const advisoryKey = (locale: ReplyLocale, code: AdvisoryReasonCode, field: string): string =>
  `advisory.${locale}.${code}.${field}`

const weatherKey = (locale: ReplyLocale, id: WeatherThemeId, field: string): string =>
  `weather.${locale}.${id}.${field}`

/**
 * Swap one table entry for the duration of `run`, then put it back. The
 * English-fallback and unknown-code paths only fire on a gap, and there are no
 * gaps left to observe once the tables are complete.
 */
function withoutAdvisoryEntry(
  locale: ReplyLocale,
  code: AdvisoryReasonCode,
  run: () => void,
): void {
  const original = ADVISORY_TABLES[locale][code]
  delete ADVISORY_TABLES[locale][code]
  try {
    run()
  } finally {
    ADVISORY_TABLES[locale][code] = original
  }
}

function withoutWeatherEntry(locale: ReplyLocale, id: WeatherThemeId, run: () => void): void {
  const original = WEATHER_TABLES[locale][id]
  delete WEATHER_TABLES[locale][id]
  try {
    run()
  } finally {
    WEATHER_TABLES[locale][id] = original
  }
}

describe('fallback table coverage', () => {
  it('has the reason codes and theme ids to check', () => {
    expect(ADVISORY_REASON_CODES).toHaveLength(15)
    expect(WEATHER_THEME_IDS).toHaveLength(9)
    expect(FALLBACK_LOCALES).toEqual(['en', 'fr', 'yo', 'pcm'])
  })

  it.each(FALLBACK_LOCALES)('carries every advisory reason code in %s', (locale) => {
    const missing = ADVISORY_REASON_CODES.filter((code) => !ADVISORY_TABLES[locale][code])
    expect(missing).toEqual([])
  })

  it.each(FALLBACK_LOCALES)('carries every weather theme id in %s', (locale) => {
    const missing = WEATHER_THEME_IDS.filter((id) => !WEATHER_TABLES[locale][id])
    expect(missing).toEqual([])
  })

  it.each(FALLBACK_LOCALES)('adds no advisory reason code beyond the English set in %s', (locale) => {
    expect(Object.keys(ADVISORY_TABLES[locale]).sort()).toEqual([...ADVISORY_REASON_CODES].sort())
  })

  it.each(FALLBACK_LOCALES)('adds no weather theme id beyond the English set in %s', (locale) => {
    expect(Object.keys(WEATHER_TABLES[locale]).sort()).toEqual([...WEATHER_THEME_IDS].sort())
  })
})

describe('fallback entries are usable text', () => {
  it.each(FALLBACK_LOCALES)('has no empty or whitespace-only advisory entry in %s', (locale) => {
    const blank = ADVISORY_REASON_CODES.flatMap((code) =>
      ADVISORY_FIELDS.flatMap((field) => {
        const value = ADVISORY_TABLES[locale][code]?.[field]
        return typeof value === 'string' && value.trim() !== '' ? [] : [`${code}.${field}`]
      }),
    )
    expect(blank).toEqual([])
  })

  it.each(FALLBACK_LOCALES)('has no empty or whitespace-only weather entry in %s', (locale) => {
    const blank = WEATHER_THEME_IDS.flatMap((id) =>
      WEATHER_FIELDS.flatMap((field) => {
        const value = WEATHER_TABLES[locale][id]?.[field]
        return typeof value === 'string' && value.trim() !== '' ? [] : [`${id}.${field}`]
      }),
    )
    expect(blank).toEqual([])
  })
})

describe('no untranslated copy-paste', () => {
  it.each(TRANSLATED_LOCALES)('differs from the English advisory text in %s', (locale) => {
    const identical = ADVISORY_REASON_CODES.flatMap((code) =>
      ADVISORY_FIELDS.flatMap((field) => {
        const key = advisoryKey(locale, code, field)
        if (SHARED_WITH_ENGLISH.has(key)) return []
        return ADVISORY_TABLES[locale][code]?.[field] === ADVISORY_TABLES.en[code]?.[field]
          ? [key]
          : []
      }),
    )
    expect(identical).toEqual([])
  })

  it.each(TRANSLATED_LOCALES)('differs from the English weather text in %s', (locale) => {
    const identical = WEATHER_THEME_IDS.flatMap((id) =>
      WEATHER_FIELDS.flatMap((field) => {
        const key = weatherKey(locale, id, field)
        if (SHARED_WITH_ENGLISH.has(key)) return []
        return WEATHER_TABLES[locale][id]?.[field] === WEATHER_TABLES.en[id]?.[field] ? [key] : []
      }),
    )
    expect(identical).toEqual([])
  })

  it('excludes only keys that still exist', () => {
    const known = new Set([
      ...TRANSLATED_LOCALES.flatMap((locale) =>
        ADVISORY_REASON_CODES.flatMap((code) =>
          ADVISORY_FIELDS.map((field) => advisoryKey(locale, code, field)),
        ),
      ),
      ...TRANSLATED_LOCALES.flatMap((locale) =>
        WEATHER_THEME_IDS.flatMap((id) => WEATHER_FIELDS.map((field) => weatherKey(locale, id, field))),
      ),
    ])
    expect([...SHARED_WITH_ENGLISH].filter((key) => !known.has(key))).toEqual([])
  })
})

describe('renderAdvisoryFallback', () => {
  it('returns the requested locale, not English', () => {
    expect(renderAdvisoryFallback('crop_stage_fertilize', 'fr')).toEqual({
      happeningNow: 'Cette culture doit être fertilisée.',
      whatNext: "Appliquez l'engrais prévu et notez ce qui a été utilisé.",
    })

    expect(renderAdvisoryFallback('weather_rain', 'yo').happeningNow).toBe('A ń retí òjò.')
    expect(renderAdvisoryFallback('poultry_closeout', 'pcm').happeningNow).toBe(
      'Dis flock don near close-out.',
    )
  })

  it.each(TRANSLATED_LOCALES)('renders every reason code in %s from that locale', (locale) => {
    for (const code of ADVISORY_REASON_CODES) {
      expect(renderAdvisoryFallback(code, locale)).toBe(ADVISORY_TABLES[locale][code])
    }
  })

  it('renders English for the English locale', () => {
    expect(renderAdvisoryFallback('crop_stage_planted', 'en')).toEqual({
      happeningNow: 'A new planting is settling in.',
      whatNext: 'Check spacing and placement, and water lightly today.',
    })
  })

  it('falls back to English when the locale has no entry', () => {
    withoutAdvisoryEntry('fr', 'crop_stage_mulch', () => {
      expect(renderAdvisoryFallback('crop_stage_mulch', 'fr')).toEqual(
        ADVISORY_TABLES.en.crop_stage_mulch,
      )
    })

    // Restored afterwards, so the gap does not leak into the other tests.
    expect(renderAdvisoryFallback('crop_stage_mulch', 'fr')).toEqual(
      ADVISORY_TABLES.fr.crop_stage_mulch,
    )
  })

  it('returns the generic unknown-reason line for an unrecognised code', () => {
    expect(renderAdvisoryFallback('crop_stage_transplant', 'fr')).toEqual({
      happeningNow: "Cette culture ou ce lot demande de l'attention aujourd'hui.",
      whatNext: 'Allez vérifier et notez ce que vous trouvez.',
    })

    expect(renderAdvisoryFallback('', 'yo').happeningNow).toBe(
      'Ohun ọ̀gbìn tàbí agbo yìí nílò àkíyèsí lónìí.',
    )
    expect(renderAdvisoryFallback('nonsense', 'pcm').whatNext).toBe('Go check am, den write wetin you see.')
  })

  it.each(FALLBACK_LOCALES)('gives an unknown code the generic line, not a table entry, in %s', (locale) => {
    const generic = renderAdvisoryFallback('not_a_reason_code', locale)

    expect(generic.happeningNow.trim()).not.toBe('')
    expect(generic.whatNext.trim()).not.toBe('')
    expect(ADVISORY_REASON_CODES.map((code) => ADVISORY_TABLES[locale][code])).not.toContain(generic)
  })

  it('identifies advisory reason codes', () => {
    expect(isAdvisoryReasonCode('poultry_vaccination')).toBe(true)
    expect(isAdvisoryReasonCode('poultry_vaccinations')).toBe(false)
    expect(isAdvisoryReasonCode('toString')).toBe(false)
  })
})

describe('renderWeatherTheme', () => {
  it('returns null for an unknown id', () => {
    expect(renderWeatherTheme('rain-do-nothing', 'fr')).toBeNull()
    expect(renderWeatherTheme('', 'en')).toBeNull()
    expect(renderWeatherTheme('toString', 'yo')).toBeNull()
  })

  it('returns the requested locale, not English', () => {
    expect(renderWeatherTheme('heat-electrolytes', 'fr')).toEqual({
      title: 'Ajouter des électrolytes',
      detail: "Mettez des électrolytes dans l'eau de boisson tant que la chaleur dure.",
    })

    expect(renderWeatherTheme('wind-secure-covers', 'yo')?.title).toBe('So àwọn ìbòrí mọ́lẹ̀')
    expect(renderWeatherTheme('rain-delay-irrigation', 'pcm')?.title).toBe('No irrigate now')
  })

  it.each(TRANSLATED_LOCALES)('renders every theme id in %s from that locale', (locale) => {
    for (const id of WEATHER_THEME_IDS) {
      expect(renderWeatherTheme(id, locale)).toBe(WEATHER_TABLES[locale][id])
    }
  })

  it('renders English for the English locale', () => {
    expect(renderWeatherTheme('rain-delay-irrigation', 'en')).toEqual({
      title: 'Delay irrigation',
      detail: 'Skip or cut back watering while rain is expected.',
    })
  })

  it('falls back to English when the locale has no entry', () => {
    withoutWeatherEntry('yo', 'cold-protect-tender', () => {
      expect(renderWeatherTheme('cold-protect-tender', 'yo')).toEqual(
        WEATHER_TABLES.en['cold-protect-tender'],
      )
    })

    expect(renderWeatherTheme('cold-protect-tender', 'yo')).toEqual(
      WEATHER_TABLES.yo['cold-protect-tender'],
    )
  })

  it('identifies weather theme ids', () => {
    expect(isWeatherThemeId('wind-delay-foliar')).toBe(true)
    expect(isWeatherThemeId('wind_delay_foliar')).toBe(false)
    expect(isWeatherThemeId('constructor')).toBe(false)
  })
})
