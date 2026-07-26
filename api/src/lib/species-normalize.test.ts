import { describe, expect, it } from 'vitest'
import {
  CANONICAL_SPECIES,
  GENERIC_POULTRY_TERMS,
  POULTRY_TYPE_OPTIONS,
  SPECIES_ALIASES,
  isNoilerBatch,
  matchPoultryTypeAnswer,
  normalizeSpecies,
  normalizeSpeciesForWrite,
  resolveBatchTypeFromSpecies,
  resolvePoultryType,
} from './species-normalize.js'
import { poultryBatchTypeEnum } from '../db/schema.js'
import { NOILER_ADVISORY_PLAYBOOK } from './advisory-playbooks.js'
import type { ReplyLocale } from './reply-locale.js'

/** Every language the butler channels accept. */
const LOCALES: readonly ReplyLocale[] = ['en', 'fr', 'yo', 'pcm']

/** Species the enum cannot express: normal farm reality, and must stay as typed. */
const UNKNOWN_SPECIES = [
  'goat',
  'Goats',
  'chèvre',
  'chevre',
  'ewúrẹ́',
  'Catfish',
  'poisson-chat',
  'tilapia',
  'Kuroiler cockerel',
  'turkey',
  'pig',
  'mixed flock',
]

describe('species-normalize', () => {
  it('takes its canonical value set from the batch-type enum itself', () => {
    expect(CANONICAL_SPECIES).toEqual(['layer', 'noiler', 'pullet'])
    // Everything the column accepts except the "none of the above" member.
    expect([...CANONICAL_SPECIES, 'other'].sort()).toEqual(
      [...poultryBatchTypeEnum.enumValues].sort(),
    )
    expect(Object.keys(SPECIES_ALIASES).sort()).toEqual([...CANONICAL_SPECIES])
  })

  it('covers the batch type the noiler playbook is written for', () => {
    expect(CANONICAL_SPECIES).toContain(NOILER_ADVISORY_PLAYBOOK.batchType)
  })

  describe('language coverage', () => {
    // A new poultry type in the enum adds a value to CANONICAL_SPECIES, and this
    // fails until aliases for all four languages are written for it.
    for (const canonical of CANONICAL_SPECIES) {
      for (const locale of LOCALES) {
        it(`reaches "${canonical}" from ${locale}`, () => {
          const aliases = SPECIES_ALIASES[canonical]?.[locale] ?? []
          expect(aliases.length).toBeGreaterThan(0)
          for (const alias of aliases) {
            expect(normalizeSpecies(alias)).toEqual({
              canonical,
              matched: true,
              batchType: canonical,
            })
          }
        })
      }
    }
  })

  it('always returns a value the enum column accepts, for every declared alias', () => {
    for (const byLocale of Object.values(SPECIES_ALIASES)) {
      for (const alias of Object.values(byLocale).flat()) {
        const { canonical, batchType } = normalizeSpecies(alias)
        // The exact-match contract: the stored string is an enum member, not a synonym.
        expect(poultryBatchTypeEnum.enumValues).toContain(canonical)
        expect(batchType).toBe(canonical)
      }
    }
  })

  it('never lets one spelling claim two canonical values', () => {
    for (const [canonical, byLocale] of Object.entries(SPECIES_ALIASES)) {
      for (const alias of Object.values(byLocale).flat()) {
        // The same spelling listed under two values would resolve to the other one.
        expect(normalizeSpecies(alias).canonical).toBe(canonical)
      }
    }
  })

  it('resolves the species a French worker actually types', () => {
    expect(normalizeSpecies('poulet noiler').canonical).toBe('noiler')
    expect(normalizeSpecies('Poulets noiler').canonical).toBe('noiler')
    expect(normalizeSpecies('poulet à double fin').canonical).toBe('noiler')
    expect(normalizeSpecies('poule pondeuse').canonical).toBe('layer')
    expect(normalizeSpecies('pondeuses').canonical).toBe('layer')
    expect(normalizeSpecies('poulette').canonical).toBe('pullet')
  })

  it('resolves Yoruba and Pidgin species names', () => {
    expect(normalizeSpecies('adìẹ noiler').canonical).toBe('noiler')
    expect(normalizeSpecies('noiler').canonical).toBe('noiler')
    expect(normalizeSpecies('adìẹ ẹyin').canonical).toBe('layer')
    expect(normalizeSpecies('adìẹ ọdọ').canonical).toBe('pullet')
    expect(normalizeSpecies('noila').canonical).toBe('noiler')
    expect(normalizeSpecies('noiler fowl').canonical).toBe('noiler')
    expect(normalizeSpecies('egg fowl').canonical).toBe('layer')
    expect(normalizeSpecies('young fowl').canonical).toBe('pullet')
  })

  it('ignores case, surrounding whitespace and word separators', () => {
    expect(normalizeSpecies('  NOILER  ').canonical).toBe('noiler')
    expect(normalizeSpecies('Poulet-Noiler').canonical).toBe('noiler')
    expect(normalizeSpecies('poulet_noiler').canonical).toBe('noiler')
    expect(normalizeSpecies('Noiler   Chicken').canonical).toBe('noiler')
    expect(normalizeSpecies('Laying Hens').canonical).toBe('layer')
  })

  it('treats accented and unaccented spellings as the same word', () => {
    expect(normalizeSpecies('adie noiler').canonical).toBe('noiler')
    expect(normalizeSpecies('adìẹ noiler').canonical).toBe('noiler')
    expect(normalizeSpecies('poulet a double fin').canonical).toBe('noiler')
    expect(normalizeSpecies('poulet à double fin').canonical).toBe('noiler')
    expect(normalizeSpecies('adie eyin').canonical).toBe('layer')
    expect(normalizeSpecies('poulette prête à pondre').canonical).toBe('pullet')
  })

  it('accepts common misspellings and plurals', () => {
    expect(normalizeSpecies('noyler').canonical).toBe('noiler')
    expect(normalizeSpecies('nolier').canonical).toBe('noiler')
    expect(normalizeSpecies('Noilers').canonical).toBe('noiler')
    expect(normalizeSpecies('noiller').canonical).toBe('noiler')
    expect(normalizeSpecies('laiyer').canonical).toBe('layer')
    expect(normalizeSpecies('pulet').canonical).toBe('pullet')
  })

  it('is idempotent: a canonical value normalizes to itself', () => {
    for (const canonical of CANONICAL_SPECIES) {
      const once = normalizeSpecies(canonical)
      expect(once).toEqual({ canonical, matched: true, batchType: canonical })
      expect(normalizeSpecies(once.canonical)).toEqual(once)
    }
  })
})

