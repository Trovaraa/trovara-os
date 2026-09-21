import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from 'vue-i18n'
import en from '@/i18n/locales/en'
import CareersView from './CareersView.vue'
import JournalView from './JournalView.vue'
import BrandKitsView from './BrandKitsView.vue'
import OperationsLibraryView from './OperationsLibraryView.vue'

const { api } = vi.hoisted(() => ({ api: vi.fn() }))
vi.mock('@/lib/api', () => ({ api, resolveApiUrl: (url: string) => url, resolveMediaUrl: (url: string) => url }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ user: { id: 'synthetic-owner', role: 'owner' }, hasPermission: () => true }) }))
vi.mock('@/components/AppLayout.vue', () => ({ default: { template: '<main><slot /></main>' } }))

const post = { id: 'synthetic-post', title: 'Synthetic farm post', slug: 'synthetic-post', published: false, tags: [], bodyMarkdown: 'Synthetic text', summary: 'Summary', excerpt: 'Excerpt', employmentType: 'full_time', applyEmail: 'hello@example.com', category: 'Farm Stories', authorName: 'Fixture', updatedAt: '2026-09-21T12:00:00Z' }
const guideline = { id: 'synthetic-guide', title: 'Synthetic farm guideline', body: 'Synthetic instructions for this UI test only.', category: 'Test', audience: 'all', status: 'draft', version: 1, reviewDueAt: null, ownerId: 'synthetic-owner', updatedAt: post.updatedAt, activeVersionId: null, sourceDocument: null }
const pack = { id: 'synthetic-pack', title: 'Synthetic media pack', notes: '', shareUrl: 'https://example.com/pack', passwordRequired: false, expiresAt: null, revokedAt: null, viewCount: 0, downloadCount: 0, assetIds: [], createdAt: post.updatedAt }

afterEach(() => { vi.restoreAllMocks(); api.mockReset() })

describe('consistent contextual editing', () => {
  it.each([
    { name: 'Careers', component: CareersView, trigger: 'Synthetic farm post', title: 'Synthetic farm post' },
    { name: 'Journal', component: JournalView, trigger: 'Synthetic farm post', title: 'Edit post' },
    { name: 'Brand Kits', component: BrandKitsView, trigger: 'Edit', title: 'Edit pack' },
    { name: 'Operations Library', component: OperationsLibraryView, trigger: 'Edit', title: 'Edit' },
  ])('$name opens an accessible editor in place and protects unsaved edits', async ({ component, trigger, title }) => {
    api.mockImplementation(async (path: string) => {
      if (path === '/api/brand/assets') return { assets: [] }
      if (path === '/api/brand/packs') return { packs: [pack] }
      if (path === '/api/operation-guidelines') return { guidelines: [guideline] }
      if (path.endsWith('/owners')) return { owners: [{ id: 'synthetic-owner', name: 'Fixture' }] }
      if (path.endsWith('/cases')) return { cases: [] }
      if (path.endsWith('/runs')) return { runs: [] }
      if (path === '/api/journal/synthetic-post') return { post }
      return { posts: [post] }
    })
    const confirm = vi.fn(() => false)
    vi.stubGlobal('confirm', confirm)
    const wrapper = mount(component, { global: {
      plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })],
      stubs: { teleport: true, CollapsibleSection: { template: '<section><slot /></section>' } },
    } })
    try {
      await flushPromises()
      expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
      const opener = wrapper.findAll('button').find(button => button.text().includes(trigger))!
      expect(opener).toBeDefined()
      await opener.trigger('click'); await flushPromises()
      const dialog = wrapper.get('[role="dialog"]')
      expect(dialog.attributes('aria-modal')).toBe('true')
      expect(dialog.get('h2').text()).toBe(title)
      await dialog.get('input:not([type="file"])').setValue('Unsaved synthetic edit')
      await dialog.get('header button').trigger('click')
      expect(confirm).toHaveBeenCalled()
      expect(wrapper.find('[role="dialog"]').exists()).toBe(true)
      confirm.mockReturnValue(true)
      await dialog.get('header button').trigger('click')
      expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
      expect(api.mock.calls.filter(([, options]) => options?.method)).toHaveLength(0)
    } finally { wrapper.unmount() }
  })
})
