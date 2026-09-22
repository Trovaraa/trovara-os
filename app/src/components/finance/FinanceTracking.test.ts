import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import en from '@/i18n/locales/en'
import ExpensePaymentsPanel from './ExpensePaymentsPanel.vue'
import CapexPanel from './CapexPanel.vue'
const { api } = vi.hoisted(() => ({ api: vi.fn() }))
vi.mock('@/lib/api', () => ({ api }))
const global = () => ({ plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })] })
const expense = { id: 'invoice-1', description: 'Tractor', amount: 100, currency: 'NGN', amountPaid: 40, paymentStatus: 'partially_paid', approvalStatus: 'approved', paymentDueDate: '2027-01-01' }
beforeEach(() => { api.mockReset(); api.mockResolvedValue({ payments: [] }) })
describe('payment controls', () => {
  it('does not report a failed history request as an empty history and offers retry', async () => {
    api.mockRejectedValueOnce(new Error('History unavailable'))
    const wrapper = mount(ExpensePaymentsPanel, { props: { expense, canWrite: false }, global: global() })
    await flushPromises()
    expect(wrapper.text()).toContain('History unavailable')
    expect(wrapper.text()).not.toContain('No payments recorded.')
    await wrapper.get('button').trigger('click'); await flushPromises()
    expect(wrapper.text()).toContain('No payments recorded.')
  })
  it('requires a changed due date to be saved and follows the refreshed server value', async () => {
    const wrapper = mount(ExpensePaymentsPanel, { props: { expense, canWrite: true }, global: global() })
    await flushPromises()
    await wrapper.findAll('input[type="date"]')[0]!.setValue('2027-02-01')
    expect(wrapper.findAll('form')[1]!.get('button').attributes('disabled')).toBeDefined()
    await wrapper.findAll('form')[1]!.trigger('submit')
    expect(api.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0)
    await wrapper.setProps({ expense: { ...expense, paymentDueDate: '2027-02-03' } })
    expect((wrapper.findAll('input[type="date"]')[0]!.element as HTMLInputElement).value).toBe('2027-02-03')
    expect(wrapper.findAll('form')[1]!.get('button').attributes('disabled')).toBeUndefined()
  })
  it('shows balance and sends payment with a stable retry identifier', async () => {
    const wrapper = mount(ExpensePaymentsPanel, { props: { expense, canWrite: true }, global: global() })
    await flushPromises()
    expect(wrapper.text()).toContain('Partially paid'); expect(wrapper.text()).toContain('60.00')
    await wrapper.get('input[type="number"]').setValue('30')
    await wrapper.get('input[maxlength="200"]').setValue('Transfer 123')
    api.mockRejectedValueOnce(new Error('Connection interrupted'))
    await wrapper.findAll('form')[1]!.trigger('submit'); await flushPromises()
    const first = JSON.parse(api.mock.calls.at(-1)![1].body)
    await wrapper.findAll('form')[1]!.trigger('submit'); await flushPromises()
    const posts = api.mock.calls.filter(call => call[1]?.method === 'POST')
    expect(JSON.parse(posts[1]![1].body)).toEqual(first)
    expect(first).toMatchObject({ amount: 30, reference: 'Transfer 123' })
    expect(wrapper.emitted('saved')).toHaveLength(1)
  })
  it('disables recording until the due date is reviewed', async () => {
    const wrapper = mount(ExpensePaymentsPanel, { props: { expense: { ...expense, paymentDueDate: null }, canWrite: true }, global: global() })
    await flushPromises()
    expect(wrapper.text()).toContain('Due date needs review')
    expect(wrapper.findAll('form')[1]!.get('button').attributes('disabled')).toBeDefined()
    await wrapper.findAll('input[type="date"]')[0]!.setValue('2027-01-01')
    await wrapper.findAll('form')[0]!.trigger('submit'); await flushPromises()
    expect(api).toHaveBeenCalledWith('/api/finance/invoice-1', { method: 'PATCH', body: JSON.stringify({ paymentDueDate: '2027-01-01' }) })
  })
  it('shows no payment form for pending invoices or read-only users', async () => {
    const pending = mount(ExpensePaymentsPanel, { props: { expense: { ...expense, approvalStatus: 'pending' }, canWrite: true }, global: global() })
    expect(pending.find('input[type="number"]').exists()).toBe(false)
    expect(pending.text()).toContain('Approve this invoice')
    const readonly = mount(ExpensePaymentsPanel, { props: { expense, canWrite: false }, global: global() })
    expect(readonly.find('form').exists()).toBe(false)
    await flushPromises()
  })
})
describe('CAPEX view', () => {
  it('shows assets and CAPEX expenses separately and converts minor-unit asset costs', async () => {
    api.mockResolvedValue({ assets: [{ id: 'a', name: 'Tractor', assetTag: 'T1', quantityOwned: 1, acquisitionCostMinor: 1234500, currency: 'NGN', operationalStatus: 'operational', active: true }],
      expenses: [{ id: 'e', description: 'New irrigation system', amount: 1200, currency: 'NGN', entityCode: '002', approvalStatus: 'approved', paymentStatus: 'unpaid' }] })
    const wrapper = mount(CapexPanel, { global: global() }); await flushPromises()
    expect(wrapper.text()).toContain('Tractor'); expect(wrapper.text()).toContain('12,345.00')
    expect(wrapper.text()).toContain('New irrigation system'); expect(wrapper.text()).toContain('Unpaid')
    await wrapper.get('input[type="search"]').setValue('irrigation')
    expect(wrapper.text()).not.toContain('Tractor'); expect(wrapper.text()).toContain('New irrigation system')
    expect(api).toHaveBeenCalledTimes(1)
  })
})