describe('the bug: one row, one answer', () => {
  // "Noiler chicken" used to be a match to the advisory layer
  // (`species.includes(...)`) and not a match to the livestock routes
  // (`species === ...`), so the same row got tips and a 400 at once.
  // Both layers now call isNoilerBatch, so these are one assertion.
  const NOILER_SPELLINGS = [
    'Noiler chicken',
    'noiler',
    'Noilers',
    'poulet noiler',
    'Poulet noiler',
    'adìẹ noiler',
    'noila',
  ]

  it('recognizes every spelling as a noiler, normalized or raw', () => {
    for (const spelling of NOILER_SPELLINGS) {
      // As stored by a write path that went through the lexicon.
      const stored = normalizeSpeciesForWrite(spelling)
      expect(isNoilerBatch({ species: stored.species, batchType: stored.batchType })).toBe(true)
      // As a legacy row that never went through it.
      expect(isNoilerBatch({ species: spelling, batchType: null })).toBe(true)
    }
  })

  it('classifies the enum from the species at write time', () => {
    expect(normalizeSpeciesForWrite('Noiler chicken')).toEqual({
      species: 'noiler',
      batchType: 'noiler',
    })
    expect(normalizeSpeciesForWrite('poulet noiler')).toEqual({
      species: 'noiler',
      batchType: 'noiler',
    })
    expect(normalizeSpeciesForWrite('poule pondeuse')).toEqual({
      species: 'layer',
      batchType: 'layer',
    })
  })

  it('gates on the batch type the playbook declares, not on a literal', () => {
    expect(isNoilerBatch({ species: 'goat', batchType: NOILER_ADVISORY_PLAYBOOK.batchType })).toBe(
      true,
    )
  })
})

