import { describe, expect, it, vi, beforeEach } from 'vitest'

const selectLimit = vi.fn()
const selectFrom = vi.fn(() => ({
  where: vi.fn(() => ({
    limit: selectLimit,
  })),
}))
const select = vi.fn(() => ({ from: selectFrom }))

vi.mock('../db/index.js', () => ({
  db: { select },
}))

vi.mock('../db/schema.js', () => ({
  sessions: { userId: 'userId', ipHash: 'ipHash' },
  users: {},
}))

describe('isUnusualLoginIp', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns false for first login (no prior sessions)', async () => {
    selectLimit.mockResolvedValueOnce([])
    const { isUnusualLoginIp } = await import('./session.js')
    await expect(isUnusualLoginIp('user-1', 'hash-a')).resolves.toBe(false)
  })

  it('returns false when prior session used the same IP hash', async () => {
    selectLimit.mockResolvedValueOnce([{ ipHash: 'hash-a' }, { ipHash: 'hash-b' }])
    const { isUnusualLoginIp } = await import('./session.js')
    await expect(isUnusualLoginIp('user-1', 'hash-a')).resolves.toBe(false)
  })

  it('returns true when prior sessions exist but none match', async () => {
    selectLimit.mockResolvedValueOnce([{ ipHash: 'hash-b' }])
    const { isUnusualLoginIp } = await import('./session.js')
    await expect(isUnusualLoginIp('user-1', 'hash-a')).resolves.toBe(true)
  })

  it('returns false when ipHash is missing', async () => {
    const { isUnusualLoginIp } = await import('./session.js')
    await expect(isUnusualLoginIp('user-1', undefined)).resolves.toBe(false)
    expect(select).not.toHaveBeenCalled()
  })
})
