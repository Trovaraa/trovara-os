import { describe, expect, it } from 'vitest'
import en from './en'
import fr from './fr'
import yo from './yo'
import pcm from './pcm'

/** The message each reason the API can send is rendered through. */
const SKIP_KEYS = ['skipSpecies', 'skipUnavailable', 'skipBudget', 'skipFailed'] as const

const LOCALES = [
  ['en', en],
  ['fr', fr],
  ['yo', yo],
  ['pcm', pcm],
] as const

describe('agronomy skip messages', () => {
  for (const [name, messages] of LOCALES) {
    it(`explains a missing plan in ${name}`, () => {
      // A key missing from one language leaves that farm reading the key itself,
      // which is the reason code this whole layer exists to keep off the screen.
      expect(Object.keys(messages.agronomy).sort()).toEqual([...SKIP_KEYS].sort())
      for (const key of SKIP_KEYS) {
        expect(messages.agronomy[key], key).toMatch(/\S/)
      }
    })
  }
})
