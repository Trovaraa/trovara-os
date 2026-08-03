import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  DATE_PARAM_KEYS,
  EXCEPTION_MESSAGES,
  formatExceptionDate,
  isExceptionMessageKey,
  renderException,
  type ExceptionMessageKey,
} from './exception-messages.js'
import type { ReplyLocale } from './reply-locale.js'

const TRANSLATED_LOCALES = ['fr', 'yo', 'pcm'] as const satisfies readonly ReplyLocale[]
const ALL_LOCALES = ['en', ...TRANSLATED_LOCALES] as const satisfies readonly ReplyLocale[]

const KEYS = Object.keys(EXCEPTION_MESSAGES) as ExceptionMessageKey[]

/** The `{name}` tokens in a template, as a sorted list for set comparison. */
function placeholders(template: string): string[] {
  return [...new Set(Array.from(template.matchAll(/\{(\w+)\}/g), (m) => m[1]))].sort()
}

describe('EXCEPTION_MESSAGES coverage', () => {
  it('has keys to check', () => {
    expect(KEYS.length).toBeGreaterThan(0)
  })

  it.each(TRANSLATED_LOCALES)('translates every key into %s', (locale) => {
    const missing = KEYS.filter((key) => {
      const value = EXCEPTION_MESSAGES[key][locale]
      return typeof value !== 'string' || value.trim() === ''
    })
    expect(missing).toEqual([])
  })

  it.each(TRANSLATED_LOCALES)('keeps %s placeholders identical to English', (locale) => {
    const mismatches = KEYS.flatMap((key) => {
      const table = EXCEPTION_MESSAGES[key]
      const expected = placeholders(table.en)
      const actual = placeholders(table[locale] ?? '')
      return expected.join(',') === actual.join(',') ? [] : [{ key, expected, actual }]
    })
    expect(mismatches).toEqual([])
  })

  it('keeps the middot separator in every locale of censusSurvey', () => {
    for (const locale of ALL_LOCALES) {
      expect(EXCEPTION_MESSAGES['exceptions.title.censusSurvey'][locale]).toBe('{plot} · {crop}')
    }
  })
})

describe('renderException', () => {
  it('interpolates params in a non-English locale', () => {
    expect(
      renderException('exceptions.msg.lowStock', 'fr', {
        quantity: 4,
        unit: 'sacs',
        reorderLevel: 10,
      }),
    ).toBe('4 sacs restants (réappro. à 10 sacs)')

    expect(
      renderException('exceptions.msg.censusRejectedWithReason', 'pcm', { reason: 'blurry photo' }),
    ).toBe('Dem reject census: blurry photo')

    expect(renderException('exceptions.title.batchMortality', 'yo', { batch: 'BR-12' })).toBe(
      'Ikú BR-12',
    )
  })

  it('renders English unchanged', () => {
    expect(renderException('exceptions.action.approve', 'en', { title: 'Feed store' })).toBe(
      'Approve: Feed store',
    )
  })

  it('leaves unknown params as literal tokens', () => {
    expect(renderException('exceptions.msg.mortalityWithNotes', 'pcm', { count: 3 })).toBe(
      '3 don die: {notes}',
    )
  })

  // lowStock names {unit} twice (quantity on hand and reorder level), which
  // only works because the replace is global.
  it.each(ALL_LOCALES)('substitutes a repeated placeholder every time in %s', (locale) => {
    const rendered = renderException('exceptions.msg.lowStock', locale, {
      quantity: 3,
      unit: 'kg',
      reorderLevel: 10,
    })

    expect(rendered).not.toContain('{unit}')
    expect(rendered.match(/kg/g)).toHaveLength(2)
  })

  it('renders the low-stock reorder level with its unit in English', () => {
    expect(
      renderException('exceptions.msg.lowStock', 'en', {
        quantity: 3,
        unit: 'bags',
        reorderLevel: 10,
      }),
    ).toBe('3 bags remaining (reorder at 10 bags)')
  })

  it.each(TRANSLATED_LOCALES)('resolves a key-valued param translated in %s', (locale) => {
    const rendered = renderException('exceptions.msg.awaitingApproval', locale, {
      assignee: 'exceptions.unassigned',
    })

    expect(rendered).not.toContain('exceptions.unassigned')
    expect(rendered).toContain(EXCEPTION_MESSAGES['exceptions.unassigned'][locale] as string)
  })

  it('resolves the staff and block key params too', () => {
    expect(
      renderException('exceptions.msg.reportedNeedsVerification', 'fr', {
        reporter: 'exceptions.staff',
      }),
    ).toBe('Signalé par personnel - à vérifier')

    expect(renderException('exceptions.title.censusSurvey', 'fr', {
      plot: 'exceptions.block',
      crop: 'plantain',
    })).toBe('Bloc · plantain')
  })

  it('identifies exception message keys', () => {
    expect(isExceptionMessageKey('exceptions.unassigned')).toBe(true)
    expect(isExceptionMessageKey('unassigned')).toBe(false)
    expect(isExceptionMessageKey(42)).toBe(false)
  })
})

