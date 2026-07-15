import { describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgresql://test:test@127.0.0.1:5432/test'
})

import {
  canonicalizeForSuggestion,
  DEFAULT_SUGGESTIONS,
  normalizeQuestion,
} from './customer-inquiry.js'

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
