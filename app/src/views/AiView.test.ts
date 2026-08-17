import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.fn()

vi.mock('@/lib/api', () => ({ api: (...args: unknown[]) => api(...args) }))
vi.mock('@/components/AppLayout.vue', () => ({ default: { template: '<main><slot /></main>' } }))
vi.mock('@/components/ChatMarkdown.vue', () => ({
  default: { props: ['text'], template: '<div data-testid="markdown">{{ text }}</div>' },
}))
vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key, locale: { value: 'en' } }),
}))

const storedMessage = {
  id: 'message-1',
  role: 'assistant' as const,
  content: 'The approved count is 120 kg.',
  attachmentUrl: null,
  metadata: null,
  feedbackRating: null,
  feedbackNote: null,
  feedbackAt: null,
}

async function mountView() {
  const AiView = (await import('./AiView.vue')).default
  const wrapper = mount(AiView)
  await flushPromises()
  return wrapper
}

describe('Farm Copilot answer feedback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    HTMLElement.prototype.scrollTo = vi.fn()
    api.mockImplementation(async (path: string, options?: RequestInit) => {
      if (path === '/api/ai/status') return { configured: true }
      if (path === '/api/ai/conversations') {
        return {
          conversations: [
            {
              id: 'conversation-1',
              title: 'Stock count',
              archivedAt: null,
              createdAt: '2026-08-15T10:00:00.000Z',
              updatedAt: '2026-08-15T10:00:00.000Z',
            },
          ],
        }
      }
      if (path === '/api/ai/conversations/conversation-1') {
        return { conversation: { id: 'conversation-1' }, messages: [storedMessage] }
      }
      if (path === '/api/ai/messages/message-1/feedback' && options?.method === 'PATCH') {
        const body = JSON.parse(String(options.body)) as { rating: 'up' | 'down' | null; note: string | null }
        return {
          message: {
            ...storedMessage,
            feedbackRating: body.rating,
            feedbackNote: body.note,
            feedbackAt: '2026-08-15T10:10:00.000Z',
          },
        }
      }
      throw new Error(`Unexpected request: ${path}`)
    })
  })

  it('shows touch-sized rating controls and persists a helpful rating', async () => {
    const wrapper = await mountView()
    const helpful = wrapper.get('[data-testid="ai-feedback-up"]')

    expect(helpful.attributes('aria-label')).toBe('ai.helpfulYes')
    expect(helpful.classes()).toContain('min-h-10')
    await helpful.trigger('click')
    await flushPromises()

    const call = api.mock.calls.find(([path]) => path === '/api/ai/messages/message-1/feedback')
    expect(call?.[1]).toMatchObject({ method: 'PATCH' })
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ rating: 'up', note: null })
    expect(wrapper.text()).toContain('ai.feedbackSaved')
  })

  it('opens an optional correction form for an unhelpful answer', async () => {
    const wrapper = await mountView()
    await wrapper.get('[data-testid="ai-feedback-down"]').trigger('click')

    const correction = wrapper.get('textarea[id="feedback-message-1"]')
    expect(correction).toBeTruthy()
    expect(wrapper.text()).toContain('ai.feedbackReasonLabel')
    await correction.setValue('Use kilograms and include the stock count date.')
    await correction.element.closest('form')?.dispatchEvent(new Event('submit'))
    await flushPromises()

    const call = [...api.mock.calls].reverse().find(
      ([path]) => path === '/api/ai/messages/message-1/feedback',
    )
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      rating: 'down',
      note: 'Use kilograms and include the stock count date.',
    })
    expect(wrapper.text()).toContain('ai.feedbackCorrectionSaved')
  })
})
