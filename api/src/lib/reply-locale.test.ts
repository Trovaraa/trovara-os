import { describe, expect, it } from 'vitest'
import {
  customerPaymentReply,
  detectReplyLocale,
  normalizeLocaleHint,
  webCopilotLlmOffMessage,
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
    expect(customerPaymentReply('fr')).toMatch(/livraison/i)
  })

  it('returns French web Copilot offline message', () => {
    expect(webCopilotLlmOffMessage('fr')).toMatch(/clé IA/i)
  })
})
