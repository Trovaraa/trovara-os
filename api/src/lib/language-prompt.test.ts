import { describe, expect, it } from 'vitest'
import { LANGUAGE_PROMPT_INTERVAL_MS, shouldPromptLanguage } from './language-prompt.js'

const NOW = new Date('2026-07-25T12:00:00Z')
const ago = (ms: number) => new Date(NOW.getTime() - ms)

describe('shouldPromptLanguage', () => {
  it('asks a worker who has never been asked', () => {
    expect(shouldPromptLanguage({}, NOW)).toBe(true)
    expect(
      shouldPromptLanguage({ preferredLocaleSetAt: null, preferredLocalePromptedAt: null }, NOW),
    ).toBe(true)
  })

  it('never asks again once they have answered', () => {
    expect(
      shouldPromptLanguage(
        { preferredLocaleSetAt: ago(5 * LANGUAGE_PROMPT_INTERVAL_MS) },
        NOW,
      ),
    ).toBe(false)
  })

  // Answered wins over never-prompted: a worker who set their language in the
  // web UI has stated it just as clearly as one who tapped a Butler button.
  it('does not ask an answered worker who was never prompted on Butler', () => {
    expect(
      shouldPromptLanguage(
        { preferredLocaleSetAt: ago(60_000), preferredLocalePromptedAt: null },
        NOW,
      ),
    ).toBe(false)
  })

  it('stays quiet for a day after asking', () => {
    expect(shouldPromptLanguage({ preferredLocalePromptedAt: ago(60_000) }, NOW)).toBe(false)
    expect(
      shouldPromptLanguage(
        { preferredLocalePromptedAt: ago(LANGUAGE_PROMPT_INTERVAL_MS - 1000) },
        NOW,
      ),
    ).toBe(false)
  })

  it('asks again once the day has passed', () => {
    expect(
      shouldPromptLanguage({ preferredLocalePromptedAt: ago(LANGUAGE_PROMPT_INTERVAL_MS) }, NOW),
    ).toBe(true)
    expect(
      shouldPromptLanguage(
        { preferredLocalePromptedAt: ago(3 * LANGUAGE_PROMPT_INTERVAL_MS) },
        NOW,
      ),
    ).toBe(true)
  })
})
