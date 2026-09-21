/** Expense amounts use whole currency units, matching the existing finance ledger. */
export function paymentStatus(amount: number, paid: number): 'unpaid' | 'partially_paid' | 'paid' {
  return paid === 0 ? 'unpaid' : paid < amount ? 'partially_paid' : 'paid'
}

export function validateExpensePayment(expense: {
  approvalStatus: string; amount: number; amountPaid: number; paymentDueDate: string | null
}, amount: number): string | null {
  if (expense.approvalStatus !== 'approved') return 'Only approved invoices can have payments recorded.'
  if (!expense.paymentDueDate) return 'Set a payment due date before recording payment.'
  if (!Number.isSafeInteger(amount) || amount <= 0) return 'Enter a positive whole-currency amount.'
  if (amount > expense.amount - expense.amountPaid) return 'Payment exceeds the outstanding balance.'
  return null
}
