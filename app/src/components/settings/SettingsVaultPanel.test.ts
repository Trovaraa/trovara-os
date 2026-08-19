import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.fn()

vi.mock('@/lib/api', () => ({
  api: (...args: unknown[]) => api(...args),
}))

vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({
    isOwner: true,
    hasPermission: () => true,
  }),
}))

vi.mock('@/components/CollapsibleSection.vue', () => ({
  default: {
    props: ['title', 'description', 'defaultOpen', 'testId'],
    template: '<section :data-testid="testId"><slot name="meta" /><slot /></section>',
  },
}))

const entry = {
  id: 'vault-1',
  label: 'Instagram',
  category: 'provider_portal',
  loginUrl: 'https://instagram.com',
  loginEmail: 'farm@example.com',
  notes: null,
  hasPassword: true,
  canManage: true,
  canReveal: true,
  sharedWithMe: false,
  sharedUserIds: [] as string[],
}

async function mountPanel() {
  const SettingsVaultPanel = (await import('./SettingsVaultPanel.vue')).default
  const wrapper = mount(SettingsVaultPanel)
  await flushPromises()
  return wrapper
}

describe('SettingsVaultPanel unlock strip', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.mockImplementation(async (path: string, options?: RequestInit) => {
      if (path === '/api/vault' && !options) {
        return { canManage: true, entries: [entry] }
      }
      if (path === '/api/vault/share-candidates') return { users: [] }
      if (path === '/api/vault/vault-1/reveal') {
        expect(options?.method).toBe('POST')
        expect(JSON.parse(String(options?.body))).toMatchObject({ totpToken: '123456' })
        return { password: 'secret-pass' }
      }
      if (path === '/api/vault' && options?.method === 'POST') {
        return { id: 'vault-2' }
      }
      throw new Error(`Unexpected request: ${path}`)
    })
  })

  it('keeps TOTP hidden until Reveal and only unlocks the chosen card', async () => {
    const wrapper = await mountPanel()
    expect(wrapper.find('[data-testid="vault-unlock-strip"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Unlock Instagram')

    await wrapper.findAll('button').find((button) => button.text() === 'Reveal')!.trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="vault-unlock-strip"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('Unlock Instagram')
    expect(wrapper.find('input[aria-label="Break-glass password"]').exists()).toBe(false)

    await wrapper.get('input[aria-label="TOTP for reveal or edit"]').setValue('123456')
    await wrapper.findAll('button').find((button) => button.text() === 'Confirm')!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('secret-pass')
    expect(wrapper.find('[data-testid="vault-unlock-strip"]').exists()).toBe(false)
  })

  it('puts Add vault key above the list and no longer shows a bottom Add entry block', async () => {
    const wrapper = await mountPanel()
    expect(wrapper.text()).not.toContain('Add entry')
    expect(wrapper.find('[data-testid="vault-add-form"]').exists()).toBe(false)

    await wrapper.get('[data-testid="vault-add-key-mobile"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="vault-add-form"]').exists()).toBe(true)
    const formHtml = wrapper.get('[data-testid="vault-add-form"]').html()
    const listIndex = wrapper.html().indexOf('Instagram')
    const formIndex = wrapper.html().indexOf('New vault key')
    expect(formIndex).toBeGreaterThan(-1)
    expect(formIndex).toBeLessThan(listIndex)
    expect(formHtml).toContain('Save to vault')
  })
})
