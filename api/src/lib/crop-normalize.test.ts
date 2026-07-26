import { describe, expect, it } from 'vitest'
import {
  CANONICAL_CROP_TYPES,
  CROP_ALIASES,
  normalizeCropType,
} from './crop-normalize.js'
import { CROP_ADVISORY_PLAYBOOKS, cropRulesForCycle } from './advisory-playbooks.js'
import type { ReplyLocale } from './reply-locale.js'

/** Every language the butler channels accept. */
const LOCALES: readonly ReplyLocale[] = ['en', 'fr', 'yo', 'pcm']

/**
 * Crops the generic playbook does not cover: the normal case on a farm, and
 * they must stay as typed. They are not crops we cannot advise — a cycle is
 * advised off its own `crop_cycle_tasks` rows whatever its name reads as — they
 * are crops with no fallback to reach.
 */
const UNKNOWN_CROPS = [
  'tomato',
  'maïs',
  'mais',
  'Cassava',
  'poultry_prep',
  'mixed',
  'igname',
  'pepper & okra',
]

describe('crop-normalize', () => {
  it('takes its canonical key set from the fallback playbook itself', () => {
    expect(CANONICAL_CROP_TYPES).toEqual(['coconut', 'plantain'])
    expect(Object.keys(CROP_ALIASES).sort()).toEqual([...CANONICAL_CROP_TYPES])
  })

  it('every canonical key reaches at least one fallback playbook', () => {
    for (const canonical of CANONICAL_CROP_TYPES) {
      expect(
        CROP_ADVISORY_PLAYBOOKS.some((playbook) => playbook.cropType === canonical),
      ).toBe(true)
    }
  })

  describe('language coverage', () => {
    // A new fallback playbook adds a key to CANONICAL_CROP_TYPES, and this
    // fails until aliases for all four languages are written for it.
    for (const canonical of CANONICAL_CROP_TYPES) {
      for (const locale of LOCALES) {
        it(`reaches "${canonical}" from ${locale}`, () => {
          const aliases = CROP_ALIASES[canonical]?.[locale] ?? []
          expect(aliases.length).toBeGreaterThan(0)
          for (const alias of aliases) {
            expect(normalizeCropType(alias)).toEqual({ canonical, matched: true })
          }
        })
      }
    }
  })

  it('always returns a key the fallback playbook resolves, for every declared alias', () => {
    for (const byLocale of Object.values(CROP_ALIASES)) {
      for (const alias of Object.values(byLocale).flat()) {
        const { canonical } = normalizeCropType(alias)
        // The exact-match contract: the stored string is a key, not a synonym.
        expect(CANONICAL_CROP_TYPES).toContain(canonical)
        expect(
          cropRulesForCycle({ cropType: canonical, stage: 'vegetative' }, []).length,
        ).toBeGreaterThan(0)
      }
    }
  })

  it('resolves the crop names a French worker actually types', () => {
    expect(normalizeCropType('banane plantain').canonical).toBe('plantain')
    expect(normalizeCropType('bananes plantains').canonical).toBe('plantain')
    expect(normalizeCropType('noix de coco').canonical).toBe('coconut')
    expect(normalizeCropType('cocotier').canonical).toBe('coconut')
  })

  it('resolves Yoruba and Pidgin crop names', () => {
    expect(normalizeCropType('ọgẹdẹ àgbagbà').canonical).toBe('plantain')
    expect(normalizeCropType('àgbagbà').canonical).toBe('plantain')
    expect(normalizeCropType('àgbọn').canonical).toBe('coconut')
    expect(normalizeCropType('kokonut').canonical).toBe('coconut')
    expect(normalizeCropType('plantin').canonical).toBe('plantain')
  })

  it('ignores case, surrounding whitespace and word separators', () => {
    expect(normalizeCropType('  PLANTAIN  ').canonical).toBe('plantain')
    expect(normalizeCropType('Banane-Plantain').canonical).toBe('plantain')
    expect(normalizeCropType('banane_plantain').canonical).toBe('plantain')
    expect(normalizeCropType('NOIX  DE   COCO').canonical).toBe('coconut')
    expect(normalizeCropType('Coco Nut').canonical).toBe('coconut')
  })

  it('treats accented and unaccented spellings as the same word', () => {
    expect(normalizeCropType('agbon').canonical).toBe('coconut')
    expect(normalizeCropType('àgbọn').canonical).toBe('coconut')
    expect(normalizeCropType('ogede agbagba').canonical).toBe('plantain')
    expect(normalizeCropType('banane à cuire').canonical).toBe('plantain')
    expect(normalizeCropType('banane a cuire').canonical).toBe('plantain')
  })

  it('accepts common misspellings and plurals', () => {
    expect(normalizeCropType('plaintain').canonical).toBe('plantain')
    expect(normalizeCropType('platain').canonical).toBe('plantain')
    expect(normalizeCropType('coconuts').canonical).toBe('coconut')
    expect(normalizeCropType('cocnut').canonical).toBe('coconut')
    expect(normalizeCropType('Plantains').canonical).toBe('plantain')
  })

  it('is idempotent: a canonical key normalizes to itself', () => {
    for (const canonical of CANONICAL_CROP_TYPES) {
      const once = normalizeCropType(canonical)
      expect(once).toEqual({ canonical, matched: true })
      expect(normalizeCropType(once.canonical)).toEqual(once)
    }
  })

  describe('crops the fallback playbook does not cover', () => {
    it('passes the input through untouched, case and accents included', () => {
      for (const raw of UNKNOWN_CROPS) {
        expect(normalizeCropType(raw)).toEqual({ canonical: raw, matched: false })
      }
    })

    it('never invents a key, so the fallback stays a clean miss', () => {
      for (const raw of UNKNOWN_CROPS) {
        const { canonical } = normalizeCropType(raw)
        expect(
          CROP_ADVISORY_PLAYBOOKS.some((playbook) => playbook.cropType === canonical),
        ).toBe(false)
        expect(cropRulesForCycle({ cropType: canonical, stage: 'vegetative' }, [])).toEqual([])
      }
    })

    /**
     * What the miss costs, in full: a fallback, and nothing else. The crop name
     * does not decide whether a cycle is advised, only whether there is a
     * generic calendar to reach for when it has none of its own.
     */
    it('still advises a cycle off its own plan, matched or not', () => {
      for (const raw of UNKNOWN_CROPS) {
        const { canonical } = normalizeCropType(raw)
        const rules = cropRulesForCycle({ cropType: canonical, stage: 'vegetative' }, [
          {
            stage: 'vegetative',
            offsetDays: 18,
            templateName: 'Row mulching',
            description: null,
            translationStatus: 'done',
          },
        ])
        expect(rules).toHaveLength(1)
      }
    })

    it('leaves empty input empty rather than blanking or guessing', () => {
      expect(normalizeCropType('')).toEqual({ canonical: '', matched: false })
      expect(normalizeCropType('   ')).toEqual({ canonical: '   ', matched: false })
    })
  })
})
