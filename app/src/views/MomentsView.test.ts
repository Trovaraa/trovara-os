import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.fn()

vi.mock('@/lib/api', () => ({
  api: (...args: unknown[]) => api(...args),
  resolveMediaUrl: (url: string) => url,
}))

vi.mock('@/components/AccessibleDialog.vue', () => ({
  default: { template: '<div><slot /></div>' },
}))

vi.mock('@/components/AppLayout.vue', () => ({
  default: { template: '<div><slot /></div>' },
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    locale: { value: 'en' },
  }),
}))

const summary = { total: 3, pending: 1, approved: 2, rejected: 0 }

function moment(id: string, status: 'pending' | 'approved' | 'rejected') {
  return {
    id,
    status,
    mediaKind: 'image',
    mimeType: 'image/jpeg',
    byteSize: 1024,
    createdAt: '2026-08-10T12:00:00.000Z',
    mediaUrl: `/api/moments/${id}/media`,
  }
}

async function mountView() {
  const MomentsView = (await import('./MomentsView.vue')).default
  const wrapper = mount(MomentsView)
  await flushPromises()
  return wrapper
}

describe('MomentsView status filtering', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.mockImplementation(async (path: string) => {
      if (path.endsWith('approved')) {
        return { summary, moments: [moment('approved-1', 'approved'), moment('approved-2', 'approved')] }
      }
      if (path.endsWith('rejected')) return { summary, moments: [] }
      return { summary, moments: [moment('pending-1', 'pending')] }
    })
  })

  it('loads each selected status from the server and preserves summary counts', async () => {
    const wrapper = await mountView()
    expect(api).toHaveBeenCalledWith('/api/moments?status=pending')
    expect(wrapper.findAll('.summary-count').map((item) => item.text())).toEqual(['1', '2', '0'])

    const approved = wrapper.findAll('.summary-card').find((button) =>
      button.text().includes('moments.status.approved'),
    )!
    await approved.trigger('click')
    await flushPromises()

    expect(api).toHaveBeenCalledWith('/api/moments?status=approved')
    expect(wrapper.findAll('.moment-card')).toHaveLength(2)
    expect(wrapper.text()).not.toContain('moments.noMatches')

    const rejected = wrapper.findAll('.summary-card').find((button) =>
      button.text().includes('moments.status.rejected'),
    )!
    await rejected.trigger('click')
    await flushPromises()

    expect(api).toHaveBeenCalledWith('/api/moments?status=rejected')
    expect(wrapper.text()).toContain('moments.noMatches')
    expect(wrapper.text()).not.toContain('moments.empty')
  })
})
