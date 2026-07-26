import { describe, expect, it } from 'vitest'
import { defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import en from '@/i18n/locales/en'
import fr from '@/i18n/locales/fr'
import yo from '@/i18n/locales/yo'
import pcm from '@/i18n/locales/pcm'
import { resolveInsightLabel } from './AdvisoryView.vue'

/** The English labels `/advisory/analysis` puts on the wire as the fallback. */
const SERVER_LABELS: Record<string, string> = {
  weather: 'Weather risks',
  inputs: 'Input suggestions',
  vaccination: 'Vaccination windows',
  harvest: 'Harvest prep',
}

type AppLocale = 'en' | 'fr' | 'yo' | 'pcm'

/** Mounts a throwaway component so `t` / `te` come from a real i18n instance. */
function setup(locale: AppLocale) {
  const i18n = createI18n({
    legacy: false,
    locale,
    fallbackLocale: 'en',
    messages: { en, fr, yo, pcm },
  })

  let text!: { t: (key: string) => string; te: (key: string, locale?: string) => boolean }
  const Host = defineComponent({
    setup() {
      const { t, te } = i18n.global
      text = {
        t: (key: string) => t(key),
        te: (key: string, target?: string) =>
          target ? te(key, target as AppLocale) : te(key),
      }
      return () => h('div')
    },
  })
  mount(Host, { global: { plugins: [i18n] } })
  return text
}

function labels(locale: AppLocale) {
  const i18n = setup(locale)
  return Object.fromEntries(
    Object.entries(SERVER_LABELS).map(([key, label]) => [
      key,
      resolveInsightLabel(key, label, i18n),
    ]),
  )
}

describe('resolveInsightLabel', () => {
  it('resolves the four category names from the English catalog', () => {
    expect(labels('en')).toEqual(SERVER_LABELS)
  })

  it('resolves them in French', () => {
    expect(labels('fr')).toEqual({
      weather: 'Risques météo',
      inputs: 'Suggestions d’intrants',
      vaccination: 'Fenêtres de vaccination',
      harvest: 'Préparation récolte',
    })
  })

  it('resolves them in Yoruba', () => {
    expect(labels('yo')).toEqual({
      weather: 'Ewu ojú ọjọ́',
      inputs: 'Ìmọ̀ràn ohun èlò',
      vaccination: 'Àkókò àjẹsára',
      harvest: 'Ìmúrasílẹ̀ ìkórè',
    })
  })

  it('resolves them in Pidgin', () => {
    expect(labels('pcm')).toEqual({
      weather: 'Weather wahala',
      inputs: 'Input wey we advise',
      vaccination: 'Vaccination time',
      harvest: 'Get ready for harvest',
    })
  })

  it('never renders an English string in a non-English catalog', () => {
    for (const locale of ['fr', 'yo', 'pcm'] as const) {
      const resolved = labels(locale)
      for (const [key, english] of Object.entries(SERVER_LABELS)) {
        expect(resolved[key]).not.toBe(english)
        expect(resolved[key]).not.toBe('')
      }
    }
  })

  it("falls back to the server's English label for a key it does not know", () => {
    const i18n = setup('fr')
    expect(resolveInsightLabel('soil_health', 'Soil health', i18n)).toBe('Soil health')
    expect(resolveInsightLabel('soil_health', 'Soil health', i18n)).not.toContain(
      'insightCategories',
    )
  })

  it('renders the server label rather than nothing when the fallback is all there is', () => {
    const i18n = setup('yo')
    expect(resolveInsightLabel('irrigation', 'Irrigation plan', i18n)).toBe('Irrigation plan')
  })

  it('keeps the four keys the server sends addressable in every language', () => {
    for (const locale of ['en', 'fr', 'yo', 'pcm'] as const) {
      const i18n = setup(locale)
      for (const key of Object.keys(SERVER_LABELS)) {
        expect(i18n.te(`advisory.insightCategories.${key}`)).toBe(true)
      }
    }
  })
})
