import { describe, expect, it } from 'vitest'
import {
  customerPaymentReply,
  detectAuthorLocale,
  detectReplyLocale,
  normalizeLocaleHint,
  webCopilotLlmOffMessage,
  type ReplyLocale,
} from './reply-locale.js'

describe('detectReplyLocale', () => {
  it('detects French from accents and common words', () => {
    expect(detectReplyLocale('Bonjour, combien coûtent les oeufs ?')).toBe('fr')
    expect(detectReplyLocale('Où êtes-vous situés ?')).toBe('fr')
  })

  it('detects Pidgin markers', () => {
    expect(detectReplyLocale('Wetin una dey sell?')).toBe('pcm')
    expect(detectReplyLocale('How much e cost abeg')).toBe('pcm')
  })

  it('detects Yoruba characters', () => {
    expect(detectReplyLocale('Elo ni iye ẹyin?')).toBe('yo')
  })

  it('defaults to English and respects UI hint when text is empty', () => {
    expect(detectReplyLocale('How much are eggs?')).toBe('en')
    expect(detectReplyLocale('', 'fr')).toBe('fr')
    expect(detectReplyLocale('ok', 'fr')).toBe('fr')
  })

  // This detector also decides the stored `source_locale` for worker prose, so a
  // false French is not cosmetic: it sends English to a translator asked to
  // render French, which rewords the record and mislabels its provenance.
  // `plantain` is spelled the same in English and is this farm's main crop.
  it('does not read English farm prose as French', () => {
    for (const text of [
      'Harvest the plantain in Block A',
      'Deliver 20 crates of plantain to the depot',
      'Comment on the plantain bunches before harvest',
      'Add a comment to the task',
    ]) {
      expect(detectReplyLocale(text)).toBe('en')
    }
  })

  it('still detects French that uses those same words', () => {
    expect(detectReplyLocale('Combien coûte la banane plantain')).toBe('fr')
    expect(detectReplyLocale('Comment ça va')).toBe('fr')
    expect(detectReplyLocale('Comment faire pour payer')).toBe('fr')
  })

  // The word lists are customer-enquiry vocabulary, so French operational prose
  // carrying no greeting or shopping term is read as English. Harmless for a
  // reply — the customer writes again — but not for storage, which is why
  // `detectAuthorLocale` below refuses to answer instead of defaulting.
  it('still reads unmarked French worker prose as English', () => {
    expect(detectReplyLocale('Trois poulets sont malades au Bloc A')).toBe('en')
  })
})

describe('detectAuthorLocale', () => {
  it('names the language when the text carries evidence of one', () => {
    expect(detectAuthorLocale('Bonjour, combien coûtent les oeufs ?')).toBe('fr')
    expect(detectAuthorLocale('Elo ni iye ẹyin?')).toBe('yo')
    expect(detectAuthorLocale('Wetin una dey sell?')).toBe('pcm')
  })

  // The gap the reply detector still has: no greeting, no shopping term, no
  // accents. Answering 'en' here is what wrote French into English columns.
  it('returns null rather than English for prose it cannot place', () => {
    expect(detectAuthorLocale('Trois poulets sont malades au Bloc A')).toBeNull()
    expect(detectAuthorLocale('Pompe cassee depuis ce matin')).toBeNull()
  })

  it('reads Pidgin that borrows English words, via its own grammar', () => {
    expect(detectAuthorLocale('Three fowl don die for pen B')).toBe('pcm')
    expect(detectAuthorLocale('Di borehole pump dey leak since morning')).toBe('pcm')
    expect(detectAuthorLocale('Water don finish for di tank')).toBe('pcm')
  })

  it('recognizes ordinary English farm notes without calling anything', () => {
    for (const text of [
      'Delivers on Tuesdays, payment at 30 days',
      'Engine noisy, oil changed yesterday',
      'Stored behind the grain shed',
      'Bags soaked by rain, set aside',
      'Counted in the store behind the fence',
      'Two bags gnawed by rats',
      'Walk the block and note any damage',
      'Check the drip line',
      'Three crates damaged in transit',
      'Harvest the plantain in Block A',
    ]) {
      expect(detectAuthorLocale(text), text).toBe('en')
    }
  })

  // A single English-looking word is not evidence: `on`, `an` and `or` are all
  // ordinary French, so scoring one of them as English would send French prose
  // into the database labelled 'en' and settled.
  it('is not fooled by French words that look English', () => {
    expect(detectAuthorLocale('On a livre 30 sacs hier')).toBeNull()
    expect(detectAuthorLocale('Il y a 30 ans')).toBeNull()
  })

  it('declines on text too short to carry evidence', () => {
    expect(detectAuthorLocale('ok')).toBeNull()
    expect(detectAuthorLocale('')).toBeNull()
  })

  /**
   * The property that matters. Being unsure is safe — the caller asks a model.
   * Naming the wrong language is not: 'en' on foreign text stores it untranslated
   * and marked done, and the retry job only ever sweeps 'pending'.
   */
  it('never names a language other than the real one', () => {
    const corpus: Array<[ReplyLocale, string]> = [
      ['en', 'Fresh morning harvest, ripe bananas'],
      ['en', 'Spray Zone C'],
      ['en', '3 birds died'],
      ['en', 'Feed store is empty, reorder today'],
      ['fr', 'La pompe du forage fuit depuis ce matin'],
      ['fr', 'Recolte fraiche du matin, bananes mures'],
      ['fr', 'Trois caisses endommagees pendant le transport'],
      ['yo', 'Omi ti tan ninu tanki'],
      ['pcm', 'Dem no gree carry di bag comot'],
      ['pcm', 'Di generator no dey work again'],
    ]

    for (const [actual, text] of corpus) {
      const detected = detectAuthorLocale(text)
      expect(detected === null || detected === actual, `${text} -> ${detected}`).toBe(true)
    }
  })
})

describe('normalizeLocaleHint', () => {
  it('accepts known locale codes', () => {
    expect(normalizeLocaleHint('fr')).toBe('fr')
    expect(normalizeLocaleHint('PCM')).toBe('pcm')
    expect(normalizeLocaleHint('pidgin')).toBe('pcm')
    expect(normalizeLocaleHint('de')).toBeNull()
  })
})

describe('localized fallbacks', () => {
  it('returns French payment FAQ copy', () => {
    expect(customerPaymentReply('fr')).toMatch(/Paystack|livraison/i)
  })

  it('returns French web Copilot offline message', () => {
    expect(webCopilotLlmOffMessage('fr')).toMatch(/clé IA/i)
  })
})
