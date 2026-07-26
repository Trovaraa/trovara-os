import { describe, expect, it } from 'vitest'
import { defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import en from '@/i18n/locales/en'
import { useAgronomySkipText, type AgronomySkipReason } from './useAgronomySkipText'

/**
 * A trimmed fr catalog keeps these tests independent of the real fr/yo/pcm
 * files; anything missing here falls back to en, same as the app.
 */
const agronomyFr = {
  skipBudget: "Le copilote a fini son travail pour aujourd'hui.",
}

/** Mounts a throwaway component so useI18n() resolves against a real i18n instance. */
function setup() {
  const i18n = createI18n({
    legacy: false,
    locale: 'en',
    fallbackLocale: 'en',
    messages: {
      en: { agronomy: en.agronomy },
      fr: { agronomy: agronomyFr },
    },
  })
  let text!: ReturnType<typeof useAgronomySkipText>
  const Host = defineComponent({
    setup() {
      text = useAgronomySkipText()
      return () => h('div')
    },
  })
  mount(Host, { global: { plugins: [i18n] } })
  return { i18n, text }
}

/** Restated rather than imported: the mapping itself is what these tests check. */
const EXPECTED: Record<AgronomySkipReason, keyof typeof en.agronomy> = {
  species_unsupported: 'skipSpecies',
  llm_unavailable: 'skipUnavailable',
  budget_exhausted: 'skipBudget',
  llm_failed: 'skipFailed',
  invalid_payload: 'skipFailed',
  write_failed: 'skipFailed',
}

describe('useAgronomySkipText', () => {
  for (const reason of Object.keys(EXPECTED) as AgronomySkipReason[]) {
    it(`explains ${reason} in words`, () => {
      const { text } = setup()
      expect(text.agronomySkipText(reason)).toBe(en.agronomy[EXPECTED[reason]])
    })
  }

  it('says nothing when there is no reason to explain', () => {
    const { text } = setup()
    expect(text.agronomySkipText(null)).toBe('')
  })

  it('says nothing for a reason code this build does not know', () => {
    const { text } = setup()
    expect(text.agronomySkipText('quota_review' as AgronomySkipReason)).toBe('')
  })

  it('re-renders in the new locale after a language switch', () => {
    const { i18n, text } = setup()
    expect(text.agronomySkipText('budget_exhausted')).toBe(en.agronomy.skipBudget)

    i18n.global.locale.value = 'fr'
    expect(text.agronomySkipText('budget_exhausted')).toBe(agronomyFr.skipBudget)
    // fr has no skipSpecies here, so that batch still gets the en sentence.
    expect(text.agronomySkipText('species_unsupported')).toBe(en.agronomy.skipSpecies)
  })
})
