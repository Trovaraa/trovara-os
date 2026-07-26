import { describe, expect, it, vi } from 'vitest'
import type { ReplyLocale } from './reply-locale.js'

// The renderers under test are pure, but importing the module opens a db client.
vi.mock('../db/index.js', () => ({ db: {} }))

const { renderProactiveAlert, renderProactiveAlertPush } = await import('./proactive-alerts.js')

const LOCALES: ReplyLocale[] = ['en', 'fr', 'yo', 'pcm']

const ALERTS = [
  {
    type: 'mortality_spike' as const,
    severity: 'high' as const,
    title: 'Mortality spike detected',
    message: '4 mortality logs were recorded in the last 7 days.',
    count: 4,
  },
  {
    type: 'low_stock' as const,
    severity: 'high' as const,
    title: 'Low stock items',
    message: '2 inventory item(s) are at or below reorder level.',
    count: 2,
  },
]

describe('renderProactiveAlert', () => {
  it('renders English exactly as the alert row stores it', () => {
    for (const alert of ALERTS) {
      const copy = renderProactiveAlert('en', alert)
      expect(copy.title).toBe(alert.title)
      expect(copy.message).toBe(alert.message)
    }
  })

  it('renders a different string for every locale', () => {
    const titles = LOCALES.map((locale) => renderProactiveAlert(locale, ALERTS[0]).title)
    expect(new Set(titles).size).toBe(LOCALES.length)
  })

  it('keeps the count verbatim in every locale', () => {
    for (const locale of LOCALES) {
      const copy = renderProactiveAlert(locale, { type: 'overdue_tasks', count: 12 })
      expect(copy.message).toContain('12')
    }
  })

  it('keeps the mortality window consistent with the alert metadata', () => {
    for (const locale of LOCALES) {
      const copy = renderProactiveAlert(locale, { type: 'mortality_spike', count: 5 })
      expect(copy.message).toContain('7')
    }
  })

  it('covers every alert type in every locale', () => {
    const types = [
      'low_stock',
      'overdue_tasks',
      'mortality_spike',
      'crop_stage_reminder',
      'asset_log_missing',
      'asset_verification_pending',
    ] as const

    for (const type of types) {
      for (const locale of LOCALES) {
        const copy = renderProactiveAlert(locale, { type, count: 3 })
        expect(copy.title.trim().length).toBeGreaterThan(0)
        expect(copy.message).toContain('3')
      }
    }
  })
})

describe('renderProactiveAlertPush', () => {
  it('lists every alert under a localized header', () => {
    const msg = renderProactiveAlertPush('fr', 'Ferme Oke', ALERTS)

    expect(msg.split('\n')).toHaveLength(3)
    expect(msg).toContain('Alertes proactives pour Ferme Oke')
    expect(msg).toContain('Pic de mortalité détecté')
    expect(msg).toContain('Articles en stock faible')
  })

  it('never translates the farm name', () => {
    for (const locale of LOCALES) {
      expect(renderProactiveAlertPush(locale, 'Oke Farms Ltd', ALERTS)).toContain('Oke Farms Ltd')
      expect(renderProactiveAlertPush(locale, 'Oke Farms Ltd', [])).toContain('Oke Farms Ltd')
    }
  })

  it('reports an all-clear in the reader language when nothing is raised', () => {
    expect(renderProactiveAlertPush('en', 'Oke', [])).toBe(
      '✅ Proactive check (Oke): no urgent issues detected.',
    )
    expect(renderProactiveAlertPush('fr', 'Oke', [])).toContain('aucun problème urgent détecté')
    expect(renderProactiveAlertPush('yo', 'Oke', [])).toContain('kò sí ìṣòro kánkán')
  })
})
