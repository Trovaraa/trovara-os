import { DOMWrapper, flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from 'vue-i18n'
import en from '@/i18n/locales/en'
import FinanceView from './FinanceView.vue'

const { api, access } = vi.hoisted(() => ({ api: vi.fn(), access: { write: true } }))
vi.mock('@/lib/api', () => ({ api, resolveApiUrl: (value: string) => value }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ user: { role: 'owner' }, hasPermission: () => access.write }) }))
vi.mock('@/components/AppLayout.vue', () => ({ default: { template: '<main id="workspace"><slot /></main>' } }))

const base = { id: 'expense-1', description: 'Synthetic irrigation invoice', amount: 1000, amountPaid: 0, currency: 'NGN', entityCode: '002', costCentreCode: 'CC03', category: 'equipment', expenseDate: '2026-09-21T12:00:00Z', approvalStatus: 'approved', paymentStatus: 'unpaid', paymentDueDate: '2026-09-28', labels: [] }
let invoices = [{ ...base }]
let payments: { id: string; amount: number; currency: string; paidOn: string; reference: string }[] = []
const wrappers: ReturnType<typeof mount>[] = []
const button = (scope: Pick<DOMWrapper<Element>, 'findAll'>, text: string) => scope.findAll('button').find(item => item.text() === text)!
const dialog = () => new DOMWrapper(document.querySelector('[role="dialog"]')!)
const writes = () => api.mock.calls.filter(([, options]) => options?.method)
beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>'
  access.write = true; invoices = [{ ...base }]; payments = []; api.mockReset()
  vi.stubGlobal('confirm', vi.fn(() => true))
  api.mockImplementation(async (path: string, options?: { method?: string; body?: string }) => {
    if (options?.method) {
      const payload = JSON.parse(options.body ?? '{}')
      if (path === '/api/finance/historical-settlements') {
        for (const selected of payload.invoices) {
          const row = invoices.find(r => r.id === selected.id)!
          row.amountPaid = row.amount; row.paymentStatus = 'paid'
        }
        return { settled: payload.invoices.length }
      }
      const row = invoices.find(item => path === `/api/finance/${item.id}` || path === `/api/finance/${item.id}/payments`)!
      if (path.endsWith('/payments')) {
        payments.push({ ...payload, id: 'synthetic-payment' })
        row.amountPaid += payload.amount
        row.paymentStatus = row.amountPaid === row.amount ? 'paid' : 'partially_paid'
      } else { Object.assign(row, payload); if (row.approvalStatus === 'approved' && !row.paymentDueDate) row.paymentDueDate = '2026-09-28' }
      return { expense: { ...row } }
    }
    if (path.endsWith('/payments')) return { payments: [...payments] }
    if (path.startsWith('/api/finance/summary')) return { summary: null }
    if (path === '/api/finance/entities') return { entities: [{ code: '002', name: 'Trovara', relationship: 'child' }] }
    if (path === '/api/finance/cost-centres') return { costCentres: [{ code: 'CC03', name: 'Infrastructure', covers: 'Roads' }] }
    if (path === '/api/finance/labels') return { labels: [] }
    return { expenses: invoices.map(row => ({ ...row })) }
  })
})
afterEach(() => { wrappers.forEach(wrapper => wrapper.unmount()); wrappers.length = 0; document.body.innerHTML = ''; vi.restoreAllMocks() })
async function render() {
  const wrapper = mount(FinanceView, { attachTo: '#app', global: { plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })] } })
  wrappers.push(wrapper); await flushPromises()
  await wrapper.get('#finance-expenses-tab').trigger('click')
  return wrapper
}
async function open(wrapper: ReturnType<typeof mount>, action = 'Edit') {
  const trigger = button(wrapper.get('[data-testid="expense-cards"]'), action)
  ;(trigger.element as HTMLElement).focus()
  await trigger.trigger('click'); await flushPromises()
  return trigger
}

