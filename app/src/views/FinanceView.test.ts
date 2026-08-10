import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.fn()
const auth = {
  user: { id: 'owner-1', role: 'owner' },
}

vi.mock('@/lib/api', () => ({
  api: (...args: unknown[]) => api(...args),
}))

vi.mock('@/stores/auth', () => ({
  useAuthStore: () => auth,
}))

vi.mock('@/components/AppLayout.vue', () => ({
  default: { template: '<div><slot /></div>' },
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

const expense = {
  id: 'expense-1',
  category: 'transport',
  description: 'Fuel delivery',
  amount: 12500,
  currency: 'NGN',
  expenseDate: '2026-08-10T12:00:00.000Z',
  vendor: 'Ikeja Fuel Depot',
  approvalStatus: 'pending',
  source: 'inbound_email',
  labels: [{ id: 'label-1', name: 'Operations', slug: 'operations' }],
  hasAttachment: true,
  extractionMethod: 'pdf_text',
  extractionStatus: 'failed',
}

const summary = {
  generatedAt: '2026-08-10T12:00:00.000Z',
  currency: 'NGN',
  revenue: 50000,
  deliveredRevenue: 40000,
  totalExpenses: 12500,
  netProfit: 37500,
  orderCount: 2,
  expenseCount: 1,
  expensesByCategory: {},
}

async function mountView() {
  const FinanceView = (await import('./FinanceView.vue')).default
  const wrapper = mount(FinanceView)
  await flushPromises()
  return wrapper
}

describe('FinanceView expense list', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.mockImplementation(async (path: string) => {
      if (path === '/api/finance') return { expenses: [expense] }
      if (path === '/api/finance/summary') return { summary }
      if (path === '/api/finance/labels') return { labels: expense.labels }
      if (path === '/api/finance/expense-1/retry-extraction') {
        return { expense: { ...expense, extractionStatus: 'success' } }
      }
      throw new Error(`Unexpected request: ${path}`)
    })
  })

  it('renders complete mobile cards and a scrollable desktop table', async () => {
    const wrapper = await mountView()
    const cards = wrapper.get('[data-testid="expense-cards"]')
    const table = wrapper.get('[data-testid="expense-table"]')

    expect(cards.text()).toContain('Fuel delivery')
    expect(cards.text()).toContain('Ikeja Fuel Depot')
    expect(cards.text()).toContain('Operations')
    expect(cards.text()).toContain('finance.status.pending')
    expect(cards.text()).toContain('finance.extractionStatus.failed')
    expect(cards.text()).toContain('finance.extractionMethod.pdf_text')
    expect(cards.text()).toContain('finance.retryExtraction')
    expect(cards.get('a').attributes('href')).toBe('/api/finance/expense-1/attachment')
    expect(cards.text()).toContain('finance.edit')

    expect(table.classes()).toContain('min-w-[78rem]')
    expect(table.text()).toContain('Fuel delivery')
    expect(table.text()).toContain('finance.status.pending')
  })

  it('opens the edit form from a mobile expense card', async () => {
    const wrapper = await mountView()
    const card = wrapper.get('[data-testid="expense-cards"]')
    const edit = card.findAll('button').find((button) => button.text() === 'finance.edit')!

    await edit.trigger('click')

    expect(wrapper.text()).toContain('finance.editExpense')
    expect(wrapper.get('input[type="number"]').element).toHaveProperty('value', '12500')
  })

  it('retries extraction for a pending inbound attachment', async () => {
    const wrapper = await mountView()
    const retry = wrapper
      .get('[data-testid="expense-cards"]')
      .findAll('button')
      .find((button) => button.text() === 'finance.retryExtraction')!

    await retry.trigger('click')
    await flushPromises()

    expect(api).toHaveBeenCalledWith('/api/finance/expense-1/retry-extraction', { method: 'POST' })
  })
})
