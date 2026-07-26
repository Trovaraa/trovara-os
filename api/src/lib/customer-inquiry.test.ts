import { describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgresql://test:test@127.0.0.1:5432/test'
})

// With no LLM configured, answerCustomerInquiry returns the deterministic
// keyword answer, which is the product matcher under test here.
vi.mock('./llm.js', () => ({
  isLlmConfigured: () => false,
  completeChat: vi.fn(),
}))

import {
  answerCustomerInquiry,
  canonicalizeForSuggestion,
  DEFAULT_SUGGESTIONS,
  normalizeQuestion,
} from './customer-inquiry.js'
import type { CatalogItem } from './customer-cart.js'

describe('normalizeQuestion', () => {
  it('lowercases, strips punctuation, and collapses whitespace', () => {
    expect(normalizeQuestion('  How much is plantain?? ')).toBe('how much is plantain')
  })
})

describe('canonicalizeForSuggestion', () => {
  it('maps typo-ridden customer phrasing to curated labels', () => {
    expect(canonicalizeForSuggestion('were r u located??')).toBe('Where are you located?')
    expect(canonicalizeForSuggestion('how much doe plantain cost')).toBe('How much is plantain?')
    expect(canonicalizeForSuggestion('wat u sell')).toBe('What do you sell?')
    expect(canonicalizeForSuggestion('do u deliver to abuja')).toBe('How does delivery work?')
    expect(canonicalizeForSuggestion('can i pay by transfer')).toBe('How do I pay?')
    expect(canonicalizeForSuggestion('how much are eggs')).toBe('What are your prices?')
  })

  it('returns DEFAULT_SUGGESTIONS labels for punct/case variants', () => {
    for (const label of DEFAULT_SUGGESTIONS) {
      expect(canonicalizeForSuggestion(label.toLowerCase())).toBe(label)
    }
  })

  it('falls back to trimmed original when topic is unknown', () => {
    expect(canonicalizeForSuggestion('  do you grow cacao?  ')).toBe('do you grow cacao?')
  })
})

describe('deterministic product matching', () => {
  const catalog: CatalogItem[] = [
    { id: 'p1', name: 'Noix de Coco', unit: 'kg', priceKobo: 250000, currency: 'NGN' },
    { id: 'p2', name: 'Plantain', unit: 'bunch', priceKobo: 180000, currency: 'NGN' },
  ]

  const ask = async (question: string) =>
    (await answerCustomerInquiry({
      farmName: 'Trovara Farm',
      farmLocation: 'Ogun',
      catalog,
      question,
    })).reply

  it('matches a product across accents, case and punctuation', async () => {
    for (const question of [
      'how much is noix de coco?',
      'How much is NOIX DE COCO',
      'combien coûte la noix de côco ?',
    ]) {
      expect(await ask(question)).toContain('Noix de Coco')
    }
  })

  it('quotes the stored spelling back, not the folded form', async () => {
    const reply = await ask('price of noix de coco')
    expect(reply).toContain('Noix de Coco')
    expect(reply).not.toContain('noix de coco -')
  })

  it('does not match an unrelated question', async () => {
    const reply = await ask('where are you located')
    expect(reply).not.toContain('Noix de Coco')
    expect(reply).not.toContain('Plantain')
  })

  // Folding a punctuation-only name yields '', and every string contains '',
  // so without a guard this product would answer every question asked.
  it('ignores a catalog entry whose name folds to nothing', async () => {
    const reply = (
      await answerCustomerInquiry({
        farmName: 'Trovara Farm',
        farmLocation: 'Ogun',
        catalog: [{ id: 'p3', name: '---', unit: 'kg', priceKobo: 100, currency: 'NGN' }],
        question: 'where are you located',
      })
    ).reply
    expect(reply).not.toContain('---')
  })
})