describe('expense drawer workflow', () => {
  it('bulk selects only eligible invoices on this page and refreshes after confirmed settlement', async () => {
    invoices = Array.from({ length: 30 }, (_, i) => ({ ...base, id: `expense-${i}`, description: `Old invoice ${i}` }))
    invoices[0]!.approvalStatus = 'pending'; invoices[1]!.amountPaid = 1000; invoices[1]!.paymentStatus = 'paid'
    const wrapper = await render()
    await wrapper.get('#finance-expenses-panel > div input[type="checkbox"]').setValue(true)
    expect(wrapper.text()).toContain('23 selected')
    await button(wrapper, 'Mark as already paid').trigger('click'); await flushPromises()
    expect(dialog().text()).toContain('Confirm 23 invoice(s)')
    expect(dialog().findAll('li')).toHaveLength(23)
    expect(writes()).toHaveLength(0)
    await dialog().get('input[type="checkbox"]').setValue(true)
    await button(dialog(), 'Confirm fully paid').trigger('click'); await flushPromises()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(invoices[0]!.paymentStatus).toBe('unpaid'); expect(invoices[25]!.paymentStatus).toBe('unpaid')
    expect(invoices[2]!.paymentStatus).toBe('paid'); expect(wrapper.text()).toContain('Selected invoices marked as paid.')
    expect(writes()).toHaveLength(1)
  })
  it('clears bulk selection when page or filters change and hides selection from readers', async () => {
    invoices = Array.from({ length: 30 }, (_, i) => ({ ...base, id: `expense-${i}` }))
    const wrapper = await render()
    await wrapper.get('#finance-expenses-panel > div input[type="checkbox"]').setValue(true)
    await button(wrapper, 'Next').trigger('click'); expect(wrapper.text()).toContain('0 selected')
    await wrapper.get('#finance-expenses-panel > div input[type="checkbox"]').setValue(true)
    await wrapper.get('#finance-entity-filter').setValue('002'); await flushPromises()
    expect(wrapper.text()).toContain('0 selected')
    access.write = false
    const reader = await render()
    expect(reader.find('#finance-expenses-panel input[type="checkbox"]').exists()).toBe(false)
  })
  it('retains the selected expense when a save removes it from the active filter', async () => {
    const originalApi = api.getMockImplementation()!
    api.mockImplementation(async (path: string, options?: { method?: string; body?: string }) => {
      if (path === '/api/finance?entityCode=002') return { expenses: invoices.filter(row => row.entityCode === '002').map(row => ({ ...row })) }
      if (path === '/api/finance/entities') return { entities: [{ code: '001', name: 'Parent', relationship: 'parent' }, { code: '002', name: 'Trovara', relationship: 'child' }] }
      return originalApi(path, options)
    })
    const wrapper = await render()
    await wrapper.get('#finance-entity-filter').setValue('002'); await flushPromises()
    await open(wrapper)
    await dialog().findAll('select')[0]!.setValue('001')
    await button(dialog(), 'Save').trigger('click'); await flushPromises()
    expect(dialog().text()).toContain('Synthetic irrigation invoice')
    expect(dialog().text()).toContain('Outstanding balance')
    expect(wrapper.get('#finance-entity-filter').element).toHaveProperty('value', '002')
    await button(dialog(), 'Close').trigger('click'); await flushPromises()
    expect(wrapper.find('[data-testid="expense-cards"] article').exists()).toBe(false)
  })
  it('opens at page 2 without writes or scrolling and returns to the same expense after saving', async () => {
    invoices = Array.from({ length: 30 }, (_, index) => ({ ...base, id: `expense-${index + 1}`, description: `Synthetic invoice ${index + 1}` }))
    const wrapper = await render()
    await button(wrapper, 'Next').trigger('click')
    const workspace = wrapper.get('#workspace').element as HTMLElement
    workspace.scrollTop = 720
    const trigger = await open(wrapper)
    expect(writes()).toHaveLength(0)
    expect(workspace.scrollTop).toBe(720)
    expect(dialog().text()).toContain('Approval status: Approved')
    expect(dialog().text()).toContain('Payment status: Unpaid')
    expect(dialog().text()).toContain('Outstanding balance')
    const description = dialog().findAll('input').find(item => (item.element as HTMLInputElement).value === 'Synthetic invoice 26')!
    await description.setValue('Updated synthetic invoice 26')
    expect(dialog().text()).toContain('Save expense changes before')
    expect(button(dialog(), 'Record payment')).toBeUndefined()
    await button(dialog(), 'Save').trigger('click'); await flushPromises()
    expect(dialog().text()).toContain('Record payment')
    expect(wrapper.text()).toContain('Page 2 of 2')
    await button(dialog(), 'Close').trigger('click'); await flushPromises()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(trigger.element)
    expect(workspace.scrollTop).toBe(720)
    expect(wrapper.text()).toContain('Updated synthetic invoice 26')
  })

  it('supports approval, default due date, partial and full payments in the same drawer', async () => {
    invoices[0] = { ...base, approvalStatus: 'pending', paymentDueDate: '' }
    const wrapper = await render(); await open(wrapper)
    expect(dialog().text()).toContain('Approve this invoice before recording payments')
    expect(button(dialog(), 'Record payment')).toBeUndefined()
    const approval = dialog().findAll('select').find(select => select.find('option[value="approved"]').exists())!
    await approval.setValue('approved')
    await button(dialog(), 'Save').trigger('click'); await flushPromises()
    expect(dialog().text()).toContain('2026-09-28')
    for (const [amount, expected] of [[400, 'Partially paid'], [600, 'Paid']] as const) {
      const panel = dialog().get('[data-testid="expense-payments-panel"]')
      await panel.get('input[type="number"]').setValue(amount)
      await panel.get('input[maxlength="200"]').setValue(`Synthetic transfer ${amount}`)
      await panel.findAll('form')[1]!.trigger('submit'); await flushPromises()
      expect(dialog().text()).toContain(`Payment status: ${expected}`)
      expect(dialog().text()).toContain(`Synthetic transfer ${amount}`)
    }
    expect(button(dialog(), 'Record payment')).toBeUndefined()
    expect(dialog().get('fieldset input[type="number"]').attributes('disabled')).toBeDefined()
    expect(writes().filter(([path]) => path.endsWith('/payments'))).toHaveLength(2)
  })

  it('keeps failed saves visible and unsaved changes intact', async () => {
    const wrapper = await render(); await open(wrapper)
    await dialog().get('fieldset input[type="number"]').setValue(1500)
    api.mockRejectedValueOnce(new Error('Synthetic save failure'))
    await button(dialog(), 'Save').trigger('click'); await flushPromises()
    expect(dialog().text()).toContain('Synthetic save failure')
    expect((dialog().get('fieldset input[type="number"]').element as HTMLInputElement).value).toBe('1500')
    vi.mocked(window.confirm).mockReturnValue(false)
    await button(dialog(), 'Close').trigger('click')
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  })

  it('lets readers inspect details and history but not mutate an expense', async () => {
    access.write = false
    const wrapper = await render(); await open(wrapper, 'Payments')
    expect(dialog().find('fieldset[disabled]').exists()).toBe(true)
    expect(dialog().text()).toContain('Payment history')
    expect(button(dialog(), 'Save')).toBeUndefined()
    expect(dialog().find('form').exists()).toBe(false)
    await button(dialog(), 'Close').trigger('click')
    expect(writes()).toHaveLength(0)
  })
})
