import { describe, expect, it } from 'vitest'
import {
  BRIEFING_MESSAGES,
  briefingDateLabel,
  renderBriefing,
  type BriefingMessageKey,
} from './briefing-messages.js'
import type { ReplyLocale } from './reply-locale.js'

const LOCALES: ReplyLocale[] = ['en', 'fr', 'yo', 'pcm']
const KEYS = Object.keys(BRIEFING_MESSAGES) as BriefingMessageKey[]

describe('BRIEFING_MESSAGES coverage', () => {
  it('translates every key into every supported locale', () => {
    for (const key of KEYS) {
      for (const locale of LOCALES) {
        expect(BRIEFING_MESSAGES[key][locale], `${key}.${locale}`).toBeTruthy()
      }
    }
  })

  it('never leaves a non-English label sitting on the English string', () => {
    // Pidgin is English-lexified, so a few short labels are the same words in
    // both. Everything with a sentence in it must still differ.
    const sharedWithPidgin = new Set<BriefingMessageKey>([
      'briefing.farmFallback',
      'briefing.restock.label',
    ])

    for (const key of KEYS) {
      expect(BRIEFING_MESSAGES[key].fr, `${key}.fr`).not.toBe(BRIEFING_MESSAGES[key].en)
      expect(BRIEFING_MESSAGES[key].yo, `${key}.yo`).not.toBe(BRIEFING_MESSAGES[key].en)
      if (!sharedWithPidgin.has(key)) {
        expect(BRIEFING_MESSAGES[key].pcm, `${key}.pcm`).not.toBe(BRIEFING_MESSAGES[key].en)
      }
    }
  })

  it('keeps every parameter of a key in all four translations', () => {
    const paramsOf = (template: string) =>
      [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()

    for (const key of KEYS) {
      const expected = paramsOf(BRIEFING_MESSAGES[key].en)
      for (const locale of LOCALES) {
        expect(paramsOf(BRIEFING_MESSAGES[key][locale]), `${key}.${locale}`).toEqual(expected)
      }
    }
  })
})

describe('renderBriefing', () => {
  it('interpolates a count into every locale', () => {
    expect(renderBriefing('briefing.approvals.detail', 'en', { count: 3 })).toBe(
      '3 task(s) waiting for your review',
    )
    expect(renderBriefing('briefing.approvals.detail', 'fr', { count: 3 })).toBe(
      '3 tâche(s) en attente de votre examen',
    )
    expect(renderBriefing('briefing.approvals.detail', 'yo', { count: 3 })).toBe(
      'Iṣẹ́ 3 ń dúró de àyẹ̀wò rẹ',
    )
    expect(renderBriefing('briefing.approvals.detail', 'pcm', { count: 3 })).toBe(
      '3 work dey wait make you check am',
    )
  })

  it('carries quantities and units through untranslated', () => {
    const params = { quantity: 12, unit: 'kg', reorderLevel: 50 }

    for (const locale of LOCALES) {
      const line = renderBriefing('briefing.restock.detail', locale, params)
      expect(line, locale).toContain('12 kg')
      expect(line, locale).toContain('50')
    }
  })

  it('quotes an item name exactly as the farm spelled it', () => {
    for (const locale of LOCALES) {
      expect(renderBriefing('briefing.restock.label', locale, { item: 'Engrais NPK' })).toContain(
        'Engrais NPK',
      )
    }
  })

  it('renders a non-English owner a line that is not the English one', () => {
    const english = renderBriefing('briefing.fieldWork.detail', 'en', { count: 2 })

    for (const locale of LOCALES.filter((l) => l !== 'en')) {
      expect(renderBriefing('briefing.fieldWork.detail', locale, { count: 2 })).not.toBe(english)
    }
  })

  it('leaves an unknown placeholder alone rather than printing "undefined"', () => {
    expect(renderBriefing('briefing.restock.label', 'en', {})).toBe('Restock {item}')
  })
})

describe('briefingDateLabel', () => {
  const day = new Date('2026-07-25T09:00:00Z')

  it('names the day in the viewer language', () => {
    expect(briefingDateLabel('en', day)).toContain('July')
    expect(briefingDateLabel('fr', day)).toContain('juillet')
    expect(briefingDateLabel('yo', day)).not.toBe(briefingDateLabel('en', day))
  })

  it('keeps the same calendar date in every locale', () => {
    for (const locale of LOCALES) {
      expect(briefingDateLabel(locale, day), locale).toContain('2026')
      expect(briefingDateLabel(locale, day), locale).toContain('25')
    }
  })

  // Pidgin has no date conventions of its own and is written with Nigerian
  // English month names, so it formats as en-NG on purpose.
  it('formats Pidgin dates the Nigerian English way', () => {
    expect(briefingDateLabel('pcm', day)).toBe(briefingDateLabel('en', day))
  })
})