/**
 * The farm keeps Noilers, and a broiler is a different bird on a different
 * cycle. Dropping the broiler spellings is the point, not an oversight, so it is
 * asserted here: "broiler" resolves to nothing and the batch stays unclassified,
 * which is the honest answer. Filing it as a noiler would attach a dual-purpose
 * calendar to a meat bird, and the species text still reads back as typed either
 * way, so nothing the farmer wrote is lost.
 */
describe('broiler is no longer a species this farm knows', () => {
  const BROILER_SPELLINGS = [
    'broiler',
    'Broilers',
    'Broiler chicken',
    'poulet de chair',
    'broila',
    'Broiler (Ross 308)',
  ]

  it('does not resolve any broiler spelling to a canonical value', () => {
    for (const spelling of BROILER_SPELLINGS) {
      expect(normalizeSpecies(spelling).matched, spelling).toBe(false)
      expect(resolveBatchTypeFromSpecies(spelling), spelling).toBeNull()
      expect(isNoilerBatch({ species: spelling }), spelling).toBe(false)
    }
  })

  it('keeps the farmer wording and leaves the enum unset', () => {
    expect(normalizeSpeciesForWrite('Broiler (Ross 308)')).toEqual({
      species: 'Broiler (Ross 308)',
      batchType: null,
    })
  })

  it('is not reachable through the alias table in any language', () => {
    for (const byLocale of Object.values(SPECIES_ALIASES)) {
      for (const alias of Object.values(byLocale).flat()) {
        expect(alias.toLowerCase()).not.toContain('broiler')
      }
    }
  })
})

describe('legacy rows written before the lexicon', () => {
  // Real un-normalized values, which must stay recognized or live flocks
  // silently lose their advisory.
  const LEGACY_NOILERS = [
    'Noiler chicken',
    'Noiler (day old)',
    'day-old noilers',
    '500 noiler chicks',
    'Noiler - Amo',
    'NOILER CHICKENS',
  ]

  it('still recognizes them with no batch type set', () => {
    for (const species of LEGACY_NOILERS) {
      expect(isNoilerBatch({ species })).toBe(true)
      expect(isNoilerBatch({ species, batchType: null })).toBe(true)
    }
  })

  it('leaves their text alone: only the enum is derived', () => {
    for (const species of LEGACY_NOILERS) {
      const written = normalizeSpeciesForWrite(species)
      expect(written.batchType).toBe('noiler')
      // Descriptive text is not a canonical name, so it is kept verbatim.
      if (normalizeSpecies(species).matched) continue
      expect(written.species).toBe(species)
    }
  })

  it('reads a whole word, so a lookalike breed is not swept in', () => {
    // The old substring test is the only reason to be careful here.
    expect(isNoilerBatch({ species: 'Kuroiler cockerel' })).toBe(false)
    expect(resolveBatchTypeFromSpecies('Kuroiler cockerel')).toBeNull()
  })

  it('lets an explicit batch type overrule the text', () => {
    expect(isNoilerBatch({ species: 'noiler', batchType: 'layer' })).toBe(false)
    expect(isNoilerBatch({ species: 'Poulet noiler', batchType: 'other' })).toBe(false)
  })
})

/**
 * The batch type picks the vaccination calendar and the growth curve, so the
 * distinction that matters is not "did we resolve a type" but "is there a type
 * to resolve". A flock the farmer described without naming its production type
 * is a question; a goat pen is not.
 */
