import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.fn()

vi.mock('@/lib/api', () => ({
  api: (...args: unknown[]) => api(...args),
}))

vi.mock('@/lib/client-cleanup', () => ({
  clearSensitiveClientData: vi.fn(),
}))

vi.mock('@/router', () => ({
  default: { push: vi.fn() },
}))

const profile = {
  id: 'u1',
  email: 'staff@trovara.farm',
  name: 'Staff',
  role: 'field_worker' as const,
  farmId: 'f1',
}

async function freshStore() {
  setActivePinia(createPinia())
  const { useAuthStore } = await import('./auth')
  return useAuthStore()
}

describe('auth store language sync', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
  })

  it('hydrates the UI locale from the profile on session restore', async () => {
    localStorage.setItem('trovara-locale', 'fr')
    const i18n = (await import('@/i18n')).default
    i18n.global.locale.value = 'fr'

    api.mockResolvedValueOnce({ user: { ...profile, preferredLocale: 'yo' } })
    const auth = await freshStore()
    await auth.fetchMe()
    await nextTick()

    expect(i18n.global.locale.value).toBe('yo')
    expect(localStorage.getItem('trovara-locale')).toBe('yo')
    expect(document.documentElement.lang).toBe('yo')
  })

  it('lets the profile override a stale device locale on login', async () => {
    localStorage.setItem('trovara-locale', 'fr')
    const i18n = (await import('@/i18n')).default
    i18n.global.locale.value = 'fr'

    api.mockResolvedValueOnce({ user: { ...profile, preferredLocale: 'en' } })
    const auth = await freshStore()
    await auth.login('staff@trovara.farm', 'password123', { skipRedirect: true })
    await nextTick()

    expect(i18n.global.locale.value).toBe('en')
  })

  it('maps pcm to a valid html lang attribute', async () => {
    const i18n = (await import('@/i18n')).default
    api.mockResolvedValueOnce({ user: { ...profile, preferredLocale: 'pcm' } })
    const auth = await freshStore()
    await auth.fetchMe()
    await nextTick()

    expect(i18n.global.locale.value).toBe('pcm')
    expect(document.documentElement.lang).toBe('en')
  })

  it('keeps the device locale when the profile has none', async () => {
    localStorage.setItem('trovara-locale', 'fr')
    const i18n = (await import('@/i18n')).default
    i18n.global.locale.value = 'fr'

    api.mockResolvedValueOnce({ user: profile })
    const auth = await freshStore()
    await auth.fetchMe()
    await nextTick()

    expect(i18n.global.locale.value).toBe('fr')
  })

  it('savePreferredLocale patches the preferences endpoint', async () => {
    api.mockResolvedValueOnce({ user: { ...profile, preferredLocale: 'en' } })
    const auth = await freshStore()
    await auth.fetchMe()
    api.mockResolvedValueOnce({ ok: true, preferredLocale: 'fr' })

    await auth.savePreferredLocale('fr')

    expect(api).toHaveBeenLastCalledWith('/auth/preferences', {
      method: 'PATCH',
      body: JSON.stringify({ preferredLocale: 'fr' }),
    })
    expect(auth.user?.preferredLocale).toBe('fr')
  })

  it('does not call the API for a signed-out user', async () => {
    const auth = await freshStore()
    await expect(auth.savePreferredLocale('fr')).resolves.toBeUndefined()
    expect(api).not.toHaveBeenCalled()
  })

  it('swallows a failed write and keeps the optimistic locale', async () => {
    api.mockResolvedValueOnce({ user: { ...profile, preferredLocale: 'en' } })
    const auth = await freshStore()
    await auth.fetchMe()
    api.mockRejectedValueOnce(new Error('offline'))

    await expect(auth.savePreferredLocale('pcm')).resolves.toBeUndefined()
    expect(auth.user?.preferredLocale).toBe('pcm')
  })
})
