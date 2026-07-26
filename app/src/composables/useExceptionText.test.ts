import { describe, expect, it } from 'vitest'
import { defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import exceptionsEn from '@/i18n/locales/exceptions/en'
import { useExceptionText } from './useExceptionText'

/**
 * A trimmed fr catalog keeps these tests independent of the real fr/yo/pcm
 * files; anything missing here falls back to en, same as the app.
 */
const exceptionsFr = {
  msg: { overdueSince: 'En retard depuis {since}' },
  title: { order: 'Commande : {customer}' },
  action: { approve: 'Approuver : {title}' },
  unassigned: 'non attribué',
}

/** Mounts a throwaway component so useI18n() resolves against a real i18n instance. */
function setup() {
  const i18n = createI18n({
    legacy: false,
    locale: 'en',
    fallbackLocale: 'en',
    messages: {
      en: { exceptions: exceptionsEn },
      fr: { exceptions: exceptionsFr },
    },
  })
  let text!: ReturnType<typeof useExceptionText>
  const Host = defineComponent({
    setup() {
      text = useExceptionText()
      return () => h('div')
    },
  })
  mount(Host, { global: { plugins: [i18n] } })
  return { i18n, text }
}

describe('useExceptionText', () => {
  it('renders the translated string when a key is present', () => {
    const { text } = setup()
    const ex = {
      title: 'Broken English title',
      titleKey: 'exceptions.title.order',
      titleParams: { customer: 'Ada Farms' },
      message: 'Pending over 48h - NGN 12000',
      messageKey: 'exceptions.msg.orderPending',
      messageParams: { currency: 'NGN', amount: 12000 },
    }
    expect(text.exceptionTitle(ex)).toBe('Order: Ada Farms')
    expect(text.exceptionMessage(ex)).toBe('Pending over 48h - NGN 12000')
  })

  it('falls back to the plain field when no key is present', () => {
    const { text } = setup()
    const ex = {
      title: 'Heavy rain expected',
      message: 'Delay spraying until Thursday',
    }
    expect(text.exceptionTitle(ex)).toBe('Heavy rain expected')
    expect(text.exceptionMessage(ex)).toBe('Delay spraying until Thursday')
  })

  it('falls back when the key is not in the catalog', () => {
    const { text } = setup()
    expect(
      text.exceptionMessage({
        title: '',
        message: 'English fallback',
        messageKey: 'exceptions.msg.doesNotExist',
      }),
    ).toBe('English fallback')
  })

  it('formats ISO date params instead of interpolating the timestamp', () => {
    const { text } = setup()
    const out = text.exceptionMessage({
      title: 'Weed block 3',
      message: 'Overdue since 2026-07-21T22:26:15.620Z',
      messageKey: 'exceptions.msg.overdueSince',
      messageParams: { since: '2026-07-21T22:26:15.620Z' },
    })
    expect(out).not.toMatch(/\d{4}-\d{2}-\d{2}T/)
    expect(out).toMatch(/^Overdue since /)
    expect(out).toMatch(/Jul/)
  })

  it('formats the lastVerified date param too', () => {
    const { text } = setup()
    const out = text.exceptionMessage({
      title: 'Block A · Maize',
      message: 'stale',
      messageKey: 'exceptions.msg.censusStale',
      messageParams: { days: 30, lastVerified: '2026-06-02T08:00:00.000Z' },
    })
    expect(out).not.toMatch(/\d{4}-\d{2}-\d{2}T/)
    expect(out).toContain('older than 30 days')
  })

  it('translates a param whose value is itself an i18n key', () => {
    const { text } = setup()
    const out = text.exceptionMessage({
      title: 'Approve harvest log',
      message: 'Awaiting approval for over 12h (unassigned)',
      messageKey: 'exceptions.msg.awaitingApproval',
      messageParams: { assignee: 'exceptions.unassigned' },
    })
    expect(out).toBe('Awaiting approval for over 12h (unassigned)')
    expect(out).not.toContain('exceptions.unassigned')
  })

  it('resolves an action label with a nested titleKey', () => {
    const { text } = setup()
    expect(
      text.actionLabel({
        label: 'Review mortality: Layers B mortality',
        labelKey: 'exceptions.action.reviewMortality',
        labelParams: { title: 'Layers B mortality' },
        titleKey: 'exceptions.title.batchMortality',
        titleParams: { batch: 'Layers B' },
      }),
    ).toBe('Review mortality: Layers B mortality')
  })

  it('falls back to labelParams.title when the action has no titleKey', () => {
    const { text } = setup()
    expect(
      text.actionLabel({
        label: 'Restock: Urea 50kg',
        labelKey: 'exceptions.action.restock',
        labelParams: { title: 'Urea 50kg' },
      }),
    ).toBe('Restock: Urea 50kg')
  })

  it('falls back to the plain label when the action has no key', () => {
    const { text } = setup()
    expect(text.actionLabel({ label: 'Check the borehole pump' })).toBe('Check the borehole pump')
  })

  it('re-renders in the new locale after a language switch', () => {
    const { i18n, text } = setup()
    const ex = {
      title: 'Weed block 3',
      message: 'Overdue since 2026-07-21T22:26:15.620Z',
      messageKey: 'exceptions.msg.overdueSince',
      messageParams: { since: '2026-07-21T22:26:15.620Z' },
    }
    expect(text.exceptionMessage(ex)).toMatch(/^Overdue since /)

    i18n.global.locale.value = 'fr'
    const fr = text.exceptionMessage(ex)
    expect(fr).toMatch(/^En retard depuis /)
    expect(fr).not.toMatch(/\d{4}-\d{2}-\d{2}T/)

    expect(
      text.actionLabel({
        label: 'Approve: Order: Ada Farms',
        labelKey: 'exceptions.action.approve',
        labelParams: { title: 'Order: Ada Farms' },
        titleKey: 'exceptions.title.order',
        titleParams: { customer: 'Ada Farms' },
      }),
    ).toBe('Approuver : Commande : Ada Farms')
  })

  it('translates key-valued params into the active locale', () => {
    const { i18n, text } = setup()
    i18n.global.locale.value = 'fr'
    // fr has no awaitingApproval message, so the en template renders with the
    // fr param value.
    expect(
      text.exceptionMessage({
        title: 'Approve harvest log',
        message: 'Awaiting approval for over 12h (unassigned)',
        messageKey: 'exceptions.msg.awaitingApproval',
        messageParams: { assignee: 'exceptions.unassigned' },
      }),
    ).toContain('non attribué')
  })
})
