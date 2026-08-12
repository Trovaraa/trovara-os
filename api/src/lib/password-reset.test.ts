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
            if (getTableName(table as never) === 'password_reset_tokens') {
              if (tokenClaimed) return []
              tokenClaimed = true
              return [{ userId: 'user-1' }]
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

describe('staff password reset token consumption', () => {
  beforeEach(() => {
    tokenClaimed = false
    passwordUpdates = 0
  })

  it('updates the password only for the single winning token claim', async () => {
    const { resetStaffPasswordWithToken } = await import('./password-reset.js')
    const results = await Promise.all([
      resetStaffPasswordWithToken({ tokenHash: 'token-hash', passwordHash: 'hash-a' }),
      resetStaffPasswordWithToken({ tokenHash: 'token-hash', passwordHash: 'hash-b' }),
    ])

    expect(results.filter(Boolean)).toHaveLength(1)
    expect(results.filter((result) => result === null)).toHaveLength(1)
    expect(passwordUpdates).toBe(1)
  })
})