describe('date params', () => {
  const ISO = '2026-03-05T12:00:00.000Z'

  it('declares the date params', () => {
    expect([...DATE_PARAM_KEYS].sort()).toEqual(['lastVerified', 'nextService', 'since'])
  })

  it.each(ALL_LOCALES)('formats {since} as a date, not an ISO timestamp, in %s', (locale) => {
    const rendered = renderException('exceptions.msg.overdueSince', locale, { since: ISO })

    expect(rendered).not.toContain(ISO)
    expect(rendered).not.toMatch(/\d{4}-\d{2}-\d{2}T/)
    expect(rendered).toContain('2026')
    expect(rendered).toContain(formatExceptionDate(ISO, locale))
  })

  it.each(ALL_LOCALES)('formats {lastVerified} as a date in %s', (locale) => {
    const rendered = renderException('exceptions.msg.censusStale', locale, {
      days: 30,
      lastVerified: ISO,
    })

    expect(rendered).not.toContain(ISO)
    expect(rendered).not.toMatch(/\d{4}-\d{2}-\d{2}T/)
    expect(rendered).toContain('30')
    expect(rendered).toContain(formatExceptionDate(ISO, locale))
  })

  it('uses locale-appropriate month names', () => {
    expect(formatExceptionDate(ISO, 'fr')).toContain('mars')
    expect(formatExceptionDate(ISO, 'en')).toContain('Mar')
    expect(formatExceptionDate(ISO, 'pcm')).toContain('Mar')
  })

  it('returns unparseable input unchanged', () => {
    expect(formatExceptionDate('not a date', 'fr')).toBe('not a date')
    expect(renderException('exceptions.msg.overdueSince', 'fr', { since: 'not a date' })).toBe(
      'En retard depuis le not a date',
    )
  })
})

/**
 * The OS UI renders the same vocabulary through vue-i18n. Those catalogs live
 * in the app workspace, which neither tsc (api rootDir is api/src) nor vitest
 * (vite's fs boundary) will import from here, so they are read as source and
 * evaluated: they are plain data modules of the form `export default {…}`.
 */
describe('vue-i18n catalogs stay in sync', () => {
  const uiDir = fileURLToPath(new URL('../../../app/src/i18n/locales/exceptions/', import.meta.url))

  function loadUiCatalog(locale: ReplyLocale): Record<string, string> {
    const source = readFileSync(`${uiDir}${locale}.ts`, 'utf8')
    const literal = source
      .replace(/^[\s\S]*?\bexport default\s*/, '')
      .replace(/\s*as const\s*;?\s*$/, '')
    const catalog = new Function(`return (${literal})`)() as Record<string, unknown>
    return flatten(catalog)
  }

  function flatten(obj: Record<string, unknown>, prefix = ''): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${key}` : key
      if (value !== null && typeof value === 'object') {
        Object.assign(out, flatten(value as Record<string, unknown>, path))
      } else {
        out[path] = String(value)
      }
    }
    return out
  }

  /** 'exceptions.msg.lowStock' -> 'msg.lowStock' (the nested vue-i18n path). */
  const uiPath = (key: ExceptionMessageKey): string => key.slice('exceptions.'.length)

  it('exposes the same key paths in en.ts as the api table', () => {
    expect(Object.keys(loadUiCatalog('en')).sort()).toEqual(KEYS.map(uiPath).sort())
  })

  it.each(TRANSLATED_LOCALES)('mirrors en.ts key paths in %s.ts', (locale) => {
    expect(Object.keys(loadUiCatalog(locale)).sort()).toEqual(
      Object.keys(loadUiCatalog('en')).sort(),
    )
  })

  it.each(ALL_LOCALES)('matches the api strings in %s.ts', (locale) => {
    const catalog = loadUiCatalog(locale)
    const divergent = KEYS.flatMap((key) => {
      const api = EXCEPTION_MESSAGES[key][locale]
      const ui = catalog[uiPath(key)]
      return api === ui ? [] : [{ key, api, ui }]
    })
    expect(divergent).toEqual([])
  })
})
