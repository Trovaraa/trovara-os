import { describe, expect, it } from 'vitest'
import en from './en'
import fr from './fr'
import pcm from './pcm'
import yo from './yo'
import { withLocaleFallback } from '../locale-parity'

function keys(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object') return [prefix]
  return Object.entries(value)
    .flatMap(([key, child]) => keys(child, prefix ? `${prefix}.${key}` : key))
    .sort()
}

describe('locale key parity', () => {
  it.each([
    ['French', fr],
    ['Nigerian Pidgin', pcm],
    ['Yoruba', yo],
  ])('%s mirrors English keys', (_name, locale) => {
    expect(keys(withLocaleFallback(en, locale))).toEqual(keys(en))
  })
})
