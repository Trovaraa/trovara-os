import { describe, expect, it } from 'vitest'
import { renderEveningDigest } from './digest-messages.js'
import type { ExceptionSummary } from './exceptions.js'
import type { ReplyLocale } from './reply-locale.js'

const LOCALES: ReplyLocale[] = ['en', 'fr', 'yo', 'pcm']

const EMPTY_SUMMARY: ExceptionSummary = {
  overdueTasks: 0,
  lowStock: 0,
  pendingApprovals: 0,
  mortalityToday: 0,
  ordersPending: 0,
  rejectedTasks: 0,
  assetLogsMissing: 0,
  assetMaintenanceDue: 0,
  assetVerificationPending: 0,
  censusMissing: 0,
  censusRejected: 0,
  censusStale: 0,
  weatherAlerts: 0,
  total: 0,
}

function summary(overrides: Partial<ExceptionSummary>): ExceptionSummary {
  const merged = { ...EMPTY_SUMMARY, ...overrides }
  if (overrides.total === undefined) {
    merged.total =
      merged.overdueTasks +
      merged.lowStock +
      merged.pendingApprovals +
      merged.mortalityToday +
      merged.ordersPending +
      merged.rejectedTasks +
      merged.assetLogsMissing +
      merged.assetMaintenanceDue +
      merged.assetVerificationPending +
      merged.censusMissing +
      merged.censusRejected +
      merged.censusStale
  }
  return merged
}

describe('renderEveningDigest', () => {
  it('renders the farm name and every raised counter in English', () => {
    const msg = renderEveningDigest(
      'en',
      'Adeola Farms',
      summary({ overdueTasks: 3, lowStock: 1, censusStale: 2, weatherAlerts: 1 }),
    )

    expect(msg).toContain('🌙 Trovara evening digest — Adeola Farms')
    expect(msg).not.toContain('Farm ID')
    expect(msg).toContain('- Overdue tasks: 3')
    expect(msg).toContain('- Low stock: 1')
    expect(msg).toContain('- Stale censuses: 2')
    expect(msg).toContain('- Weather alerts: 1')
    expect(msg).toContain('Open items: 6')
  })

  it('orders the most time-critical counters first', () => {
    const msg = renderEveningDigest(
      'en',
      'Adeola Farms',
      summary({ censusMissing: 1, overdueTasks: 1, mortalityToday: 1, weatherAlerts: 1 }),
    )
    const labels = msg
      .split('\n')
      .filter((line) => line.startsWith('- '))
      .map((line) => line.slice(2, line.lastIndexOf(':')))

    expect(labels).toEqual([
      'Weather alerts',
      'Mortality today',
      'Overdue tasks',
      'Blocks without a census',
    ])
  })

  it('drops zero counters so a quiet day stays short', () => {
    const msg = renderEveningDigest('en', 'Adeola Farms', summary({ lowStock: 2 }))

    expect(msg.split('\n').filter((line) => line.startsWith('- '))).toHaveLength(1)
    expect(msg).not.toContain('Overdue tasks')
    expect(msg).not.toContain('Mortality today')
  })

  it('renders the all-clear line instead of an empty digest', () => {
    for (const locale of LOCALES) {
      const msg = renderEveningDigest(locale, 'Adeola Farms', EMPTY_SUMMARY)
      expect(msg).toContain('✅')
      expect(msg).toContain('Adeola Farms')
      expect(msg.split('\n').some((line) => line.startsWith('- '))).toBe(false)
      expect(msg).not.toContain('Open items')
    }
  })

  it('renders localized copy in each locale', () => {
    const counts = summary({ overdueTasks: 4, mortalityToday: 2 })

    expect(renderEveningDigest('fr', 'Ferme Adeola', counts)).toContain('- Tâches en retard: 4')
    expect(renderEveningDigest('fr', 'Ferme Adeola', counts)).toContain('Points ouverts : 6')
    expect(renderEveningDigest('yo', 'Oko Adéọlá', counts)).toContain('Àkótán alẹ́ Trovara')
    expect(renderEveningDigest('yo', 'Oko Adéọlá', counts)).toContain('- Ikú ẹran lónìí: 2')
    expect(renderEveningDigest('pcm', 'Adeola Farms', counts)).toContain('- Animal wey die today: 2')
    expect(renderEveningDigest('pcm', 'Adeola Farms', counts)).toContain('Things wey remain: 6')
  })

  it('never falls back to the English digest for a translated locale', () => {
    const cases: ExceptionSummary[] = [
      EMPTY_SUMMARY,
      summary({ overdueTasks: 1 }),
      summary({
        overdueTasks: 1,
        lowStock: 2,
        pendingApprovals: 3,
        mortalityToday: 4,
        ordersPending: 5,
        rejectedTasks: 6,
        assetLogsMissing: 7,
        assetMaintenanceDue: 1,
        assetVerificationPending: 8,
        censusMissing: 9,
        censusRejected: 10,
        censusStale: 11,
        weatherAlerts: 12,
      }),
    ]

    for (const counts of cases) {
      const english = renderEveningDigest('en', 'Adeola Farms', counts)
      for (const locale of LOCALES.filter((l) => l !== 'en')) {
        const translated = renderEveningDigest(locale, 'Adeola Farms', counts)
        expect(translated).not.toBe(english)
        // Every line must differ, otherwise one label is silently untranslated.
        translated.split('\n').forEach((line, i) => {
          expect(line).not.toBe(english.split('\n')[i])
        })
      }
    }
  })
})
