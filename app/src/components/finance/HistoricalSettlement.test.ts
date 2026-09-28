import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import en from '@/i18n/locales/en'
import HistoricalSettlement from './HistoricalSettlement.vue'
const { api } = vi.hoisted(() => ({ api: vi.fn() }))
vi.mock('@/lib/api', () => ({ api }))
const invoice = { id: 'test-1', description: 'Old pump', amount: 100, amountPaid: 40, currency: 'NGN', approvalStatus: 'approved' }
function render(invoices = [invoice], disabled = false) { return mount(HistoricalSettlement, { props: { invoices, disabled }, global: { plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })] } }) }
beforeEach(() => { api.mockReset(); api.mockResolvedValue({ settled: 1 }) })
describe('historical settlement confirmation', () => {
  it('requires explicit confirmation and records no fabricated payment date or reference', async () => {
    const wrapper = render(); await wrapper.get('button').trigger('click')
    expect(wrapper.text()).toContain('60.00'); expect(wrapper.text()).toContain('Old pump')
    expect(wrapper.text()).toContain('cannot be undone here')
    expect(wrapper.findAll('button')[0]!.attributes('disabled')).toBeDefined()
    expect(api).not.toHaveBeenCalled()
    await wrapper.get('input[type="checkbox"]').setValue(true)
    await wrapper.findAll('button')[0]!.trigger('click'); await flushPromises()
    const body = JSON.parse(api.mock.calls[0]![1].body)
    expect(body).toMatchObject({ confirmed: true, invoices: [{ id: 'test-1', amount: 100, amountPaid: 40, currency: 'NGN' }] })
    expect(body.invoices[0]).not.toHaveProperty('paidOn'); expect(body.invoices[0]).not.toHaveProperty('reference')
    expect(wrapper.emitted('saved')).toHaveLength(1)
  })
  it('retains identical retry keys and review after a network failure', async () => {
    const wrapper = render(); await wrapper.get('button').trigger('click'); await wrapper.get('input').setValue(true)
    api.mockRejectedValueOnce(new Error('Disconnected'))
    await wrapper.findAll('button')[0]!.trigger('click'); await flushPromises()
    expect(wrapper.text()).toContain('Disconnected')
    await wrapper.findAll('button')[0]!.trigger('click'); await flushPromises()
    expect(api.mock.calls[1]![1].body).toBe(api.mock.calls[0]![1].body)
  })
  it('cancels without writing and rejects ineligible or disabled inputs', async () => {
    const wrapper = render(); await wrapper.get('button').trigger('click'); await wrapper.findAll('button')[1]!.trigger('click')
    expect(wrapper.find('input').exists()).toBe(false); expect(api).not.toHaveBeenCalled()
    for (const invoices of [[], [{ ...invoice, approvalStatus: 'pending' }], [{ ...invoice, amountPaid: 100 }]]) {
      expect(render(invoices).get('button').attributes('disabled')).toBeDefined()
    }
    expect(render([invoice], true).get('button').attributes('disabled')).toBeDefined()
  })
  it('shows separate currency totals and closes only the confirmed snapshot', async () => {
    const wrapper = render([invoice, { ...invoice, id: 'test-2', currency: 'USD' }]); await wrapper.get('button').trigger('click')
    expect(wrapper.findAll('li')).toHaveLength(2); expect(wrapper.text()).toContain('$60.00')
    await wrapper.get('input').setValue(true); await wrapper.findAll('button')[0]!.trigger('click'); await flushPromises()
    const rows = JSON.parse(api.mock.calls[0]![1].body).invoices
    expect(rows).toHaveLength(2); expect(rows[0].requestId).not.toBe(rows[1].requestId)
  })
})