describe('poultry named without a production type', () => {
  const NAMES_POULTRY_ONLY = [
    'chickens',
    'chicken',
    'birds',
    'fowl',
    'day old chicks',
    'Kuroiler cockerel',
    'poulet',
    'poules',
    'volaille',
    'adìẹ',
    'adie',
    'ẹyẹ',
    'agric fowl',
  ]

  it('asks rather than resolving a type it was never told', () => {
    for (const raw of NAMES_POULTRY_ONLY) {
      expect(resolvePoultryType(raw), raw).toEqual({ status: 'unspecified' })
    }
  })

  it('still resolves the type when the words do name one', () => {
    expect(resolvePoultryType('noiler')).toEqual({ status: 'resolved', batchType: 'noiler' })
    expect(resolvePoultryType('poulet noiler')).toEqual({
      status: 'resolved',
      batchType: 'noiler',
    })
    expect(resolvePoultryType('poule pondeuse')).toEqual({ status: 'resolved', batchType: 'layer' })
    expect(resolvePoultryType('adìẹ ọdọ')).toEqual({ status: 'resolved', batchType: 'pullet' })
    // A named type inside descriptive text still wins over the generic word.
    expect(resolvePoultryType('500 noiler chicks')).toEqual({
      status: 'resolved',
      batchType: 'noiler',
    })
    expect(resolvePoultryType('layer hens from Amo')).toEqual({
      status: 'resolved',
      batchType: 'layer',
    })
  })

  it('leaves a farm keeping something else out of the poultry question', () => {
    for (const raw of UNKNOWN_SPECIES.filter((s) => s !== 'Kuroiler cockerel')) {
      expect(resolvePoultryType(raw), raw).toEqual({ status: 'unknown' })
    }
    expect(resolvePoultryType('')).toEqual({ status: 'unknown' })
    expect(resolvePoultryType(null)).toEqual({ status: 'unknown' })
  })

  // A generic word that resolved to a type would be the guess this replaces.
  it('never lets a generic word stand in for a production type', () => {
    for (const terms of Object.values(GENERIC_POULTRY_TERMS)) {
      for (const term of terms) {
        expect(resolveBatchTypeFromSpecies(term), term).toBeNull()
        expect(resolvePoultryType(term), term).toEqual({ status: 'unspecified' })
      }
    }
  })
})

describe('the answer to the poultry-type question', () => {
  it('takes every option the question offers, in any language', () => {
    expect(POULTRY_TYPE_OPTIONS).toEqual([...poultryBatchTypeEnum.enumValues])
    for (const option of POULTRY_TYPE_OPTIONS) {
      expect(matchPoultryTypeAnswer(option), option).toBe(option)
    }
    expect(matchPoultryTypeAnswer('Layers')).toBe('layer')
    expect(matchPoultryTypeAnswer('pondeuse')).toBe('layer')
    expect(matchPoultryTypeAnswer('adìẹ ẹyin')).toBe('layer')
    expect(matchPoultryTypeAnswer('  NOILER ')).toBe('noiler')
    expect(matchPoultryTypeAnswer('poulette')).toBe('pullet')
    expect(matchPoultryTypeAnswer('OTHER')).toBe('other')
  })

  // Anything else is a message for the butler, not an answer to swallow.
  it('takes nothing but the option itself', () => {
    expect(matchPoultryTypeAnswer('the layers are off feed')).toBeNull()
    expect(matchPoultryTypeAnswer('3 noilers died')).toBeNull()
    expect(matchPoultryTypeAnswer('yes')).toBeNull()
    expect(matchPoultryTypeAnswer('')).toBeNull()
  })
})

describe('species the enum cannot express', () => {
  it('passes the input through untouched, case and accents included', () => {
    for (const raw of UNKNOWN_SPECIES) {
      expect(normalizeSpecies(raw)).toEqual({ canonical: raw, matched: false, batchType: null })
      expect(normalizeSpeciesForWrite(raw)).toEqual({ species: raw, batchType: null })
    }
  })

  it('never invents a batch type, so the poultry features stay a clean miss', () => {
    for (const raw of UNKNOWN_SPECIES) {
      expect(resolveBatchTypeFromSpecies(raw)).toBeNull()
      expect(isNoilerBatch({ species: raw })).toBe(false)
    }
  })

  it('leaves goats and fish alone even next to a poultry batch', () => {
    expect(isNoilerBatch({ species: 'Goats', batchType: null })).toBe(false)
    expect(isNoilerBatch({ species: 'Catfish pond 2', batchType: null })).toBe(false)
    expect(isNoilerBatch({ species: 'chèvre', batchType: null })).toBe(false)
  })

  it('leaves empty input empty rather than blanking or guessing', () => {
    expect(normalizeSpecies('')).toEqual({ canonical: '', matched: false, batchType: null })
    expect(normalizeSpecies('   ')).toEqual({ canonical: '   ', matched: false, batchType: null })
    expect(resolveBatchTypeFromSpecies('')).toBeNull()
    expect(resolveBatchTypeFromSpecies(null)).toBeNull()
    expect(resolveBatchTypeFromSpecies('   ')).toBeNull()
  })
})
