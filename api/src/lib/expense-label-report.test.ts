import { describe, expect, it } from 'vitest'
import { filterAndGroupExpensesByLabel } from './expense-label-report.js'

const expenses = [
  { id: 'expense-1', amount: 100, category: 'inputs' },
  { id: 'expense-2', amount: 60, category: 'transport' },
]

const allocations = [
  {
    expenseId: 'expense-1',
    labelId: 'label-capex',
    labelName: 'Capex',
    labelSlug: 'capex',
  },
  {
    expenseId: 'expense-1',
    labelId: 'label-recurring',
    labelName: 'Recurring',
    labelSlug: 'recurring',
  },
  {
    expenseId: 'expense-2',
    labelId: 'label-recurring',
    labelName: 'Recurring',
    labelSlug: 'recurring',
  },
]

describe('filterAndGroupExpensesByLabel', () => {
  it('groups all expenses by every linked label without double-counting within a label', () => {
    const result = filterAndGroupExpensesByLabel(expenses, allocations)

    expect(result.expenses).toEqual(expenses)
    expect(result.expensesByLabel).toEqual({
      'label-capex': { name: 'Capex', slug: 'capex', total: 100 },
      'label-recurring': { name: 'Recurring', slug: 'recurring', total: 160 },
    })
  })

  it('filters expenses first and groups every label attached to the matching expenses', () => {
    const result = filterAndGroupExpensesByLabel(expenses, allocations, 'label-capex')

    expect(result.expenses).toEqual([expenses[0]])
    expect(result.expensesByLabel).toEqual({
      'label-capex': { name: 'Capex', slug: 'capex', total: 100 },
      'label-recurring': { name: 'Recurring', slug: 'recurring', total: 100 },
    })
  })

  it('returns an empty breakdown when no expense has the selected label', () => {
    expect(filterAndGroupExpensesByLabel(expenses, allocations, 'label-missing')).toEqual({
      expenses: [],
      expensesByLabel: {},
    })
  })
})
