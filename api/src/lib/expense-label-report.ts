export type ExpenseAmount = {
  id: string
  amount: number
}

export type ExpenseLabelAllocation = {
  expenseId: string
  labelId: string
  labelName: string
  labelSlug: string
}

export type ExpensesByLabel = Record<string, { name: string; slug: string; total: number }>

export function filterAndGroupExpensesByLabel<T extends ExpenseAmount>(
  expenses: T[],
  labelAllocations: ExpenseLabelAllocation[],
  labelId?: string,
): { expenses: T[]; expensesByLabel: ExpensesByLabel } {
  const matchingExpenseIds = labelId
    ? new Set(
        labelAllocations
          .filter((allocation) => allocation.labelId === labelId)
          .map((allocation) => allocation.expenseId),
      )
    : null
  const filteredExpenses = matchingExpenseIds
    ? expenses.filter((expense) => matchingExpenseIds.has(expense.id))
    : expenses
  const filteredExpenseAmounts = new Map(
    filteredExpenses.map((expense) => [expense.id, expense.amount]),
  )

  const expensesByLabel = labelAllocations.reduce<ExpensesByLabel>((grouped, allocation) => {
    const amount = filteredExpenseAmounts.get(allocation.expenseId)
    if (amount === undefined) return grouped

    const current = grouped[allocation.labelId]
    grouped[allocation.labelId] = {
      name: allocation.labelName,
      slug: allocation.labelSlug,
      total: (current?.total ?? 0) + amount,
    }
    return grouped
  }, {})

  return { expenses: filteredExpenses, expensesByLabel }
}
