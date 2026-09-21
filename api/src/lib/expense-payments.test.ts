import { describe, expect, it } from 'vitest'
import { paymentStatus, validateExpensePayment } from './expense-payments.js'
describe('expense payment rules', () => {
  it('distinguishes unpaid, partial, paid and zero-value invoices', () => {
    expect(paymentStatus(100, 0)).toBe('unpaid'); expect(paymentStatus(100, 40)).toBe('partially_paid')
    expect(paymentStatus(100, 100)).toBe('paid'); expect(paymentStatus(0, 0)).toBe('unpaid')
  })
  it('requires reviewed due dates and approval before accepting payment', () => {
    const row = { approvalStatus: 'approved', amount: 100, amountPaid: 20, paymentDueDate: '2026-09-28' }
    expect(validateExpensePayment(row, 80)).toBeNull()
    expect(validateExpensePayment(row, 81)).toContain('exceeds')
    expect(validateExpensePayment({ ...row, paymentDueDate: null }, 20)).toContain('due date')
    expect(validateExpensePayment({ ...row, approvalStatus: 'pending' }, 20)).toContain('approved')
  })
})
