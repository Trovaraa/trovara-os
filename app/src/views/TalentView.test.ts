import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
const api = vi.fn()
let permissions = ['talent.read', 'talent.manage', 'talent.admin', 'careers.manage']
vi.mock('@/lib/api', () => ({ api: (...args: unknown[]) => api(...args), resolveApiUrl: (path: string) => path }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ hasPermission: (key: string) => permissions.includes(key) }) }))
import TalentView from './TalentView.vue'

const application = { id: 'app-1', candidateId: 'candidate-1', roleLabel: 'Farm Supervisor', stage: 'new', source: 'cv_upload', needsReview: true,
  careerPostId: 'job-1', assignedToId: null, nextAction: null, dueAt: '2020-01-01T12:00:00Z', receivedAt: '2026-09-13T12:00:00Z', retentionUntil: '2027-03-12T12:00:00Z', acknowledgedAt: null }
const candidate = { id: 'candidate-1', name: 'CV import — review required', email: null, phone: null, location: null }
const metadata = { jobs: [{ id: 'job-1', title: 'Farm Supervisor', published: true }], reviewers: [{ id: 'user-1', name: 'Reviewer' }],
  stages: ['new', 'reviewing', 'shortlisted'], zoho: { configured: false, automaticIntake: false, sendingEnabled: false, folderCount: 0 }, sync: [] }
const detail = { application, candidate, otherApplications: [{ id: 'app-1', roleLabel: 'Farm Supervisor', stage: 'new' }],
  documents: [{ id: 'doc-1', filename: 'CV.docx', kind: 'cv', extractionStatus: 'ready', extractedText: 'Ada Example\nSkills\nNursery management',
    extractedFields: { name: 'Ada Example', email: 'ada@example.com', skills: 'Nursery management' }, warnings: ['Review these suggestions against the original CV.'] }],
  events: [{ id: 'event-1', kind: 'email', body: '<img src=x onerror=alert(1)>', occurredAt: '2026-09-13T12:00:00Z' }] }
const render = () => mount(TalentView, { global: { stubs: { AppLayout: { template: '<div><slot /></div>' }, RouterLink: { template: '<a><slot /></a>' } } } })
beforeEach(() => {
  permissions = ['talent.read', 'talent.manage', 'talent.admin', 'careers.manage']; api.mockReset()
  api.mockImplementation(async (path: string, options?: RequestInit) => {
    if (options?.method) return { ok: true, id: 'app-1', duplicate: false }
    if (path === '/api/talent/metadata') return metadata
    if (path === '/api/talent/app-1') return detail
    return { applications: [{ application, candidate }], hasMore: false }
  })
})

describe('Talent workspace', () => {
  it('shows Zoho hello intake, needs-review and overdue indicators', async () => {
    const wrapper = render(); await flushPromises()
    expect(wrapper.text()).toContain('Zoho · hello@trovara.farm')
    expect(wrapper.text()).toContain('Needs review'); expect(wrapper.text()).toContain('Follow-up overdue')
    expect(wrapper.findAll('button').find(button => button.text() === 'Sync Zoho page')?.attributes('disabled')).toBeDefined()
  })
  it('shows an actionable empty state', async () => {
    api.mockImplementation(async (path: string) => path.endsWith('/metadata') ? metadata : { applications: [], hasMore: false })
    const wrapper = render(); await flushPromises()
    expect(wrapper.text()).toContain('No applications here yet')
  })
  it('keeps untrusted email content escaped and exposes source evidence', async () => {
    const wrapper = render(); await flushPromises(); await wrapper.find('button.application').trigger('click'); await flushPromises()
    expect(wrapper.text()).toContain('<img src=x onerror=alert(1)>'); expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.text()).toContain('Nursery management'); expect(wrapper.find('a[href="/api/talent/app-1/documents/doc-1"]').exists()).toBe(true)
  })
  it('copies suggestions into an unsaved form and keeps human review required', async () => {
    const wrapper = render(); await flushPromises(); await wrapper.find('button.application').trigger('click'); await flushPromises()
    const use = wrapper.findAll('button').find(button => button.text() === 'Use suggested contact details')!
    await use.trigger('click'); await flushPromises()
    expect((wrapper.find('input[type=email]').element as HTMLInputElement).value).toBe('ada@example.com')
    expect(api.mock.calls.filter(([, options]) => options?.method === 'PATCH')).toHaveLength(0)
    expect(wrapper.text()).toContain('Check them against the CV before saving')
  })
  it('does not offer mutations to readers', async () => {
    permissions = ['talent.read']; const wrapper = render(); await flushPromises()
    expect(wrapper.text()).not.toContain('Import applications'); expect(wrapper.text()).not.toContain('Manage roles')
    await wrapper.find('button.application').trigger('click'); await flushPromises()
    expect(wrapper.text()).not.toContain('Save application'); expect(wrapper.text()).not.toContain('Permanently delete application')
  })
  it('surfaces API failures without replacing them with an empty-success state', async () => {
    api.mockRejectedValue(new Error('Forbidden')); const wrapper = render(); await flushPromises()
    expect(wrapper.find('[role=alert]').text()).toBe('Forbidden')
  })
})
