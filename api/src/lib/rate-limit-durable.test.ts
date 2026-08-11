import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  returning: vi.fn(),
  values: vi.fn(),
  onConflictDoUpdate: vi.fn(),
}))

vi.mock('../db/index.js', () => ({
  db: {
    insert: vi.fn(() => ({ values: mocks.values })),
    delete: vi.fn(),
  },
}))

mocks.values.mockReturnValue({ onConflictDoUpdate: mocks.onConflictDoUpdate })
mocks.onConflictDoUpdate.mockReturnValue({ returning: mocks.returning })

const { checkDurableRateLimit } = await import('./rate-limit.js')

describe('PostgreSQL rate-limit adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.values.mockReturnValue({ onConflictDoUpdate: mocks.onConflictDoUpdate })
    mocks.onConflictDoUpdate.mockReturnValue({ returning: mocks.returning })
  })

  it('allows requests through the configured maximum', async () => {
    mocks.returning.mockResolvedValue([
      { attemptCount: 3, expiresAt: new Date(Date.now() + 60_000) },
    ])

    await expect(checkDurableRateLimit('public:test', 3, 60_000)).resolves.toEqual({
      allowed: true,
      retryAfterSec: 0,
    })
  })

  it('returns a durable bucket retry time after the maximum', async () => {
    mocks.returning.mockResolvedValue([
      { attemptCount: 4, expiresAt: new Date(Date.now() + 30_000) },
    ])

    const result = await checkDurableRateLimit('public:test', 3, 60_000)

    expect(result.allowed).toBe(false)
    expect(result.retryAfterSec).toBeGreaterThanOrEqual(29)
    expect(result.retryAfterSec).toBeLessThanOrEqual(30)
  })
})
