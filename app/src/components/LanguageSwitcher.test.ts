import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const locale = ref('en')
const applyLocale = vi.fn((code: string) => {
  locale.value = code
})
const savePreferredLocale = vi.fn(async () => undefined)

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ locale }),
}))

vi.mock('@/stores/auth', () => ({
  applyLocale: (code: string) => applyLocale(code),
  useAuthStore: () => ({ savePreferredLocale }),
}))

async function mountSwitcher() {
  const LanguageSwitcher = (await import('./LanguageSwitcher.vue')).default
  return mount(LanguageSwitcher, { global: { mocks: { $t: (key: string) => key } } })
}

describe('LanguageSwitcher', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    locale.value = 'en'
  })

  it('applies the locale and mirrors it to the profile', async () => {
    const wrapper = await mountSwitcher()
    await wrapper.findAll('button')[3]?.trigger('click')

    expect(applyLocale).toHaveBeenCalledWith('fr')
    expect(savePreferredLocale).toHaveBeenCalledWith('fr')
    expect(locale.value).toBe('fr')
  })

  it('offers exactly the four supported languages', async () => {
    const wrapper = await mountSwitcher()
    expect(wrapper.findAll('button').map((b) => b.text())).toEqual(['EN', 'YO', 'PCM', 'FR'])
  })

  it('skips the write when the active language is re-selected', async () => {
    const wrapper = await mountSwitcher()
    await wrapper.findAll('button')[0]?.trigger('click')

    expect(applyLocale).not.toHaveBeenCalled()
    expect(savePreferredLocale).not.toHaveBeenCalled()
  })

  it('switches the UI even when the profile write fails', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    savePreferredLocale.mockRejectedValueOnce(new Error('offline'))

    const wrapper = await mountSwitcher()
    expect(() => wrapper.findAll('button')[1]?.trigger('click')).not.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(locale.value).toBe('yo')
    expect(unhandled).not.toHaveBeenCalled()
    process.off('unhandledRejection', unhandled)
  })
})
