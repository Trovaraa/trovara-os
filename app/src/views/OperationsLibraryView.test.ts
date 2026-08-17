import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.fn()

vi.mock('@/lib/api', () => ({
  api: (...args: unknown[]) => api(...args),
  resolveApiUrl: (path: string) => path,
}))
vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({
    user: { id: '11111111-1111-4111-8111-111111111111', name: 'Consultant One' },
    hasPermission: (key: string) => ['knowledge.read', 'knowledge.write', 'knowledge.approve'].includes(key),
  }),
}))
vi.mock('@/components/AppLayout.vue', () => ({ default: { template: '<div><slot /></div>' } }))
vi.mock('@/components/CollapsibleSection.vue', () => ({ default: { template: '<section><slot /></section>' } }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key, locale: { value: 'en' } }) }))

async function mountView() {
  const OperationsLibraryView = (await import('./OperationsLibraryView.vue')).default
  const wrapper = mount(OperationsLibraryView)
  await flushPromises()
  return wrapper
}

describe('Operations Library document review', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.mockImplementation(async (path: string, options?: RequestInit) => {
      if (path === '/api/operation-guidelines' && !options) return { guidelines: [] }
      if (path === '/api/operation-guidelines/owners') return { owners: [{ id: '11111111-1111-4111-8111-111111111111', name: 'Consultant One' }, { id: '22222222-2222-4222-8222-222222222222', name: 'Farm Manager' }] }
      if (path === '/api/operation-guidelines/evaluations/cases') return { cases: [] }
      if (path === '/api/operation-guidelines/evaluations/runs') return { runs: [] }
      if (path === '/api/operation-guidelines/imports/preview') {
        expect(options?.body).toBeInstanceOf(FormData)
        return { document: { id: 'document-1', filename: 'Poultry SOP.docx', sizeBytes: 2100, status: 'needs_review', scanStatus: 'clean', ocrStatus: 'not_needed', extractedText: 'Disinfect boots before entering the poultry house.', warnings: ['Check the table on page 2.'] } }
      }
      if (path === '/api/operation-guidelines/imports/document-1/create-draft') return { guideline: { id: 'guide-1' } }
      if (path === '/api/operation-guidelines/brief') {
        expect(options?.method).toBe('POST')
        const body = JSON.parse(String(options?.body))
        expect(body.body).toContain('Disinfect boots')
        expect(body.locale).toBe('en')
        return { brief: 'This SOP covers poultry house entry.\n- Disinfect boots before entering.' }
      }
      throw new Error(`Unexpected request: ${path}`)
    })
  })

  it('previews extracted text and saves the corrected version as a draft', async () => {
    const wrapper = await mountView()
    const file = new File(['PK fake docx'], 'Poultry SOP.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    })
    const fileInput = wrapper.get('input[type="file"]')
    Object.defineProperty(fileInput.element, 'files', { value: [file], configurable: true })
    await fileInput.trigger('change')
    await flushPromises()

    expect(wrapper.text()).toContain('operationsLibrary.reviewExtraction')
    expect(wrapper.text()).toContain('Check the table on page 2.')
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toContain('Disinfect boots')

    const inputs = wrapper.findAll('input:not([type="file"]):not([type="date"])')
    await inputs[1]!.setValue('Poultry biosecurity')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    const draftCall = api.mock.calls.find(([path]) => path === '/api/operation-guidelines/imports/document-1/create-draft')
    expect(draftCall?.[1]).toMatchObject({ method: 'POST' })
    expect(JSON.parse(String(draftCall?.[1]?.body))).toMatchObject({
      category: 'Poultry biosecurity',
      ownerId: '11111111-1111-4111-8111-111111111111',
      audience: 'all',
    })
  })

  it('asks Farm AI for a brief of the extracted document', async () => {
    const wrapper = await mountView()
    const file = new File(['PK fake docx'], 'Poultry SOP.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    })
    const fileInput = wrapper.get('input[type="file"]')
    Object.defineProperty(fileInput.element, 'files', { value: [file], configurable: true })
    await fileInput.trigger('change')
    await flushPromises()

    const briefButton = wrapper.findAll('button').find((button) => button.text() === 'operationsLibrary.briefThis')
    expect(briefButton).toBeTruthy()
    await briefButton!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('This SOP covers poultry house entry.')
    expect(wrapper.text()).toContain('operationsLibrary.briefHelp')
  })
})
