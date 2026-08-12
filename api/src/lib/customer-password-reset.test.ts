import { getTableName } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let tokenClaimed = false
let passwordUpdates = 0

vi.mock('../db/index.js', () => {
  const tx = {
    update: (table: unknown) => ({
      set: () => ({
        where: () => ({
          returning: async () => {
            if (getTableName(table as never) === 'customer_password_reset_tokens') {
              if (tokenClaimed) return []
              tokenClaimed = true
              return [{ accountId: 'account-1' }]
            }
            passwordUpdates += 1
            return [{ farmId: 'farm-1' }]
          },
        }),
      }),
    }),
  }
  return {
    db: {
      transaction: vi.fn((callback: (transaction: typeof tx) => unknown) => callback(tx)),
    },
  }
})

describe('customer password reset token consumption', () => {
  beforeEach(() => {
    tokenClaimed = false
    passwordUpdates = 0
  })

  it('updates the password only for the single winning token claim', async () => {
    const { resetCustomerPasswordWithToken } = await import('./customer-accounts.js')
    const results = await Promise.all([
      resetCustomerPasswordWithToken('reset-token', 'hash-a'),
      resetCustomerPasswordWithToken('reset-token', 'hash-b'),
    ])

    expect(results.filter(Boolean)).toHaveLength(1)
    expect(results.filter((result) => result === null)).toHaveLength(1)
    expect(passwordUpdates).toBe(1)
  })
})
